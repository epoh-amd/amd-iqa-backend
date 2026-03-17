// backend/utils/generateCharts.js
const QuickChart = require('quickchart-js');

/**
 * Generate Pie Chart base64
 * Mirrors frontend PieChart (percentages + count)
 */
const generatePieChartBase64 = async (qualityData, type) => {
  const projectData = qualityData[type];
  if (!projectData || !projectData.pieData || projectData.pieData.length === 0) {
    return null;
  }

  // Check if total count is zero
  const totalCount = projectData.pieData.reduce(
    (sum, item) => sum + (item.count || 0),
    0
  );

  if (totalCount === 0) {
    return null;   // ⬅ do not generate chart
  }

  // Embed count into labels
  const labels = projectData.pieData.map(item => `${item.name} (${item.count})`);
  const values = projectData.pieData.map(item => item.value);
  const colors = projectData.pieData.map(item => item.color);

  const qc = new QuickChart();
  qc.setConfig({
    type: 'pie',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      rotation: -90,
      layout: {
        padding: {
          top: 30,
          bottom: 30,
          left: 60,
          right: 60,
        },
      },
      legend: {
        display: true,
        position: 'left',
        labels: {
          padding: 25   // 👈 increase distance from pie
        }
      },
      plugins: {
        datalabels: {
          color: '#000',
          formatter: function (value) {
            return value + '%';
          },
          anchor: 'end',
          align: 'end',
          offset: 90,      // push further out
          clamp: false,
          clip: false,
        },
      },
    }
  });

  qc.setWidth(700);
  qc.setHeight(600);

  const imageBuffer = await qc.toBinary();
  return imageBuffer.toString('base64');
};

/**
 * Generate Bar Chart base64
 * Mirrors frontend BarChart (colors from Pie chart, breakdown qty)
 */
const generateBarChartBase64 = async (qualityData, type) => {
  const projectData = qualityData[type];
  if (!projectData || !projectData.breakdownData?.length) return null;

  const data = [...projectData.breakdownData].sort((a, b) => b.qty - a.qty);

  const labels = data.map(item => item.issue);
  const values = data.map(item => item.qty);

  // 🔥 CREATE COLOR MAP FROM PIE (SOURCE OF TRUTH)
  const categoryColorMap = {};
  projectData.pieData.forEach(item => {
    categoryColorMap[item.name] = item.color;
  });

  // 🔥 Apply EXACT same color as pie
  const colors = data.map(item => categoryColorMap[item.category] || '#9ca3af'); // fallback grey

  const qc = new QuickChart();
  qc.setConfig({
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `${type} Issue Breakdown`,
          data: values,
          backgroundColor: colors,
        },
      ],
    },
    options: {
      // Legend configuration (boxes hidden, text visible)
      legend: {
        display: true,
        labels: {
          boxWidth: 0,        // hides color box
          fontColor: '#000000', // black legend text
          fontSize: 12,
        },
      },
      // Plugins configuration
      plugins: {
        datalabels: {
          anchor: 'center',
          align: 'center',
          color: '#000000',           // black datalabels
          font: { weight: 'bold', size: 12 },
          formatter: value => value,
        },
        title: {
          display: true,
          text: `${type} Issue Breakdown`,
          color: '#000000',            // black title
          font: { size: 16, weight: 'bold' },
        },
      },
      // Axis configuration
      scales: {
        yAxes: [{
          ticks: { 
            beginAtZero: true,
            fontColor: '#000000',      // black y-axis labels
            font: { size: 12, weight: '600' },
          }
        }],
        xAxes: [{
          ticks: { 
            autoSkip: false,
            fontColor: '#000000',      // black x-axis labels
            font: { size: 12, weight: '600' },
          }
        }]
      }
    }
  });

  qc.setWidth(500);
  qc.setHeight(300);

  const imageBuffer = await qc.toBinary();
  return imageBuffer.toString('base64');
};

