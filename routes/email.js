const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const axios = require('axios'); // <-- for fetching backend data
const { generatePieChartBase64, generateBarChartBase64, generateWeeklyChart, generateLocationAllocationChartBase64, generateLocationAllocationChartBase64NonStacked, generateBuildDeliveryChartBase64, generateFactoryChartBase64, generateBuildDeliveryChartBase641 } = require('../utils/generateCharts');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const apiUrl = process.env.API_URL || 'http://localhost:5000/api';

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: 'atlmail10.amd.com',
  port: 25,
  secure: false, // false because we are not using SSL (port 465)
  requireTLS: true, // matches EMAIL_USE_TLS = True
  tls: {
    rejectUnauthorized: false // Only disable if internal server has cert issues
  }

});

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



cron.schedule('30 12 * * *', async () => {
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

            const base64Filtered = await generateLocationAllocationChartBase64NonStacked(filteredData, platform);

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

module.exports = router;
