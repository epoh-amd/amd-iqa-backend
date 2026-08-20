const express = require('express');
const router = express.Router();
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const axios = require('axios'); // <-- for fetching backend data
const path = require('path');
const fs = require('fs');

// Strip the 6-char random prefix added by multer (e.g. "abc123_filename.pdf" → "filename.pdf")
const displayFilename = (absPath) => path.basename(absPath).replace(/^[a-z0-9]{6}_/i, '');
const { generatePieChartBase64, generateBarChartBase64, generateWeeklyChart, generateLocationAllocationChartBase64, generateLocationAllocationChartBase64NonStacked, generateBuildDeliveryChartBase64, generateFactoryChartBase64, generateBuildDeliveryChartBase641 } = require('../utils/generateCharts');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const apiUrl = process.env.API_URL || 'http://localhost:5000/api';

// Fetch notifier emails from waiver_config table
async function getNotifierEmails() {
  try {
    const { getGlobalPool } = require('../utils/database');
    const pool = getGlobalPool();
    const [rows] = await pool.promise().query(
      `SELECT config_value FROM waiver_config WHERE config_key = 'notifiers' LIMIT 1`
    );
    if (!rows.length) return [];
    const parsed = JSON.parse(rows[0].config_value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Nodemailer setup
const createTransporter = () => nodemailer.createTransport({
  host: 'atlmail10.amd.com',
  port: 25,
  secure: false,
  ignoreTLS: true,
  tls: {
    rejectUnauthorized: false
  }
});

const transporter = createTransporter();

const sendCombinedDashboardEmail = async (html, attachments, recipients) => {
  await transporter.sendMail({
    from: 'noreply@amd.com',
    to: recipients.join(','),
    cc: 'ErnQi.Poh@amd.com',
    subject: `Weekly Dashboard Report`,
    html,
    attachments,
  });

  console.log('Combined dashboard email sent successfully');
};



let dashboardCronRunning = false;

cron.schedule('30 8 * * 1', async () => {
  if (dashboardCronRunning) {
    console.log('Dashboard cron already running, skipping duplicate trigger.');
    return;
  }
  dashboardCronRunning = true;
  console.log('Running combined dashboard cron...');
  try {
    const recipients = process.env.EMAIL_RECIPIENTS
      .split(',')
      .map(email => email.trim());

    const { data: projects } = await axios.get(
      `${apiUrl}/dashboard/projects`
    );

    let emailHtml = ` <h1>Weekly Dashboard Report</h1>
  <p style="font-size:14px; color:gray;">
    Disclaimer: The data presented in this report is sourced from Platform Delivery and Quality Dashboard in the PDQD homepage.
  </p>`;
    const attachments = [];

    const year = new Date().getFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const excludedProjects = new Set([
      'Venice SP7',
      'Gorgon Halo',
      'Gorgon Point 1',
      'Gorgon Point 2',
      'Gorgon_HALO',
      'MI-450',
      'Mi350P',
      'Verano LPDDR'
    ]);

    for (const project of projects) {
      //skip it
      if (excludedProjects.has(project)) continue;
      emailHtml += `<hr/><h2>Project: ${project}</h2>`;
      const cidPrefix = project.replace(/\s+/g, '_');

      /*
       ====================================================
       1️⃣ QUALITY REPORT SECTION
       ====================================================
      */
      try {
        const { data: qualityData } = await axios.get(
          `${apiUrl}/dashboard/quality-data/${encodeURIComponent(project)}`
        );

        const prbPie = await generatePieChartBase64(qualityData, 'PRB');
        const prbBar = await generateBarChartBase64(qualityData, 'PRB');
        const vrbPie = await generatePieChartBase64(qualityData, 'VRB');
        const vrbBar = await generateBarChartBase64(qualityData, 'VRB');

        const pushAttachment = (base64, cid) => {
          if (!base64) return;
          attachments.push({
            filename: `${cid}.png`,
            content: Buffer.from(base64, 'base64'),
            cid,
          });
        };

        pushAttachment(prbPie, `${cidPrefix}_prbPie`);
        pushAttachment(prbBar, `${cidPrefix}_prbBar`);
        pushAttachment(vrbPie, `${cidPrefix}_vrbPie`);
        pushAttachment(vrbBar, `${cidPrefix}_vrbBar`);

        emailHtml += `
          <h3>📌 Quality Dashboard</h3>
  <!-- PIE CHARTS -->
  <table width="100%" cellpadding="10" cellspacing="0"  >
    <tr>
      <td align="center" width="50%">
        <h4>PRB Incoming Quality Dashboard</h4>
        ${prbPie
            ? `<img src="cid:${cidPrefix}_prbPie" width="400" />`
            : '<p style="color:brown;">No Incoming Quality Issue found for PRB.</p>'}
      </td>

      <td align="center" width="50%" >
        <h4>VRB Incoming Quality Dashboard</h4>
        ${vrbPie
            ? `<img src="cid:${cidPrefix}_vrbPie" width="400" />`
            : '<p style="color:brown;">No Incoming Quality Issue found for VRB.</p>'}
      </td>
    </tr>
  </table>

<!-- BAR CHARTS SIDE BY SIDE -->
<table width="100%" cellpadding="10" cellspacing="0">
  <tr>
    <td align="center" width="50%">
      ${prbPie
            ? `
            <!-- <h4>PRB Breakdown</h4> -->
            ${prbBar
              ? `<p>
                   <a href="${apiUrl}/dashboard/chart/${encodeURIComponent(project)}/PRB/bar" target="_blank">
                      Click to view PRB Incoming Quality Issue Breakdown
                    </a>
                  </p>`
              : '<p style="color:brown;">No Incoming Quality Issue breakdowns found for PRB.</p>'
            }
          `
            : ''
          }
    </td>

    <td align="center" width="50%">
      ${vrbPie
            ? `
            <!-- <h4>VRB Breakdown</h4> -->
            ${vrbBar
              ? `<p>
                    <a href="${apiUrl}/dashboard/chart/${encodeURIComponent(project)}/VRB/bar" target="_blank">
                      Click to view VRB Incoming Quality Issue Breakdown
                    </a>
                  </p>`
              : '<p style="color:brown;">No Incoming Quality Issue breakdowns found for VRB.</p>'
            }
          `
            : ''
          }
    </td>
  </tr>
</table>
        `;
      } catch (err) {
        emailHtml += `<p style="color:red;">Quality data failed</p>`;
      }

      /*
       ====================================================
       2️⃣ WEEKLY BUILD DELIVERY SECTION
       ====================================================
      */
      try {
        const { data: buildData } = await axios.get(
          `${apiUrl}/dashboard/build-data-summary/${project}`
        );

        emailHtml += `<h3>🚀 Weekly Build Delivery</h3>`;

        for (const platform of ['PRB', 'VRB']) {
          const key = platform.toLowerCase();
          const platformData = buildData?.[key];

          if (!platformData) continue;

          const { smartQty = [], nonSmartQty = [] } = platformData;

          // ✅ Check if ALL values are 0
          const isAllZero =
            smartQty.every(q => q === 0) &&
            nonSmartQty.every(q => q === 0);

          // ✅ Choose function based on condition
          const weeklyChart = isAllZero
            ? await generateBuildDeliveryChartBase641(buildData, platform)
            : await generateBuildDeliveryChartBase64(buildData, platform);
          const factoryChart = isAllZero
            ? null
            : await generateFactoryChartBase64(buildData, platform);

          if (!weeklyChart && !factoryChart) {
            emailHtml += `<p style="color:brown;">No data meaning no ${platform} systems sent to smart hand.</p>`;
            continue;
          }

          emailHtml += `<h4>${platform}</h4>`;

          // ✅ Weekly Chart
          if (weeklyChart) {
            const cid1 = `${cidPrefix}_${platform}_weekly`;
            attachments.push({
              filename: `${cid1}.png`,
              content: Buffer.from(weeklyChart, 'base64'),
              cid: cid1,
            });

            emailHtml += `
              <p><b>Weekly vs Accumulative</b></p>
              <img src="cid:${cid1}" style="width:100%;max-width:800px;" />
            `;
          }

          // ✅ Factory Chart
          if (factoryChart) {
            const cid2 = `${cidPrefix}_${platform}_factory`;
            attachments.push({
              filename: `${cid2}.png`,
              content: Buffer.from(factoryChart, 'base64'),
              cid: cid2,
            });

            emailHtml += `
              <p><b>Factory (SH vs Non-SH + Accum)</b></p>
              <img src="cid:${cid2}" style="width:100%;max-width:800px;" />
            `;
          }
        }

      } catch (err) {
        emailHtml += `<p style="color:red;">Build delivery failed</p>`;
      }

      /*
       ====================================================
       3️⃣ LOCATION ALLOCATION SECTION (original + filtered)
       ====================================================
       */
      try {
        // Original data (no subcategory filter)
        const { data: originalData } = await axios.get(
          `${apiUrl}/dashboard/location-allocation`,
          { params: { projectName: project, startDate, endDate } }
        );

        const charts = [
          { type: 'All', platform: 'PRB', data: originalData },
          { type: 'All', platform: 'VRB', data: originalData }
        ];

        // Filtered subcategories
        const prbSubcats = ['1P', '2P'];
        const vrbSubcats = ['1P', '2P', 'Others'];

        for (const subcat of prbSubcats) {
          charts.push({ type: `Filtered (${subcat})`, platform: 'PRB', subcat });
        }
        for (const subcat of vrbSubcats) {
          charts.push({ type: `Filtered (${subcat})`, platform: 'VRB', subcat });
        }

        emailHtml += `<h3>📍 Location Allocation (${year})</h3>`;

        let allPrbHasData = false;
        let allVrbHasData = false;

        for (const chartInfo of charts) {
          const { type, platform, data, subcat } = chartInfo;

          // =====================================
          // 1️⃣ TYPE = ALL → SHOW NON-STACKED IMAGE
          // =====================================
          if (type === 'All') {
            const base64NonStacked = await generateLocationAllocationChartBase64NonStacked(data, platform);
            const cid = `${cidPrefix}_All_${platform}_NonStacked`;

            if (base64NonStacked) {
              // Chart exists → embed it
              if (platform === 'PRB') allPrbHasData = true;
              if (platform === 'VRB') allVrbHasData = true;

              attachments.push({
                filename: `${cid}.png`,
                content: Buffer.from(base64NonStacked, 'base64'),
                cid,
              });

              emailHtml += `
          <h4>${platform} Total Allocation</h4>
          <img src="cid:${cid}" style="width:100%;max-width:800px;" />
        `;

              // Add link to stacked chart below the embedded chart
              let stackedUrl = `${apiUrl}/dashboard/location-allocation/chart?projectName=${encodeURIComponent(project)}&platform=${platform}&startDate=${startDate}&endDate=${endDate}`;
              emailHtml += `
          <p>
            <a href="${stackedUrl}" target="_blank">
              Click to view ${platform} Breakdowns Location Allocation Chart
            </a>
          </p>
        `;
            } else {
              // Chart not found → just show message, no link
              emailHtml += `<p style="color:brown;">No ${platform} build distribution for year ${year}.</p>`;
            }
          }

          // =====================================
          // 2️⃣ FILTERED → DISPLAY LINK ONLY IF NON-STACKED CHART EXISTS
          // =====================================
          else {
            if (
              (platform === 'PRB' && !allPrbHasData) ||
              (platform === 'VRB' && !allVrbHasData)
            ) {
              // Skip filtered if "All" chart has no data
              continue;
            }

            // Fetch filtered data to check if chart exists
            const { data: filteredData } = await axios.get(
              `${apiUrl}/dashboard/location-allocation`,
              {
                params: {
                  projectName: project,
                  startDate,
                  endDate,
                  ...(platform === 'PRB' ? { prbSubcategories: subcat } : { vrbSubcategories: subcat })
                }
              }
            );


            const base64Filtered = await generateLocationAllocationChartBase64NonStacked(filteredData, platform, subcat);

            if (base64Filtered) {
              // Chart exists → show link
              let url = `${apiUrl}/dashboard/location-allocation/nonstacked-chart?projectName=${encodeURIComponent(project)}&platform=${platform}&startDate=${startDate}&endDate=${endDate}`;
              if (platform === 'PRB') url += `&prbSubcategories=${encodeURIComponent(subcat)}`;
              else url += `&vrbSubcategories=${encodeURIComponent(subcat)}`;

              emailHtml += `
          <p>
            <a href="${url}" target="_blank">
              Click to view ${type} ${platform} Total Location Allocation Chart
            </a>
          </p>
        `;
            } else {
              // Chart not found → show message instead of link
              emailHtml += `<p style="color:brown;">No ${type} ${platform} build distribution for year ${year}.</p>`;
            }
          }
        }

      } catch (err) {
        console.error('Location allocation failed for project', project, err);
        emailHtml += `<p style="color:red;">Location allocation failed for ${project}</p>`;
      }
    }

    // ✅ SEND ONE EMAIL ONLY
    await sendCombinedDashboardEmail(emailHtml, attachments, recipients);

  } catch (err) {
    console.error('Combined dashboard cron failed:', err);
  } finally {
    dashboardCronRunning = false;
  }
}, {
  timezone: 'Asia/Kuala_Lumpur'
});


/*

cron.schedule('1 1 1 1 1', async () => {
  console.log('Running Location Allocation email cron...');

  try {
    const recipients = [process.env.EMAIL_RECIPIENT];

    // Fetch all projects
    const { data: projects } = await axios.get(
      'http://localhost:5000/api/dashboard/projects'
    );

    const year = new Date().getFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    let emailHtml = `
      <h1>Location Allocation Report (${year})</h1>
      <p>Delivery allocation by location and team</p>
    `;

    const attachments = [];

    for (const projectName of projects) {
      try {
        // 1️⃣ Original data (no subcategory filter)
        const { data: originalData } = await axios.get(
          'http://localhost:5000/api/dashboard/location-allocation',
          { params: { projectName, startDate, endDate } }
        );

        const originalCharts = [
          { type: 'All', platform: 'PRB', data: originalData },
          { type: 'All', platform: 'VRB', data: originalData }
        ];

        // 2️⃣ Filtered charts by subcategories
        const prbSubcats = ['1P', '2P'];
        const vrbSubcats = ['1P', '2P', 'Others'];
        const filteredCharts = [];

        // PRB filtered by each subcategory
        for (const subcat of prbSubcats) {
          const { data } = await axios.get(
            'http://localhost:5000/api/dashboard/location-allocation',
            { params: { projectName, startDate, endDate, prbSubcategories: subcat } }
          );
          filteredCharts.push({ type: `Filtered (${subcat})`, platform: 'PRB', data });
        }

        // VRB filtered by each subcategory
        for (const subcat of vrbSubcats) {
          const { data } = await axios.get(
            'http://localhost:5000/api/dashboard/location-allocation',
            { params: { projectName, startDate, endDate, vrbSubcategories: subcat } }
          );
          filteredCharts.push({ type: `Filtered (${subcat})`, platform: 'VRB', data });
        }

        // Combine all charts
        const charts = [...originalCharts, ...filteredCharts];

        emailHtml += `<hr/><h2>${projectName}</h2>`;

        for (const chartInfo of charts) {
          const base64 = await generateLocationAllocationChartBase64(chartInfo.data, chartInfo.platform);
          const cid = `${projectName.replace(/\s+/g, '_')}_${chartInfo.type.replace(/\s+/g, '_')}_${chartInfo.platform}`;

          // Attach chart
          if (base64) {
            attachments.push({
              filename: `${cid}.png`,
              content: Buffer.from(base64, 'base64'),
              cid
            });
          }

          // Add to email body
          emailHtml += `
            <h3>${chartInfo.type} ${chartInfo.platform} Location Allocation</h3>
            ${base64 ? `<img src="cid:${cid}" style="width:100%;max-width:1100px;" />` : '<p>No data available</p>'}
          `;
        }

      } catch (projectErr) {
        console.error(`Failed to process project ${projectName}:`, projectErr);
        emailHtml += `<p style="color:red;">Failed to generate charts for project ${projectName}</p>`;
      }
    }

    // ✅ Send email with all attachments
    await sendLocationAllocationEmail(emailHtml, attachments, recipients);

    //console.log('Location Allocation email sent successfully!');

  } catch (err) {
    console.error('Location Allocation cron error:', err);
  }
});


/*

cron.schedule('1 1 1 1 1', async () => {
  console.log('Running weekly email cron...');

  try {
    const { data: projects } = await axios.get('http://localhost:5000/api/dashboard/projects');
    const recipients = [process.env.EMAIL_RECIPIENT]; // adjust as needed

    let emailHtml = `<h2>Weekly Build Delivery Summary</h2>`;
    let attachments = [];

    for (const projectName of projects) {
      const { data: buildData } = await axios.get(
        `http://localhost:5000/api/dashboard/build-data-summary/${projectName}`
      );

      emailHtml += `<h3>Project: ${projectName}</h3>`;

      for (const platform of ['PRB', 'VRB']) {
        const base64 = await generateBuildDeliveryChartBase64(buildData, platform);
        const cid = `${projectName}_${platform}_Build_Delivery`.replace(/\s+/g, '_');

        if (base64) {
          attachments.push({
            filename: `${cid}.png`,
            content: Buffer.from(base64, 'base64'),
            cid,
          });

          emailHtml += `
            <h4>${platform} Weekly Build Delivery</h4>
            <img src="cid:${cid}" style="width:100%;max-width:1100px;" />
          `;
        } else {
          emailHtml += `<p>No ${platform} build delivery data available</p>`;
        }
      }
    }

    await sendweeklyEmail(emailHtml, attachments, recipients);
    //console.log('Weekly email sent for all projects.');
  } catch (err) {
    console.error('Weekly email cron failed:', err);
  }
});




/*
cron.schedule('* * * * *', async () => {
  console.log('Running Location Allocation email cron...');

  try {
    const recipients = [process.env.EMAIL_USER];

    // Fetch all projects
    const { data: projects } = await axios.get(
      'http://localhost:5000/api/dashboard/projects'
    );

    const year = new Date().getFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    let emailHtml = `
      <h1>Location Allocation Report (${year})</h1>
      <p>Delivery allocation by location and team</p>
    `;

    const attachments = [];

    for (const projectName of projects) {
      try {
        const { data: locationData } = await axios.get(
          'http://localhost:5000/api/dashboard/location-allocation',
          {
            params: {
              projectName,
              startDate,
              endDate,
            },
          }
        );

        const prbChart = await generateLocationAllocationChartBase64(
          locationData,
          'PRB'
        );
        const vrbChart = await generateLocationAllocationChartBase64(
          locationData,
          'VRB'
        );

        const cidPrefix = projectName.replace(/\s+/g, '_');

        const pushAttachment = (base64, cid) => {
          if (!base64) return;
          attachments.push({
            filename: `${cid}.png`,
            content: Buffer.from(base64, 'base64'),
            cid,
          });
        };

        pushAttachment(prbChart, `${cidPrefix}_prb_location`);
        pushAttachment(vrbChart, `${cidPrefix}_vrb_location`);

        emailHtml += `
          <hr/>
          <h2>${projectName}</h2>

          <h3>PRB Location Allocation</h3>
          ${prbChart
            ? `<img src="cid:${cidPrefix}_prb_location" style="width:100%;max-width:1100px;" />`
            : '<p>No PRB data available</p>'}

          <h3>VRB Location Allocation</h3>
          ${vrbChart
            ? `<img src="cid:${cidPrefix}_vrb_location" style="width:100%;max-width:1100px;" />`
            : '<p>No VRB data available</p>'}
        `;
      } catch (projectErr) {
        console.error(`Location allocation failed for ${projectName}:`, projectErr);
      }
    }

    // ✅ ONE email only
    await sendLocationAllocationEmail(emailHtml, attachments, recipients);

  } catch (err) {
    console.error('Location Allocation cron error:', err);
  }
});
*/

// Cron job: every Monday 8:00 AM
/*
cron.schedule('* * * * *', async () => {
  console.log('Running scheduled Quality Report email...');
  try {
    const recipients = [process.env.EMAIL_RECIPIENT];

    // Fetch all projects
    const { data: projects } = await axios.get(
      'http://localhost:5000/api/dashboard/projects'
    );

    let emailHtml = `<h1>Weekly Quality Dashboard</h1>`;
    const attachments = [];

    for (const project of projects) {
      try {
        const { data: qualityData } = await axios.get(
          `http://localhost:5000/api/dashboard/quality-data/${encodeURIComponent(project)}`
        );

        // Generate charts
        const prbPie = await generatePieChartBase64(qualityData, 'PRB');
        const prbBar = await generateBarChartBase64(qualityData, 'PRB');
        const vrbPie = await generatePieChartBase64(qualityData, 'VRB');
        const vrbBar = await generateBarChartBase64(qualityData, 'VRB');

        // Unique CIDs per project
        const cidPrefix = project.replace(/\s+/g, '_');

        const pushAttachment = (base64, cid) => {
          if (!base64) return;
          attachments.push({
            filename: `${cid}.png`,
            content: Buffer.from(base64, 'base64'),
            cid,
          });
        };

        pushAttachment(prbPie, `${cidPrefix}_prbPie`);
        pushAttachment(prbBar, `${cidPrefix}_prbBar`);
        pushAttachment(vrbPie, `${cidPrefix}_vrbPie`);
        pushAttachment(vrbBar, `${cidPrefix}_vrbBar`);

        // Append project section to email
        emailHtml += `
          <hr/>
          <h2>${project} – PRB</h2>
          ${prbPie ? `<img src="cid:${cidPrefix}_prbPie" />` : '<p>No PRB Pie Data</p>'}
          ${prbBar ? `<img src="cid:${cidPrefix}_prbBar" />` : '<p>No PRB Bar Data</p>'}

          <h2>${project} – VRB</h2>
          ${vrbPie ? `<img src="cid:${cidPrefix}_vrbPie" />` : '<p>No VRB Pie Data</p>'}
          ${vrbBar ? `<img src="cid:${cidPrefix}_vrbBar" />` : '<p>No VRB Bar Data</p>'}
        `;

      } catch (projectErr) {
        console.error(`Failed for project ${project}:`, projectErr);
      }
    }

    // ✅ Send ONE email only
    await sendQualityEmail(emailHtml, attachments, recipients);

  } catch (err) {
    console.error('Error running scheduled email job:', err);
  }
});

/*
cron.schedule('* * * * *', async () => {
  console.log('Running Weekly Delivery Trend email...');

  try {
    const recipients = [process.env.EMAIL_USER];

    const { data } = await axios.get(
      'http://localhost:5000/api/dashboard/projects'
    );

    const projects = data.projects;

    let emailHtml = `<h1>Weekly Delivery Trend Report</h1>`;
    const attachments = [];

    for (const project of projects) {
      try {
        const { data: weeklyData } = await axios.get(
          'http://localhost:5000/api/dashboard/weekly-delivery',
          {
            params: {
              projectName: project,
            },
          }
        );

        const base64Chart = await generateWeeklyChart(weeklyData, project);
        if (!base64Chart) continue;

        const cid = `${project.replace(/\s+/g, '_')}_weekly`;

        attachments.push({
          filename: `${cid}.png`,
          content: Buffer.from(base64Chart, 'base64'),
          cid,
        });

        emailHtml += `
          <hr/>
          <h2>${project}</h2>
          <img src="cid:${cid}" />
        `;
      } catch (err) {
        console.error(`Weekly chart failed for ${project}`, err.message);
      }
    }

    await transporter.sendMail({
      from: `"Quality Dashboard" <${process.env.EMAIL_USER}>`,
      to: recipients.join(','),
      subject: 'Weekly Delivery Trend Report',
      html: emailHtml,
      attachments,
    });

    console.log('Weekly Delivery Trend email sent');

  } catch (err) {
    console.error('Weekly delivery email cron error:', err);
  }
});
*/

const crypto = require('crypto');
const { getGlobalPool } = require('../utils/database');
const SECRET = 'amd-iqa-secret-key';

router.post('/waiver/requestor-notify', async (req, res) => {
  const { waiverId, partNumber, description, revision, assemblyLevel, reason, submittedBy, requestors, subcontractor } = req.body;
  if (!requestors || !requestors.length) return res.json({ success: true });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const assemblyLevelText = Array.isArray(assemblyLevel) ? assemblyLevel.join(', ') : assemblyLevel || '-';

  // Resolve full names to email addresses from users table
  const { getGlobalPool } = require('../utils/database');
  const pool = getGlobalPool();
  const recipientEmails = [];
  for (const name of requestors) {
    if (!name || !name.trim()) continue;
    // If already looks like an email, use directly
    if (name.includes('@')) {
      recipientEmails.push(name.trim());
    } else {
      const [rows] = await pool.promise().query(
        'SELECT email FROM users WHERE full_name = ? AND status = ? LIMIT 1',
        [name.trim(), 'active']
      );
      if (rows.length) recipientEmails.push(rows[0].email);
    }
  }

  if (!recipientEmails.length) return res.json({ success: true, message: 'No valid recipient emails found' });

  // Look up submittedBy email for CC
  let ccEmail = null;
  if (submittedBy) {
    if (submittedBy.includes('@')) {
      ccEmail = submittedBy;
    } else {
      const [ccRows] = await pool.promise().query(
        'SELECT email FROM users WHERE full_name = ? AND status = ? LIMIT 1',
        [submittedBy.trim(), 'active']
      );
      if (ccRows.length) ccEmail = ccRows[0].email;
    }
  }

  const notifierEmails = await getNotifierEmails();
  const defaultCcEmails = ['Amanda.KoayBeeWah@amd.com', 'LayLing.Chew@amd.com'];
  const toSet = new Set(recipientEmails.map(e => e.toLowerCase()));
  const allCcRequestor = [...new Set([...(ccEmail ? [ccEmail] : []), ...notifierEmails, ...defaultCcEmails].filter(e => !toSet.has(e.toLowerCase())))];

  try {
    const mailOptions = {
      from: `"AMD PDQD System" <noreply@amd.com>`,
      to: recipientEmails.join(','),
      subject: `${waiverId}: Waiver Raised for ${description || ''} (${partNumber || ''}) - Rev ${revision || '-'}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
          <p>Dear waiver owners,</p>
          <p>
            A waiver <strong>${waiverId}</strong> has been raised for the following <strong>${assemblyLevelText}</strong> level assembly:
          </p>
          <table style="border-collapse: collapse; margin: 8px 0 16px 0;">
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600;">Part Number</td><td style="padding: 4px 0;">${partNumber || '-'}</td></tr>
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600;">Description</td><td style="padding: 4px 0;">${description || '-'}</td></tr>
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600;">Subcontractor</td><td style="padding: 4px 0;">${Array.isArray(subcontractor) ? subcontractor.join(', ') : subcontractor || '-'}</td></tr>
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600; vertical-align: top;">Reason for Waiver Request</td><td style="padding: 4px 0;">${reason || '-'}</td></tr>
          </table>
          <p>
            Please navigate to <a href="${frontendUrl}" style="color:#0066cc;">AMD PDQD System</a> -&gt; waiver form -&gt; all forms tab -&gt; # ${waiverId}
          </p>
          <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
            This is an automated notification from the AMD PDQD System. Please do not reply to this email.
          </p>
        </div>
      `,
    };
    if (allCcRequestor.length) mailOptions.cc = allCcRequestor.join(',');

    await createTransporter().sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('Requestor notification email failed:', err);
    res.status(500).json({ error: 'Email failed' });
  }
});

router.post('/waiver/notify', async (req, res) => {
  const { waiverId, partNumber, description, revision, assemblyLevel, subcontractor, reason, submittedBy, approvers, requestors, isUpdate, pdfBase64, uploadedFilePaths } = req.body;
  console.log('[waiver/notify] uploadedFilePaths received:', JSON.stringify(uploadedFilePaths));
  if (!approvers || !approvers.length) return res.json({ success: true });
  const path = require('path');
  const fs = require('fs');

  // Collect all attachment file paths from DB (sections + material rows) so nothing is missed
  const dbFilePaths = new Set(Array.isArray(uploadedFilePaths) ? uploadedFilePaths.filter(Boolean) : []);
  try {
    const pool = getGlobalPool();

    // section areaFiles + otherFiles
    const [sections] = await pool.promise().query(
      'SELECT section_type, extra_data FROM waiver_sections WHERE waiver_id = ?', [waiverId]
    );
    const parseExtra = (raw) => {
      if (!raw) return {};
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
      if (typeof raw === 'object') return raw;
      return {};
    };
    sections.forEach(s => {
      const d = parseExtra(s.extra_data);
      if (d.areaFiles && typeof d.areaFiles === 'object') {
        Object.values(d.areaFiles).forEach(v => {
          if (Array.isArray(v)) v.filter(Boolean).forEach(f => dbFilePaths.add(f));
          else if (v) dbFilePaths.add(v);
        });
      }
      if (Array.isArray(d.otherFiles)) d.otherFiles.filter(Boolean).forEach(f => dbFilePaths.add(f));
    });

    // material row file_path column
    const [matRows] = await pool.promise().query(
      'SELECT file_path FROM waiver_material_rows WHERE waiver_id = ?', [waiverId]
    );
    matRows.forEach(r => {
      const fp = r.file_path;
      if (!fp) return;
      const arr = Array.isArray(fp) ? fp : (typeof fp === 'string' ? (() => { try { return JSON.parse(fp); } catch { return [fp]; } })() : []);
      arr.filter(Boolean).forEach(f => dbFilePaths.add(f));
    });

    console.log('[waiver/notify] all file paths from DB:', [...dbFilePaths]);
  } catch (dbErr) {
    console.error('[waiver/notify] Failed to query DB for attachments:', dbErr.message);
  }

  const token = crypto.createHmac('sha256', SECRET).update(waiverId).digest('hex');
  const approvalLink = `${apiUrl}/email/waiver/approve-link?id=${waiverId}&token=${token}`;
  const cancelLink = `${apiUrl}/email/waiver/cancel-link?id=${waiverId}&token=${token}`;

  const assemblyLevelText = Array.isArray(assemblyLevel) ? assemblyLevel.join(', ') : assemblyLevel || '-';
  const subject = `Waiver ${isUpdate ? 'Updated' : 'Submitted'} – # ${waiverId} for ${partNumber || ''} ${description || ''}`.trim();
  console.log('[waiver/notify] approvers received:', approvers, '| requestors:', requestors, '| submittedBy:', submittedBy);

  // Look up emails by full_name from DB so CC gets real email addresses
  const pool = getGlobalPool();
  const requestorList = [...new Set(
    (Array.isArray(requestors) ? requestors : requestors ? [requestors] : []).filter(Boolean)
  )];

  const namesToLookup = [...new Set([submittedBy, ...requestorList].filter(Boolean))];

  let ccList = [];
  if (namesToLookup.length > 0) {
    try {
      const placeholders = namesToLookup.map(() => '?').join(',');
      const [userRows] = await pool.promise().query(
        `SELECT email FROM users WHERE full_name IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
        namesToLookup
      );
      const notifierEmails = await getNotifierEmails();
      const toSetNotify = new Set(approvers.map(e => e.toLowerCase()));
      ccList = [...new Set([...userRows.map(r => r.email).filter(Boolean), ...notifierEmails].filter(e => !toSetNotify.has(e.toLowerCase())))];
      console.log('[waiver/notify] namesToLookup:', namesToLookup, '| resolved ccList:', ccList);
    } catch (err) {
      console.error('Failed to look up CC emails:', err);
    }
  }

  const attachments = pdfBase64 ? [{
    filename: `${waiverId}.pdf`,
    content: Buffer.from(pdfBase64, 'base64'),
    contentType: 'application/pdf'
  }] : [];

  // Save PDF to disk for reuse in approval email
  if (pdfBase64) {
    try {
      const pdfPath = path.join(__dirname, '..', 'drafts', `waiver_${waiverId}.pdf`);
      fs.writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'));
    } catch (saveErr) {
      console.error('Failed to save waiver PDF:', saveErr.message);
    }
  }

  // Attach all files collected from DB
  dbFilePaths.forEach(filePath => {
    if (!filePath) return;
    const absPath = path.join(__dirname, '..', filePath.replace(/^[\/\\]+/, ''));
    if (!fs.existsSync(absPath)) {
      console.warn('[waiver/notify] attachment not found on disk, skipping:', absPath);
      return;
    }
    attachments.push({ filename: displayFilename(absPath), path: absPath });
  });

  try {
    await createTransporter().sendMail({
      from: `"AMD PDQD System" <noreply@amd.com>`,
      to: approvers.join(','),
      cc: ccList.join(','),
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
          <p>Dear Approver,</p>
          <p>
            A waiver <strong>${waiverId}</strong> has been raised for the following <strong>${assemblyLevelText}</strong> level assembly:
          </p>
          <table style="border-collapse: collapse; margin: 8px 0 16px 0;">
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600;">Part Number</td><td style="padding: 4px 0;">${partNumber || '-'}</td></tr>
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600;">Description</td><td style="padding: 4px 0;">${description || '-'}</td></tr>
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600;">Subcontractor</td><td style="padding: 4px 0;">${Array.isArray(subcontractor) ? subcontractor.join(', ') : subcontractor || '-'}</td></tr>
            <tr><td style="padding: 4px 16px 4px 0; font-weight: 600; vertical-align: top;">Reason for Waiver Request</td><td style="padding: 4px 0;">${reason || '-'}</td></tr>
          </table>
          <p>Please find the waiver PDF attached to this email.</p>
          <br/>
          <table cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:12px 0;">
            <tr>
              <td>
                <a href="${approvalLink}" style="display:inline-block;padding:10px 24px;background:#28a745;color:white;text-decoration:none;border-radius:6px;font-weight:bold;">
                  ✓ Approve Waiver
                </a>
              </td>
              <td>
                <a href="${cancelLink}" style="display:inline-block;padding:10px 24px;background:#dc3545;color:white;text-decoration:none;border-radius:6px;font-weight:bold;">
                  ✕ Reject Waiver
                </a>
              </td>
            </tr>
          </table>
          <p style="color: #555; font-size: 13px; margin-top: 24px;">
            If you encounter any problems with the links above, please
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="color:#0066cc;">login to the AMD PDQD System</a>
            and navigate to the <strong>Waiver Management</strong> tab to perform your actions.
          </p>
          <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
            This is an automated notification from the AMD PDQD System. Please do not reply to this email.
          </p>
        </div>
      `,
      attachments
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Waiver notification email failed:', err);
    res.status(500).json({ error: 'Email failed' });
  }
});

const actionPageStyles = `
  body { font-family: Arial, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: white; border-radius: 10px; padding: 40px 48px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); max-width: 480px; width: 100%; text-align: center; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  .waiver-id { font-size: 20px; font-weight: bold; color: #333; margin-bottom: 6px; }
  h2 { margin: 0 0 8px; font-size: 18px; color: #222; }
  p { color: #555; margin: 0 0 20px; font-size: 14px; }
  textarea { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; resize: vertical; margin-bottom: 16px; font-family: Arial, sans-serif; }
  select { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; margin-bottom: 16px; font-family: Arial, sans-serif; background: white; }
  label { display: block; text-align: left; font-size: 13px; color: #444; margin-bottom: 6px; font-weight: bold; }
.btn-confirm { background: #28a745; color: white; border: none; padding: 12px 32px; border-radius: 6px; font-size: 14px; font-weight: bold; cursor: pointer; width: 100%; margin-bottom: 10px; }
  .btn-confirm:hover { background: #218838; }
  .btn-danger { background: #dc3545; color: white; border: none; padding: 12px 32px; border-radius: 6px; font-size: 14px; font-weight: bold; cursor: pointer; width: 100%; margin-bottom: 10px; }
  .btn-danger:hover { background: #c82333; }
  .btn-cancel { background: white; color: #666; border: 1px solid #ccc; padding: 10px 32px; border-radius: 6px; font-size: 13px; cursor: pointer; width: 100%; }
  .btn-cancel:hover { background: #f0f0f0; }
`;


router.get('/waiver/approve-link', async (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).send('<h2>Missing parameters.</h2>');

  const expected = crypto.createHmac('sha256', SECRET).update(id).digest('hex');
  if (token !== expected) {
    return res.status(403).send(`
      <html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">&#10007; Invalid or expired approval link.</h2>
      </body></html>
    `);
  }

  try {
    const pool = getGlobalPool();
    const [rows] = await pool.promise().query(
      `SELECT status, cancel_reason FROM waivers WHERE waiver_id = ?`, [id]
    );
    const waiver = rows[0];

    if (!waiver) {
      return res.status(404).send(`
        <html><head><style>${actionPageStyles}</style></head>
        <body><div class="card">
          <div class="icon">❓</div>
          <h2 style="color:#888">Waiver Not Found</h2>
          <p>Waiver <strong>${id}</strong> does not exist.</p>
        </div></body></html>
      `);
    }

    if (waiver.status === 'Approved') {
      return res.send(`
        <html><head><style>${actionPageStyles}</style></head>
        <body><div class="card">
          <div class="icon" style="color:#28a745">&#10003;</div>
          <h2 style="color:#28a745">Already Approved</h2>
          <p>Waiver <strong>${id}</strong> has already been approved.</p>
          <p style="color:#aaa;font-size:12px;margin-top:16px;">You may close this tab.</p>
        </div></body></html>
      `);
    }

    if (waiver.status === 'Rejected') {
      return res.send(`
        <html><head><style>${actionPageStyles}</style></head>
        <body><div class="card">
          <div class="icon" style="color:#dc3545">✕</div>
          <h2 style="color:#dc3545">Waiver Already Rejected</h2>
          <p>Waiver <strong>${id}</strong> has been rejected and cannot be approved.</p>
          ${waiver.cancel_reason ? `<p style="background:#f8f8f8;padding:12px;border-radius:6px;text-align:left;font-size:13px;"><strong>Reason:</strong> ${waiver.cancel_reason}</p>` : ''}
          <p style="color:#aaa;font-size:12px;margin-top:16px;">You may close this tab.</p>
        </div></body></html>
      `);
    }

    const [userRows] = await pool.promise().query(
      `SELECT u.full_name
       FROM waiver_config wc
       JOIN JSON_TABLE(wc.config_value, '$[*]' COLUMNS (email VARCHAR(255) PATH '$')) jt
         ON 1=1
       JOIN users u ON u.email COLLATE utf8mb4_general_ci = jt.email COLLATE utf8mb4_general_ci
       WHERE wc.config_key = 'approvers' AND u.status = 'active'
       ORDER BY u.full_name ASC`
    );
    const userOptions = userRows.map(u => `<option value="${u.full_name}">${u.full_name}</option>`).join('');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.send(`
      <html><head><title>Approve Waiver</title><style>${actionPageStyles}</style></head>
      <body>
        <div class="card">
          <div class="icon">📋</div>
          <div class="waiver-id">${id}</div>
          <h2>Approve this waiver?</h2>
          <p>This will mark the waiver as <strong>Approved</strong>. Please confirm before proceeding.</p>
          <form method="POST" action="${baseUrl}/api/email/waiver/approve-link">
            <input type="hidden" name="id" value="${id}" />
            <input type="hidden" name="token" value="${token}" />
            <label for="approvedBy">Approved By</label>
            <select name="approvedBy" id="approvedBy" required>
              <option value="" disabled selected>-- Select your name --</option>
              ${userOptions}
            </select>
            <button type="submit" class="btn-confirm">&#10003; Confirm Approve</button>
            <button type="button" class="btn-cancel" onclick="window.close()">Cancel</button>
          </form>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error('Approve link GET error:', err);
    res.status(500).send('<h2>Server error. Please try again.</h2>');
  }
});

async function notifyRequestor(pool, waiverId, status, actionBy, cancelReason) {
  try {
    const [rows] = await pool.promise().query(
      `SELECT w.part_number, w.description, w.revision, w.assembly_level, w.reason, w.submitted_by, w.requestor
       FROM waivers w
       WHERE w.waiver_id = ?`,
      [waiverId]
    );
    const waiver = rows[0];
    if (!waiver) return;

    const isApproved = status === 'Approved';
    const actionLabel = isApproved ? 'Approved' : 'Rejected';

    const assemblyLevelText = (() => {
      try { const p = JSON.parse(waiver.assembly_level); return Array.isArray(p) ? p.join(', ') : waiver.assembly_level; } catch { return waiver.assembly_level || '-'; }
    })();

    // Resolve To: submitter + requestors
    const requestorNames = (() => {
      try { const p = JSON.parse(waiver.requestor); return Array.isArray(p) ? p.filter(Boolean) : [waiver.requestor]; } catch { return waiver.requestor ? [waiver.requestor] : []; }
    })();
    const toNames = [...new Set([waiver.submitted_by, ...requestorNames].filter(Boolean))];

    // Resolve CC: actionBy (approver/rejecter)
    const allNames = [...new Set([...toNames, actionBy].filter(Boolean))];
    let emailMap = {};
    if (allNames.length > 0) {
      const placeholders = allNames.map(() => '?').join(',');
      const [userRows] = await pool.promise().query(
        `SELECT full_name, email FROM users WHERE full_name COLLATE utf8mb4_general_ci IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
        allNames
      );
      userRows.forEach(r => { emailMap[r.full_name] = r.email; });
    }

    const toEmails = [...new Set(toNames.map(n => emailMap[n]).filter(Boolean))];
    const ccEmails = [...new Set([emailMap[actionBy]].filter(Boolean))];
    if (!toEmails.length) return;

    const subject = `Waiver ${actionLabel} – # ${waiverId} for ${waiver.part_number || ''} ${waiver.description || ''}`.trim();

    const html = isApproved ? `
        <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
          <p>Dear All,</p>
          <p>
            The waiver <strong># ${waiverId}</strong> has been <strong style="color:#28a745;">Approved</strong> in
            '${assemblyLevelText}' level '${waiver.part_number || '-'}' '${waiver.description || '-'}' Rev '${waiver.revision || '-'}' due to '${waiver.reason || '-'}'.
          </p>
          <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
            This is an automated notification from the AMD PDQD System. Please do not reply to this email.
          </p>
        </div>` : `
        <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
          <p>Dear All,</p>
          <p>
            The waiver <strong># ${waiverId}</strong> has been <strong style="color:#dc3545;">Rejected</strong> in
            '${assemblyLevelText}' level '${waiver.part_number || '-'}' '${waiver.description || '-'}' Rev '${waiver.revision || '-'}' due to '${waiver.reason || '-'}'. Do edit or cancel this waiver if it is no longer valid.
          </p>
          ${cancelReason ? `
            <p style="background:#f8f8f8;padding:12px;border-radius:6px;font-size:14px;">
              <strong>Rejection Reason:</strong> ${cancelReason}
            </p>
          ` : ''}
          <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
            This is an automated notification from the AMD PDQD System. Please do not reply to this email.
          </p>
        </div>`;

    const notifierEmails = await getNotifierEmails();
    const toSetNotifyRequestor = new Set(toEmails.map(e => e.toLowerCase()));
    const allCcNotify = [...new Set([...ccEmails, ...notifierEmails].filter(e => !toSetNotifyRequestor.has(e.toLowerCase())))];
    const attachments = [];

    // Attach saved PDF if this is an approval notification
    if (isApproved) {
      const pdfPath = path.join(__dirname, '..', 'drafts', `waiver_${waiverId}.pdf`);
      if (fs.existsSync(pdfPath)) {
        attachments.push({
          filename: `${waiverId}.pdf`,
          content: fs.readFileSync(pdfPath),
          contentType: 'application/pdf'
        });
        try { fs.unlinkSync(pdfPath); } catch {}
      }
    }

    // Collect all uploaded file attachments from material rows and sections
    try {
      const [matRows] = await pool.promise().query(
        'SELECT file_path FROM waiver_material_rows WHERE waiver_id = ?', [waiverId]
      );
      const [sections] = await pool.promise().query(
        'SELECT file_path_1, file_path_2, extra_data FROM waiver_sections WHERE waiver_id = ?', [waiverId]
      );

      const collectPath = (fp) => {
        if (!fp) return;
        if (Array.isArray(fp)) { fp.forEach(collectPath); return; }
        if (typeof fp === 'string') {
          let paths = [];
          try {
            let p = JSON.parse(fp);
            if (typeof p === 'string') p = JSON.parse(p);
            paths = Array.isArray(p) ? p : [fp];
          } catch { paths = [fp]; }
          paths.filter(Boolean).forEach(p => {
            const absPath = path.join(__dirname, '..', p.replace(/^[\/\\]+/, ''));
            if (fs.existsSync(absPath)) {
              attachments.push({ filename: displayFilename(absPath), path: absPath });
            } else {
              console.warn('[notifyRequestor] attachment not found, skipping:', absPath);
            }
          });
        }
      };

      console.log('[notifyRequestor] matRows file_path:', matRows.map(r => r.file_path));
      console.log('[notifyRequestor] sections extra_data:', JSON.stringify(sections.map(s => s.extra_data)));
      matRows.forEach(r => collectPath(r.file_path));
      sections.forEach(s => {
        collectPath(s.file_path_1);
        collectPath(s.file_path_2);
        if (s.extra_data) {
          try {
            const extra = typeof s.extra_data === 'string' ? JSON.parse(s.extra_data) : s.extra_data;
            if (extra.areaFiles) Object.values(extra.areaFiles).forEach(v => collectPath(v));
            if (extra.otherFiles) collectPath(extra.otherFiles);
          } catch {}
        }
      });
      console.log('[notifyRequestor] fileAttachments to send:', attachments.map(a => a.filename));
    } catch (fetchErr) {
      console.error('[notifyRequestor] failed to fetch file attachments:', fetchErr.message);
    }

    const mailOptions = { from: '"AMD PDQD System" <noreply@amd.com>', to: toEmails.join(','), subject, html, attachments };
    if (allCcNotify.length) mailOptions.cc = allCcNotify.join(',');
    await transporter.sendMail(mailOptions);
  } catch (err) {
    console.error('Failed to notify requestor:', err);
  }
}

router.post('/waiver/approve-link', cors({ origin: '*' }), async (req, res) => {
  const { id, token, approvedBy } = req.body;
  if (!id || !token) return res.status(400).send('<h2>Missing parameters.</h2>');
  if (!approvedBy || !approvedBy.trim()) {
    return res.status(400).send(`
      <html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">Please select your name before approving.</h2>
        <button onclick="history.back()">Go Back</button>
      </body></html>
    `);
  }

  const expected = crypto.createHmac('sha256', SECRET).update(id).digest('hex');
  if (token !== expected) {
    return res.status(403).send(`
      <html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">&#10007; Invalid approval link.</h2>
      </body></html>
    `);
  }

  try {
    const pool = getGlobalPool();
    await new Promise((resolve, reject) => {
      pool.query(
        `UPDATE waivers SET status = 'Approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE waiver_id = ?`,
        [approvedBy.trim(), id],
        (err) => err ? reject(err) : resolve()
      );
    });
    notifyRequestor(pool, id, 'Approved', approvedBy.trim(), null);
    res.send(`
      <html><head><title>Approved</title><style>${actionPageStyles}</style></head>
      <body>
        <div class="card">
          <div class="icon" style="color:#28a745">&#10003;</div>
          <h2 style="color:#28a745">Waiver Approved</h2>
          <p><strong>${id}</strong> has been approved by <strong>${approvedBy.trim()}</strong>.</p>
          <p style="margin-top:16px;color:#aaa;font-size:12px;">You may close this tab.</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error('Approve link error:', err);
    res.status(500).send('<h2>Failed to approve waiver. Please try again.</h2>');
  }
});

router.get('/waiver/cancel-link', async (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).send('<h2>Missing parameters.</h2>');

  const expected = crypto.createHmac('sha256', SECRET).update(id).digest('hex');
  if (token !== expected) {
    return res.status(403).send(`
      <html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">&#10007; Invalid or expired cancellation link.</h2>
      </body></html>
    `);
  }

  try {
    const pool = getGlobalPool();
    const [rows] = await pool.promise().query(
      `SELECT status, cancel_reason FROM waivers WHERE waiver_id = ?`, [id]
    );
    const waiver = rows[0];

    if (!waiver) {
      return res.status(404).send(`
        <html><head><style>${actionPageStyles}</style></head>
        <body><div class="card">
          <div class="icon">❓</div>
          <h2 style="color:#888">Waiver Not Found</h2>
          <p>Waiver <strong>${id}</strong> does not exist.</p>
        </div></body></html>
      `);
    }

    if (waiver.status === 'Rejected') {
      return res.send(`
        <html><head><style>${actionPageStyles}</style></head>
        <body><div class="card">
          <div class="icon" style="color:#dc3545">✕</div>
          <h2 style="color:#dc3545">Already Rejected</h2>
          <p>Waiver <strong>${id}</strong> has already been rejected.</p>
          ${waiver.cancel_reason ? `<p style="background:#f8f8f8;padding:12px;border-radius:6px;text-align:left;font-size:13px;"><strong>Reason:</strong> ${waiver.cancel_reason}</p>` : ''}
          <p style="color:#aaa;font-size:12px;margin-top:16px;">You may close this tab.</p>
        </div></body></html>
      `);
    }

    const [userRows] = await pool.promise().query(
      `SELECT u.full_name
       FROM waiver_config wc
       JOIN JSON_TABLE(wc.config_value, '$[*]' COLUMNS (email VARCHAR(255) PATH '$')) jt
         ON 1=1
       JOIN users u ON u.email COLLATE utf8mb4_general_ci = jt.email COLLATE utf8mb4_general_ci
       WHERE wc.config_key = 'approvers' AND u.status = 'active'
       ORDER BY u.full_name ASC`
    );
    const userOptions = userRows.map(u => `<option value="${u.full_name}">${u.full_name}</option>`).join('');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const alreadyApprovedNote = waiver.status === 'Approved'
      ? `<p style="background:#fff3cd;border:1px solid #ffc107;padding:10px 14px;border-radius:6px;font-size:13px;color:#856404;margin-bottom:16px;">
           ⚠️ This waiver is currently <strong>Approved</strong>. Cancelling will override the approval.
         </p>`
      : '';

    res.send(`
      <html><head><title>Cancel Waiver</title><style>${actionPageStyles}</style></head>
      <body>
        <div class="card">
          <div class="icon">⚠️</div>
          <div class="waiver-id">${id}</div>
          <h2>Reject this waiver?</h2>
          ${alreadyApprovedNote}
          <p>Please provide your name and a reason for rejection before submitting.</p>
          <form method="POST" action="${baseUrl}/api/email/waiver/cancel-link">
            <input type="hidden" name="id" value="${id}" />
            <input type="hidden" name="token" value="${token}" />
            <label for="cancelledBy">Rejected By</label>
            <select name="cancelledBy" id="cancelledBy" required>
              <option value="" disabled selected>-- Select your name --</option>
              ${userOptions}
            </select>
            <label for="cancelReason">Rejection Reason</label>
            <textarea name="cancelReason" id="cancelReason" rows="4" placeholder="Enter rejection reason..." required></textarea>
            <button type="submit" class="btn-danger">✕ Confirm Reject</button>
            <button type="button" class="btn-cancel" onclick="window.close()">Go Back</button>
          </form>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error('Cancel link GET error:', err);
    res.status(500).send('<h2>Server error. Please try again.</h2>');
  }
});

router.post('/waiver/cancel-link', cors({ origin: '*' }), async (req, res) => {
  const { id, token, cancelReason, cancelledBy } = req.body;
  if (!id || !token) return res.status(400).send('<h2>Missing parameters.</h2>');
  if (!cancelledBy || !cancelledBy.trim()) {
    return res.status(400).send(`
      <html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">Please select your name before cancelling.</h2>
        <button onclick="history.back()">Go Back</button>
      </body></html>
    `);
  }
  if (!cancelReason || !cancelReason.trim()) {
    return res.status(400).send(`
      <html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">Cancellation reason is required.</h2>
        <button onclick="history.back()">Go Back</button>
      </body></html>
    `);
  }

  const expected = crypto.createHmac('sha256', SECRET).update(id).digest('hex');
  if (token !== expected) {
    return res.status(403).send(`
      <html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
        <h2 style="color:red">&#10007; Invalid cancellation link.</h2>
      </body></html>
    `);
  }

  try {
    const pool = getGlobalPool();
    await new Promise((resolve, reject) => {
      pool.query(
        `UPDATE waivers SET status = 'New', cancel_reason = ?, cancelled_by = ?, updated_at = CURRENT_TIMESTAMP WHERE waiver_id = ?`,
        [cancelReason.trim(), cancelledBy.trim(), id],
        (err) => err ? reject(err) : resolve()
      );
    });
    notifyRequestor(pool, id, 'Rejected', cancelledBy.trim(), cancelReason.trim());
    res.send(`
      <html><head><title>Rejected</title><style>${actionPageStyles}</style></head>
      <body>
        <div class="card">
          <div class="icon" style="color:#dc3545">✕</div>
          <h2 style="color:#dc3545">Waiver Rejected</h2>
          <p><strong>${id}</strong> has been rejected by <strong>${cancelledBy.trim()}</strong>.</p>
          <p style="background:#f8f8f8;padding:12px;border-radius:6px;text-align:left;font-size:13px;">
            <strong>Reason:</strong> ${cancelReason.trim()}
          </p>
          <p style="margin-top:16px;color:#aaa;font-size:12px;">You may close this tab.</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error('Cancel link error:', err);
    res.status(500).send('<h2>Failed to reject waiver. Please try again.</h2>');
  }
});


router.post('/waiver/status-notify', async (req, res) => {
  const { waiverId, status, actionBy, cancelReason } = req.body;
  if (!waiverId || !status) return res.status(400).json({ error: 'Missing waiverId or status' });

  try {
    const pool = getGlobalPool();

    // Fetch full waiver details
    const [rows] = await pool.promise().query(
      `SELECT w.waiver_id, w.part_number, w.description, w.revision, w.assembly_level,
              w.reason, w.requestor, w.submitted_by, w.approved_by
       FROM waivers w
       WHERE w.waiver_id = ?`,
      [waiverId]
    );

    const waiver = rows[0];
    if (!waiver) return res.json({ success: false, message: 'Waiver not found' });

    const isApproved = status === 'Approved';
    const isCancelled = status === 'Cancelled';
    const isClosed = status === 'Closed';

    // Collect all names to look up emails: submitter + requestors + approver (actionBy)
    // requestor may be stored as JSON array string or plain comma-separated string
    let requestorNames = [];
    if (waiver.requestor) {
      try {
        const parsed = JSON.parse(waiver.requestor);
        requestorNames = Array.isArray(parsed)
          ? parsed.map(r => r.trim()).filter(Boolean)
          : [waiver.requestor.trim()];
      } catch {
        requestorNames = waiver.requestor.split(',').map(r => r.trim()).filter(Boolean);
      }
    }
    console.log('[status-notify] submitted_by:', waiver.submitted_by, '| requestorNames:', requestorNames, '| actionBy:', actionBy);
    const assemblyLevelText = (() => {
      try {
        const parsed = JSON.parse(waiver.assembly_level);
        return Array.isArray(parsed) ? parsed.join(', ') : waiver.assembly_level;
      } catch { return waiver.assembly_level || '-'; }
    })();

    const namesToLookup = [...new Set([
      waiver.submitted_by,
      ...requestorNames,
      actionBy,
    ].filter(Boolean))];

    let emailMap = {};
    if (namesToLookup.length > 0) {
      const placeholders = namesToLookup.map(() => '?').join(',');
      const [userRows] = await pool.promise().query(
        `SELECT full_name, email FROM users WHERE LOWER(full_name) IN (${placeholders}) AND email IS NOT NULL AND email != '' AND status = 'active'`,
        namesToLookup.map(n => n.toLowerCase())
      );
      userRows.forEach(r => { emailMap[r.full_name] = r.email; });
    }

    const submitterEmail = emailMap[waiver.submitted_by];
    const requestorEmails = requestorNames.map(n => emailMap[n]).filter(Boolean);
    const approverEmail = emailMap[actionBy];

    const toEmails = [...new Set([submitterEmail, ...requestorEmails].filter(Boolean))];
    const ccEmails = [...new Set([approverEmail].filter(Boolean))];

    if (toEmails.length === 0) {
      return res.json({ success: false, message: 'No recipient emails found' });
    }

    const subject = isApproved
      ? `Waiver Approved – # ${waiverId} for ${waiver.part_number || ''} ${waiver.description || ''}`.trim()
      : isCancelled
      ? `Waiver Cancelled – # ${waiverId} for ${waiver.part_number || ''} ${waiver.description || ''}`.trim()
      : isClosed
      ? `Waiver Closed – # ${waiverId} for ${waiver.part_number || ''} ${waiver.description || ''}`.trim()
      : `Waiver Rejected – # ${waiverId} for ${waiver.part_number || ''} ${waiver.description || ''}`.trim();

    const bodyHtml = isApproved ? `
      <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
        <p>Dear All,</p>
        <p>
          The waiver <strong># ${waiverId}</strong> has been <strong style="color:#28a745;">Approved</strong> in
          '${assemblyLevelText}' level '${waiver.part_number || '-'}' '${waiver.description || '-'}' Rev '${waiver.revision || '-'}' due to '${waiver.reason || '-'}'.
        </p>
        <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
          This is an automated notification from the AMD PDQD System. Please do not reply to this email.
        </p>
      </div>
    ` : isCancelled ? `
      <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
        <p>Dear All,</p>
        <p>
          The waiver <strong># ${waiverId}</strong> has been <strong style="color:#e65100;">Cancelled</strong> in
          '${assemblyLevelText}' level '${waiver.part_number || '-'}' '${waiver.description || '-'}' Rev '${waiver.revision || '-'}' due to '${waiver.reason || '-'}'.
        </p>
        ${cancelReason ? `
          <p style="background:#f8f8f8;padding:12px;border-radius:6px;font-size:14px;">
            <strong>Cancellation Reason:</strong> ${cancelReason}
          </p>
        ` : ''}
        <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
          This is an automated notification from the AMD PDQD System. Please do not reply to this email.
        </p>
      </div>
    ` : isClosed ? `
      <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
        <p>Dear All,</p>
        <p>
          The waiver <strong># ${waiverId}</strong> has been <strong style="color:#555;">Closed</strong> in
          '${assemblyLevelText}' level '${waiver.part_number || '-'}' '${waiver.description || '-'}' Rev '${waiver.revision || '-'}'.
        </p>
        <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
          This is an automated notification from the AMD PDQD System. Please do not reply to this email.
        </p>
      </div>
    ` : `
      <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
        <p>Dear All,</p>
        <p>
          The waiver <strong># ${waiverId}</strong> has been <strong style="color:#dc3545;">Rejected</strong> in
          '${assemblyLevelText}' level '${waiver.part_number || '-'}' '${waiver.description || '-'}' Rev '${waiver.revision || '-'}' due to '${waiver.reason || '-'}'. Do edit or cancel this waiver if it is no longer valid.
        </p>
        ${cancelReason ? `
          <p style="background:#f8f8f8;padding:12px;border-radius:6px;font-size:14px;">
            <strong>Rejection Reason:</strong> ${cancelReason}
          </p>
        ` : ''}
        <p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">
          This is an automated notification from the AMD PDQD System. Please do not reply to this email.
        </p>
      </div>
    `;

    const notifierEmails = await getNotifierEmails();
    const toSetStatus = new Set(toEmails.map(e => e.toLowerCase()));
    const allCcStatus = [...new Set([...ccEmails, ...notifierEmails].filter(e => !toSetStatus.has(e.toLowerCase())))];

    // Attach PDF for Approved status — read saved PDF from disk
    let pdfAttachment = null;
    if (isApproved) {
      try {
        const pdfPath = path.join(__dirname, '..', 'drafts', `waiver_${waiverId}.pdf`);
        if (fs.existsSync(pdfPath)) {
          pdfAttachment = {
            filename: `${waiverId}.pdf`,
            content: fs.readFileSync(pdfPath),
            contentType: 'application/pdf'
          };
          try { fs.unlinkSync(pdfPath); } catch {}
        } else {
          // Fallback: generate simple PDF using puppeteer if saved PDF not found
          const puppeteer = require('puppeteer');

        const waiverHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; padding: 32px; color: #222; font-size: 13px; }
  h1 { color: #00549A; font-size: 18px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 12px; margin-bottom: 24px; }
  .badge { display:inline-block; background:#e8f5e9; color:#2e7d32; padding:3px 12px; border-radius:12px; font-weight:700; font-size:12px; }
  table { width:100%; border-collapse:collapse; margin-bottom:20px; }
  th { background:#00549A; color:#fff; padding:8px 12px; text-align:left; font-size:12px; }
  td { padding:8px 12px; border-bottom:1px solid #eee; vertical-align:top; }
  td:first-child { font-weight:600; width:200px; color:#555; }
  .section-title { font-size:13px; font-weight:700; color:#00549A; margin:20px 0 8px; border-bottom:2px solid #00549A; padding-bottom:4px; }
  .footer { margin-top:32px; font-size:11px; color:#aaa; border-top:1px solid #eee; padding-top:12px; }
</style></head>
<body>
  <h1>AMD Waiver Request Form</h1>
  <div class="subtitle">Automated IQA Dashboard — Internal Use Only</div>
  <div class="badge">✓ Approved</div>

  <div class="section-title">Waiver Details</div>
  <table>
    <tr><td>Waiver ID</td><td>${waiverId}</td></tr>
    <tr><td>Part Number</td><td>${waiver.part_number || '-'}</td></tr>
    <tr><td>Description</td><td>${waiver.description || '-'}</td></tr>
    <tr><td>Revision</td><td>${waiver.revision || '-'}</td></tr>
    <tr><td>Assembly Level</td><td>${assemblyLevelText}</td></tr>
    <tr><td>Requestor</td><td>${requestorNames.join(', ') || '-'}</td></tr>
    <tr><td>Submitted By</td><td>${waiver.submitted_by || '-'}</td></tr>
    <tr><td>Approved By</td><td>${actionBy || '-'}</td></tr>
    <tr><td>Reason / Justification</td><td>${(waiver.reason || '-').replace(/\n/g, '<br>')}</td></tr>
  </table>

  <div class="footer">This is an automated document generated by AMD PDQD System.</div>
</body></html>`;

        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(waiverHtml, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
        await browser.close();
        pdfAttachment = { filename: `${waiverId}.pdf`, content: pdfBuffer, contentType: 'application/pdf' };
        }
      } catch (pdfErr) {
        console.error('Failed to generate waiver PDF:', pdfErr.message);
      }
    }

    // Collect all uploaded file attachments from the waiver
    const fileAttachments = [];
    try {
      const [matRows] = await pool.promise().query(
        'SELECT file_path FROM waiver_material_rows WHERE waiver_id = ?', [waiverId]
      );
      const [sections] = await pool.promise().query(
        'SELECT file_path_1, file_path_2, extra_data FROM waiver_sections WHERE waiver_id = ?', [waiverId]
      );

      const collectPath = (fp) => {
        if (!fp) return;
        if (Array.isArray(fp)) { fp.forEach(collectPath); return; }
        if (typeof fp === 'string') {
          let paths = [];
          try {
            let p = JSON.parse(fp);
            if (typeof p === 'string') p = JSON.parse(p);
            paths = Array.isArray(p) ? p : [fp];
          } catch { paths = [fp]; }
          paths.filter(Boolean).forEach(p => {
            const absPath = path.join(__dirname, '..', p.replace(/^[\/\\]+/, ''));
            if (fs.existsSync(absPath)) {
              fileAttachments.push({ filename: displayFilename(absPath), path: absPath });
            } else {
              console.warn('[status-notify] attachment not found, skipping:', absPath);
            }
          });
        }
      };

      console.log('[status-notify] matRows file_path:', matRows.map(r => r.file_path));
      console.log('[status-notify] sections extra_data:', JSON.stringify(sections.map(s => s.extra_data)));
      matRows.forEach(r => collectPath(r.file_path));
      sections.forEach(s => {
        collectPath(s.file_path_1);
        collectPath(s.file_path_2);
        if (s.extra_data) {
          try {
            const extra = typeof s.extra_data === 'string' ? JSON.parse(s.extra_data) : s.extra_data;
            if (extra.areaFiles) Object.values(extra.areaFiles).forEach(v => collectPath(v));
            if (extra.otherFiles) collectPath(extra.otherFiles);
          } catch {}
        }
      });
      console.log('[status-notify] fileAttachments to send:', fileAttachments.map(a => a.filename));
    } catch (fetchErr) {
      console.error('[status-notify] failed to fetch file attachments:', fetchErr.message);
    }

    console.log('[status-notify] fileAttachments to send:', fileAttachments.map(a => a.filename));
    const mailOptions = {
      from: '"AMD PDQD System" <noreply@amd.com>',
      to: toEmails.join(','),
      subject,
      html: bodyHtml,
      attachments: [...(pdfAttachment ? [pdfAttachment] : []), ...fileAttachments]
    };
    if (allCcStatus.length > 0) mailOptions.cc = allCcStatus.join(',');

    await transporter.sendMail(mailOptions);

    res.json({ success: true });
  } catch (err) {
    console.error('Waiver status notification failed:', err);
    res.status(500).json({ error: 'Email failed' });
  }
});

router.post('/waiver/workorder-notify', async (req, res) => {
  const { waiverId, prevWorkorder, prevWorkorderQty, newWorkorder, newWorkorderQty, updatedBy } = req.body;
  if (!waiverId) return res.status(400).json({ error: 'Missing waiverId' });

  try {
    const pool = getGlobalPool();

    const [rows] = await pool.promise().query(
      `SELECT waiver_id, part_number, description, requestor, submitted_by FROM waivers WHERE waiver_id = ?`,
      [waiverId]
    );
    const waiver = rows[0];
    if (!waiver) return res.json({ success: false, message: 'Waiver not found' });

    // Resolve requestor names to emails for CC
    let requestorNames = [];
    try {
      const parsed = JSON.parse(waiver.requestor);
      requestorNames = Array.isArray(parsed) ? parsed.filter(Boolean) : [waiver.requestor];
    } catch { requestorNames = waiver.requestor ? [waiver.requestor] : []; }

    const allNames = [...new Set([waiver.submitted_by, ...requestorNames].filter(Boolean))];
    let ccList = [];
    if (allNames.length > 0) {
      const placeholders = allNames.map(() => '?').join(',');
      const [userRows] = await pool.promise().query(
        `SELECT email FROM users WHERE full_name IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
        allNames
      );
      ccList = userRows.map(r => r.email).filter(Boolean);
    }

    // Get approvers (TO) and notifiers (CC) from waiver_config — same as waiver submitted email
    const [approverRows] = await pool.promise().query(
      `SELECT config_value FROM waiver_config WHERE config_key = 'approvers' LIMIT 1`
    );
    let approverEmails = [];
    try { approverEmails = JSON.parse(approverRows[0]?.config_value || '[]').filter(Boolean); } catch {}

    const notifierEmails = await getNotifierEmails();
    const allCc = [...new Set([...ccList, ...notifierEmails])];

    const subject = `Waiver Updated – # ${waiverId} for ${waiver.part_number || ''} ${waiver.description || ''}`.trim();

    await createTransporter().sendMail({
      from: `"AMD PDQD System" <noreply@amd.com>`,
      to: approverEmails.join(','),
      cc: allCc.join(','),
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 640px; color: #222; line-height: 1.6;">
          <p>Dear All,</p>
          <p>Waiver <strong>${waiverId}</strong> has been updated with new workorder information:</p>
          <table style="border-collapse: collapse; margin: 12px 0 20px 0; min-width: 320px;">
            <thead>
              <tr style="background: #f0f0f0;">
                <th style="border: 1px solid #ccc; padding: 8px 16px; text-align: left;"></th>
                <th style="border: 1px solid #ccc; padding: 8px 16px; text-align: left;">Previous</th>
                <th style="border: 1px solid #ccc; padding: 8px 16px; text-align: left;">Current</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="border: 1px solid #ccc; padding: 8px 16px; font-weight: 600;">WO:</td>
                <td style="border: 1px solid #ccc; padding: 8px 16px;">${prevWorkorder || '-'}</td>
                <td style="border: 1px solid #ccc; padding: 8px 16px;">${newWorkorder || '-'}</td>
              </tr>
              <tr>
                <td style="border: 1px solid #ccc; padding: 8px 16px; font-weight: 600;">Qty:</td>
                <td style="border: 1px solid #ccc; padding: 8px 16px;">${prevWorkorderQty || '-'}</td>
                <td style="border: 1px solid #ccc; padding: 8px 16px;">${newWorkorderQty || '-'}</td>
              </tr>
            </tbody>
          </table>
          <p style="margin-top: 24px; font-size: 12px; color: #888;">This is an automated notification from the AMD PDQD System. Please do not reply to this email.</p>
        </div>
      `,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Workorder notification email failed:', err);
    res.status(500).json({ error: 'Email failed' });
  }
});

router.post('/build-fail-notify', async (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const {
    chassis_sn,
    bmc_name,
    platform_type,
    build_engineer,
    location,
    visual_inspection_status,
    visual_inspection_notes,
    boot_status,
    boot_notes,
    dimms_detected_status,
    dimms_detected_notes,
    lom_working_status,
    lom_working_notes,
    problem_description,
    email_body,
    recipients,
    cc
  } = req.body;

  if (!chassis_sn) return res.status(400).json({ error: 'chassis_sn is required' });

  const toList = recipients && recipients.length
    ? recipients
    : (process.env.EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean);

  if (!toList.length) return res.status(400).json({ error: 'No recipients configured' });

  const ccList = (cc && cc.length) ? cc : [];

  // Fetch photos for this build from DB
  let attachments = [];
  try {
    const pool = getGlobalPool();
    const [photoRows] = await pool.promise().query(
      'SELECT photo_type, file_path FROM build_photos WHERE chassis_sn = ?',
      [chassis_sn]
    );
    attachments = photoRows
      .map((row) => {
        const absPath = path.join(__dirname, '..', row.file_path.replace(/^[\/\\]+/, ''));
        if (!fs.existsSync(absPath)) return null;
        const ext = path.extname(row.file_path).toLowerCase();
        const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
        return {
          filename: `${row.photo_type}_${path.basename(row.file_path)}`,
          path: absPath,
          contentType: mimeMap[ext] || 'application/octet-stream'
        };
      })
      .filter(Boolean);
  } catch (photoErr) {
    console.warn('Could not fetch photos for email attachment:', photoErr.message);
  }

  const statusBadge = (status) => {
    const color = status === 'pass' ? '#28a745' : status === 'fail' ? '#dc3545' : '#6c757d';
    return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${color};color:white;font-size:12px;font-weight:bold;">${(status || 'N/A').toUpperCase()}</span>`;
  };

  const noteCell = (note) => note
    ? `<span style="color:#555;font-size:13px;">${note}</span>`
    : `<span style="color:#aaa;font-size:13px;">-</span>`;

  const checks = [
    { label: 'Visual Inspection', status: visual_inspection_status, notes: visual_inspection_notes },
    { label: 'Boot',              status: boot_status,              notes: boot_notes },
    { label: 'DIMMs Detected',   status: dimms_detected_status,    notes: dimms_detected_notes },
    { label: 'LOM Working',      status: lom_working_status,       notes: lom_working_notes },
  ];

  const checkRows = checks.map(c => `
    <tr>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">${c.label}</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:center;">${statusBadge(c.status)}</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">${noteCell(c.notes)}</td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;padding:24px;max-width:680px;color:#222;line-height:1.6;">
      <h2 style="color:#dc3545;margin:0 0 4px;">&#9888; Build FPY Failure Notification</h2>
      <p style="color:#888;font-size:13px;margin:0 0 24px;">Generated by AMD PDQD System</p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:8px 12px;border:1px solid #dee2e6;background:#f8f9fa;font-weight:bold;width:180px;">Chassis S/N</td>
          <td style="padding:8px 12px;border:1px solid #dee2e6;"><strong>${chassis_sn}</strong></td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #dee2e6;background:#f8f9fa;font-weight:bold;">BMC Name</td>
          <td style="padding:8px 12px;border:1px solid #dee2e6;">${bmc_name || '-'}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #dee2e6;background:#f8f9fa;font-weight:bold;">Platform Type</td>
          <td style="padding:8px 12px;border:1px solid #dee2e6;">${platform_type || '-'}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #dee2e6;background:#f8f9fa;font-weight:bold;">FPY Status</td>
          <td style="padding:8px 12px;border:1px solid #dee2e6;">${statusBadge('fail')}</td>
        </tr>
      </table>

      <br>
      <h3 style="margin:0 0 12px;font-size:15px;color:#333;">Inspection Results</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#f8f9fa;">
            <th style="padding:8px 12px;border:1px solid #dee2e6;text-align:left;">Check</th>
            <th style="padding:8px 12px;border:1px solid #dee2e6;text-align:center;width:100px;">Status</th>
            <th style="padding:8px 12px;border:1px solid #dee2e6;text-align:left;">Notes</th>
          </tr>
        </thead>
        <tbody>
          ${checkRows}
        </tbody>
      </table>

      <br>
      ${problem_description ? `
      <h3 style="margin:0 0 8px;font-size:15px;color:#333;">Problem Description</h3>
      <p style="background:#fff3cd;border:1px solid #ffc107;padding:12px 16px;border-radius:6px;font-size:14px;color:#856404;margin:0 0 24px;">${problem_description}</p>
      ` : ''}

      <br>
      ${email_body ? `
      <h3 style="margin:0 0 8px;font-size:15px;color:#333;">Additional Notes</h3>
      <p style="background:#f8f9fa;border:1px solid #dee2e6;padding:12px 16px;border-radius:6px;font-size:14px;color:#333;margin:0 0 24px;white-space:pre-wrap;">${email_body}</p>
      ` : ''}

      <p style="color:#888;font-size:12px;margin-top:32px;border-top:1px solid #eee;padding-top:12px;">
        This is an automated notification from the AMD PDQD System. Please do not reply to this email.
      </p>
    </div>
  `;

  try {
    const pt = (platform_type || '').toUpperCase();
    const socket = pt.includes('SP8') ? 'SP8' : pt.includes('SP7') ? 'SP7' : '';
    const board  = pt.includes('VRB') ? 'VRB' : pt.includes('PRB') ? 'PRB' : '';
    const titleParts = ['Incoming', socket, board, bmc_name || chassis_sn, 'Quality Issue'].filter(Boolean);
    const subject = titleParts.join(' ');

    const mailOptions = {
      from: '"AMD PDQD System" <noreply@amd.com>',
      to: toList.join(','),
      subject,
      html,
      attachments
    };
    if (ccList.length) mailOptions.cc = ccList.join(',');

    await createTransporter().sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('Build fail email error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

module.exports = router;