const generateLocationAllocationChartBase64NonStacked = async (locationData, platformType) => {
  const year = new Date().getFullYear();
  if (!locationData?.[platformType]?.chartData?.length) return null;

  const chartData = locationData[platformType].chartData;
  const labels = chartData.map(l => l.location);

  // Calculate total per location
  const totals = labels.map(locationName => {
    const location = chartData.find(l => l.location === locationName);
    let sum = 0;
    location.subcategories.forEach(subcat => {
      subcat.teams.forEach(team => {
        sum += team.quantity;
      });
    });
    return sum;
  });

  // Assign color per platform
  const backgroundColor = platformType === 'PRB' ? '#3B82F6' : '#F97316'; // PRB = blue, VRB = orange

  const qc = new QuickChart();
  qc.setConfig({
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: `Total Delivery Volume by Location in ${year}`,
        data: totals,
        backgroundColor,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: `${platformType} Total Location Allocation`,
          font: { size: 18 },
        },
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: '#000',
          font: { weight: 'bold', size: 12 },
          formatter: value => value === 0 ? '' : value,
        },
      },
      scales: {
        x: { title: { display: true, text: 'Location' } },
        y: { beginAtZero: true, title: { display: true, text: 'Delivery Quantity' } },
      },
    },
  });

  qc.setWidth(1000);
  qc.setHeight(400);
  qc.setBackgroundColor('white');

  return await qc.toBinary().then(buf => buf.toString('base64'));
};


const generateLocationAllocationChartBase64 = async (
  locationData,
  platformType
) => {
  if (!locationData?.[platformType]?.chartData?.length) {
    return null;
  }

  const chartData = locationData[platformType].chartData;

  // ---------- Build datasets ----------
  const labels = chartData.map(l => l.location);

  const teamMap = {};
  chartData.forEach(location => {
    location.subcategories.forEach(subcat => {
      subcat.teams.forEach(team => {
        if (!teamMap[team.team]) {
          teamMap[team.team] = {
            label: team.team,
            backgroundColor: team.color || '#94A3B8',
            data: [],
            stack: 'Stack 0',
          };
        }
      });
    });
  });

  // Fill data per location
  labels.forEach(locationName => {
    const location = chartData.find(l => l.location === locationName);

    Object.values(teamMap).forEach(team => {
      let qty = 0;
      location.subcategories.forEach(subcat => {
        subcat.teams.forEach(t => {
          if (t.team === team.label) {
            qty += t.quantity;
          }
        });
      });
      team.data.push(qty);
    });
  });

  const datasets = Object.values(teamMap);

  // ---------- Chart config ----------
  const qc = new QuickChart();
  qc.setConfig({
    type: 'bar',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: `${platformType} Location Allocation`,
          font: { size: 18 },
        },
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12 },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
        },
        datalabels: { // <-- add labels on bars
          anchor: 'center',
          align: 'center',
          color: '#000000',
          font: { weight: 'bold', size: 12 },
          formatter: (value) => value === 0 ? '' : value, // <-- hide zero
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Location' },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          title: {
            display: true,
            text: 'Delivery Quantity',
          },
        },
        plugins: ['chartjs-plugin-datalabels'],
      },
    },
  });

  qc.setWidth(1000);
  qc.setHeight(400);
  qc.setBackgroundColor('white');

  return await qc.toBinary().then(buf => buf.toString('base64'));
};

/*
const generateBuildDeliveryChartBase64 = async (buildData, platformType) => {
  try {
    const key = platformType.toLowerCase();

    if (!buildData?.[key]?.weekly?.length) return null;

    const weeks = buildData[key].weeks;
    const weeklyQty = buildData[key].weekly;
    const accumulatedQty = buildData[key].accumulative;

    const qc = new QuickChart();
    qc.setConfig({
      type: 'bar',
      data: {
        labels: weeks,
        datasets: [
          {
            type: 'bar',
            label: `${platformType} Weekly Delivery QTY`,
            data: weeklyQty,
            backgroundColor: '#3B82F6',
            datalabels: {
              anchor: 'center',
              align: 'center',
              color: '#000000',
              font: { weight: 'bold', size: 12 },
              formatter: (value) => (value === 0 ? '' : value),
            },
          },
          {
            type: 'line',
            label: `Accum. ${platformType} Delivery QTY`,
            data: accumulatedQty,
            borderColor: '#F97316',
            fill: false,
            tension: 0.3,
            pointRadius: 4,
            datalabels: {
              anchor: 'end',      // move label away from point
              align: 'top',       // position above the line
              offset: 6,          // add spacing
              color: '#F97316',
              font: { weight: 'bold', size: 11 },
              formatter: (value) => (value === 0 ? '' : value),
            },
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: `${platformType} Weekly Build Delivery`,
            font: { size: 18 },
          },
          legend: { position: 'bottom' },
          datalabels: {
            display: true, // enable globally but styling per dataset
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'Build Delivery QTY',
            },
          },
        },
      },
      plugins: ['chartjs-plugin-datalabels'],
    });

    qc.setWidth(1000);
    qc.setHeight(400);
    qc.setBackgroundColor('white');

    const binary = await qc.toBinary();
    return binary.toString('base64');
  } catch (err) {
    console.error(`Chart generation failed for ${platformType}:`, err);
    return null;
  }
};

*/

const generateBuildDeliveryChartBase64 = async (buildData, platformType) => {
  try {
    const key = platformType.toLowerCase();

    if (!buildData?.[key]?.weekly?.length) return null;

    const weeks = buildData[key].weeks; // weekly build labels
    const weeklyQty = buildData[key].weekly; // actual weekly builds
    const accumulatedQty = buildData[key].accumulative; // accumulated builds
    const porQty = buildData[key].porQuantities || []; // weekly POR targets
    const porWeeks = buildData[key].porWeeks || []; // week labels for POR

    // Align POR array length with weeks if needed
    const alignedPorQty = weeks.map((week, idx) => porQty[idx] ?? 0);

    // Calculate accumulative POR
    const accumPorQty = [];
    alignedPorQty.reduce((sum, val) => {
      sum += val;
      accumPorQty.push(sum);
      return sum;
    }, 0);

    const qc = new QuickChart();
    qc.setConfig({
      type: 'bar',
      data: {
        labels: weeks,
        datasets: [
          {
            type: 'bar',
            label: `${platformType} Weekly Delivery`,
            data: weeklyQty,
            backgroundColor: '#D2B48C',
            stack: 'buildStack',
            datalabels: {
              anchor: 'center',
              align: 'center',
              color: '#000000',
              font: { weight: 'bold', size: 12 },
              formatter: (value) => (value === 0 ? '' : value),
            },
          },
          {
            type: 'bar',
            label: `${platformType} Factory Delivery`,
            data: alignedPorQty,
            backgroundColor: '#C4B5FD',
            stack: 'buildStack',
            datalabels: {
              anchor: 'center',
              align: 'center',
              color: '#000000',
              font: { weight: 'bold', size: 12 },
              formatter: (value) => (value === 0 ? '' : value),
            },
          },
          {
            type: 'line',
            label: `Accum. ${platformType} Delivery`,
            data: accumulatedQty,
            borderColor: '#8B4513',
            fill: false,
            tension: 0.3,
            pointRadius: 4,
            datalabels: {
              anchor: 'end',
              align: 'top',
              offset: 6,
              color: '#8B4513',
              font: { weight: 'bold', size: 11 },
              formatter: (value) => (value === 0 ? '' : value),
            },
          },
          {
            type: 'line',
            label: `Accum. Factory Delivery`,
            data: accumPorQty,
            borderColor: '#7C3AED',
            fill: false,
            tension: 0.3,
            pointRadius: 4,
            datalabels: {
              anchor: 'end',
              align: 'top',
              offset: 6,
              color: '#7C3AED',
              font: { weight: 'bold', size: 11 },
              formatter: (value) => (value === 0 ? '' : value),
            },
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: `${platformType} Weekly Build Delivery vs POR Targets`,
            font: { size: 18 },
          },
          legend: { position: 'bottom' },
          datalabels: { display: true },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Quantity' },
            stacked: true,
          },
          x: {
            stacked: true,
          },
        },
      },
      plugins: ['chartjs-plugin-datalabels'],
    });

    qc.setWidth(1000);
    qc.setHeight(400);
    qc.setBackgroundColor('white');

    const binary = await qc.toBinary();
    return binary.toString('base64');
  } catch (err) {
    console.error(`Chart generation failed for ${platformType}:`, err);
    return null;
  }
};

module.exports = {
  generatePieChartBase64,
  generateBarChartBase64,
  generateLocationAllocationChartBase64,
  generateBuildDeliveryChartBase64,
  generateLocationAllocationChartBase64NonStacked
};
