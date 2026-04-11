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

  const totalCount = projectData.pieData.reduce(
    (sum, item) => sum + (item.count || 0),
    0
  );

  if (totalCount === 0) {
    return null;
  }

  const labels = projectData.pieData.map(
    item => `${item.name} (${item.count})`
  );
  const values = projectData.pieData.map(item => item.value);
  const colors = projectData.pieData.map(item => item.color);

  const qc = new QuickChart();

  qc.setVersion('3');

  qc.setConfig({
    type: 'pie',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      rotation: 120,
      layout: {
        padding: {
          top: 40,
          bottom: 40,
          left: 80,
          right: 80,
        },
      },
      plugins: {
        legend: {
          display: true,
          position: 'left',
          labels: {
            padding: 25,
            font: {
              size: 14,
            },
            color: '#000'
          },
        },

        datalabels: {
          color: '#000',
          font: {
            size: 16,
            weight: 'bold',
          },
          formatter: (value) => `${value}%`,
          anchor: 'end',
          align: 'end',
          offset: 30,

          backgroundColor: 'rgba(255,255,255,0.8)',
          padding: 4,

          clip: false,
        },
      },
    },
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

            // ✅ FORCE INTEGER STEPS
            precision: 0,
            callback: function (value) {
              return Number.isInteger(value) ? value : null;
            }
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

  const backgroundColor = platformType === 'PRB' ? '#3B82F6' : '#F97316';

  const qc = new QuickChart();

  // ✅ FORCE Chart.js v3
  qc.setVersion('3');

  qc.setConfig({
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `Total Delivery Volume by Location in ${year}`,
          data: totals,
          backgroundColor,
        },
      ],
    },
    options: {
      responsive: true,
      layout: {
        padding: {
          top: 20, // ✅ prevent label clipping
        },
      },
      plugins: {
        title: {
          display: true,
          text: `${platformType} Total Location Allocation`,
          font: { size: 18 },
        },
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          offset: 4,
          color: '#000',
          font: { weight: 'bold', size: 12 },
          // ✅ MUST be string for QuickChart
          formatter: 'function(value) { return value === 0 ? "" : value; }',
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: 'Location',
          },
        },
        y: {
          beginAtZero: true,
          min: 0, // ✅ force start at 0
          suggestedMax: Math.max(...totals) + 5, // ✅ avoid top cutoff
          title: {
            display: true,
            text: 'Delivery Quantity',
          },
        },
      },
    },
    plugins: ['chartjs-plugin-datalabels'], // ✅ REQUIRED for v3
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

const generateBuildDeliveryChartBase64 = async (buildData, platformType) => {
  try {
    const key = platformType.toLowerCase();

    if (!buildData?.[key]?.weekly?.length) return null;

    const weeks = buildData[key].weeks || [];
    const weeklyQty = buildData[key].weekly || [];

    const smartQty = buildData[key].smartQty || [];
    const nonSmartQty = buildData[key].nonSmartQty || [];

    const factoryTotalRaw = weeks.map((_, i) => {
      return (smartQty[i] ?? 0) + (nonSmartQty[i] ?? 0);
    });

    const factoryTotal = factoryTotalRaw.map(v => -Math.abs(v));

    const accumFactory = [];
    factoryTotalRaw.reduce((sum, val) => {
      sum += val;
      accumFactory.push(-Math.abs(sum));
      return sum;
    }, 0);

    const accumVrb = [];
    weeklyQty.reduce((sum, val) => {
      sum += val;
      accumVrb.push(sum);
      return sum;
    }, 0);

    const qc = new QuickChart();
    qc.setVersion('3');

    qc.setConfig({
      type: 'bar',

      options: {
        indexAxis: 'y',

        responsive: true,

        layout: {
          padding: {
            top: 20,
            bottom: 20,
            left: 10,
            right: 10,
          },
        },

        interaction: {
          mode: 'index',
          intersect: false,
        },

        plugins: {
          title: {
            display: true,
            text: `${platformType} Factory vs VRB Weekly`,
            font: { size: 18 },
          },

          legend: {
            position: 'bottom',
          },

          datalabels: {
            display: true,
            clamp: true,
            clip: false,
          },

          tooltip: {
            callbacks: {
              label: function (context) {
                return `${context.dataset.label}: ${Math.abs(context.raw)}`;
              },
            },
          },
        },

        scales: {
          x: {
            beginAtZero: true,
            ticks: {
              callback: (value) => Math.abs(value),
            },
          },
          y: {
            stacked: false,
          },
        },
      },

      data: {
        labels: weeks,

        datasets: [
          // 🔴 Factory
          {
            type: 'bar',
            label: 'Factory Total',
            data: factoryTotal,
            backgroundColor: '#8B5CF6',
            barPercentage: 0.6,

            datalabels: {
              display: true,
              anchor: 'center',
              align: 'center',
              color: '#000',
              font: { weight: 'bold', size: 11 },
              formatter: (v) => Math.abs(v),
            },
          },

          // 🔵 VRB
          {
            type: 'bar',
            label: `${platformType} Weekly`,
            data: weeklyQty,
            backgroundColor: '#3B82F6',
            barPercentage: 0.6,

            datalabels: {
              display: true,
              anchor: 'center',
              align: 'center',
              color: '#000',
              font: { weight: 'bold', size: 11 },
              formatter: (v) => v,
            },
          },

          // 🟠 Accum VRB (LABEL FIXED)
          {
            type: 'line',
            label: `Accum ${platformType}`,
            data: accumVrb,
            borderColor: '#F97316',
            pointRadius: 4,
            tension: 0.3,

            datalabels: {
              display: true,
              anchor: 'end',
              align: 'top',     // 👈 pushes label above point
              offset: 8,        // 🔥 moves label AWAY from line
              color: '#F97316',
              font: { weight: 'bold', size: 10 },
              formatter: (v) => v,
            },
          },

          // ⚫ Accum Factory (LABEL FIXED)
          {
            type: 'line',
            label: 'Accum Factory',
            data: accumFactory,
            borderColor: '#111827',
            pointRadius: 4,
            tension: 0.3,

            datalabels: {
              display: true,
              anchor: 'end',
              align: 'top',  // 👈 pushes label below point
              offset: 8,        // 🔥 space away from line
              color: '#111827',
              font: { weight: 'bold', size: 10 },
              formatter: (v) => Math.abs(v),
            },
          },
        ],
      },

      plugins: ['chartjs-plugin-datalabels'],
    });

    qc.setWidth(1000);
    qc.setHeight(500);
    qc.setBackgroundColor('white');

    const binary = await qc.toBinary();
    return binary.toString('base64');

  } catch (err) {
    console.error(`Chart generation failed for ${platformType}:`, err);
    return null;
  }
};

//without factory delivery data
const generateBuildDeliveryChartBase641 = async (buildData, platformType) => {
  try {
    const key = platformType.toLowerCase();

    if (!buildData?.[key]?.weekly?.length) return null;

    const weeks = buildData[key].weeks;
    const weeklyQty = buildData[key].weekly;
    const accumulatedQty = buildData[key].accumulative;

    const qc = new QuickChart();

    // ✅ FORCE Chart.js v3
    qc.setVersion('3');

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
              // ✅ MUST be string in QuickChart
              formatter: 'function(value) { return value === 0 ? "" : value; }',
            },
          },
          {
            type: 'line',
            label: `Accum. ${platformType} Delivery QTY`,
            data: accumulatedQty,
            borderColor: '#F97316',
            backgroundColor: '#F97316',
            fill: false,
            tension: 0.3,
            pointRadius: 4,
            clip: false, // ✅ prevent label cutoff
            datalabels: {
              anchor: 'end',
              align: 'top',
              offset: 6,
              color: '#F97316',
              font: { weight: 'bold', size: 11 },
              formatter: 'function(value) { return value === 0 ? "" : value; }',
            },
          },
        ],
      },
      options: {
        responsive: true,
        layout: {
          padding: {
            top: 20, // ✅ avoid top clipping
          },
        },
        plugins: {
          title: {
            display: true,
            text: `${platformType} Weekly Build Delivery`,
            font: { size: 18 },
          },
          legend: {
            position: 'bottom',
          },
          datalabels: {
            display: true,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            min: 0, // ✅ FORCE start at 0
            suggestedMax: Math.max(...accumulatedQty) + 5, // ✅ prevent label cutoff
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

//up down 
/*
const generateBuildDeliveryChartBase64 = async (buildData, platformType) => {
  try {
    const key = platformType.toLowerCase();

    if (!buildData?.[key]?.weekly?.length) return null;

    const weeks = buildData[key].weeks || [];
    const weeklyQty = buildData[key].weekly || [];

    const smartQty = buildData[key].smartQty || [];
    const nonSmartQty = buildData[key].nonSmartQty || [];

    // Factory total (raw)
    const factoryTotalRaw = weeks.map((_, i) => {
      return (smartQty[i] ?? 0) + (nonSmartQty[i] ?? 0);
    });

    // Keep negative internally for diverging chart
    const factoryTotal = factoryTotalRaw.map(v => -Math.abs(v));

    // Accum Factory
    const accumFactory = [];
    factoryTotalRaw.reduce((sum, val) => {
      sum += val;
      accumFactory.push(-Math.abs(sum));
      return sum;
    }, 0);

    // Accum VRB
    const accumVrb = [];
    weeklyQty.reduce((sum, val) => {
      sum += val;
      accumVrb.push(sum);
      return sum;
    }, 0);

    const qc = new QuickChart();
    qc.setVersion('3');

    qc.setConfig({
      type: 'bar',
      data: {
        labels: weeks,
        datasets: [
          // 🔴 Factory Bar
          {
            type: 'bar',
            label: 'Factory Total',
            data: factoryTotal,
            backgroundColor: '#8B5CF6',
            order: 2,
            barPercentage: 0.6,

            datalabels: {
              display: true,
              anchor: 'center',
              align: 'center',
              clamp: true,
              clip: false,
              color: '#000',
              font: { weight: 'bold', size: 11 },
              formatter: (v) => (v === 0 ? '' : Math.abs(v)),
            },
          },

          // 🔵 VRB Bar
          {
            type: 'bar',
            label: `${platformType} Weekly`,
            data: weeklyQty,
            backgroundColor: '#3B82F6',
            order: 2,
            barPercentage: 0.6,

            datalabels: {
              display: true,
              anchor: 'center',
              align: 'center',
              clamp: true,
              clip: false,
              color: '#000',
              font: { weight: 'bold', size: 11 },
              formatter: (v) => (v === 0 ? '' : v),
            },
          },

          // 🟠 Accum VRB Line
          {
            type: 'line',
            label: `Accum ${platformType}`,
            data: accumVrb,
            borderColor: '#F97316',
            tension: 0.3,
            pointRadius: 4,
            order: 1,

            datalabels: {
              display: true,
              align: 'top',
              anchor: 'end',
              offset: 4,
              color: '#F97316',
              font: { weight: 'bold', size: 10 },
              formatter: (v) => (v === 0 ? '' : v),
            },
          },

          // ⚫ Accum Factory Line
          {
            type: 'line',
            label: 'Accum Factory',
            data: accumFactory,
            borderColor: '#111827',
            tension: 0.3,
            pointRadius: 4,
            order: 1,

            datalabels: {
              display: true,
              align: 'bottom',
              anchor: 'end',
              offset: 4,
              color: '#111827',
              font: { weight: 'bold', size: 10 },
              formatter: (v) => (v === 0 ? '' : Math.abs(v)),
            },
          },
        ],
      },

      options: {
        responsive: true,

        layout: {
          padding: {
            top: 20,
            bottom: 20,
          },
        },

        interaction: {
          mode: 'index',
          intersect: false,
        },

        plugins: {
          title: {
            display: true,
            text: `${platformType} Factory vs VRB Weekly (Diverging View)`,
            font: { size: 18 },
          },

          legend: {
            position: 'bottom',
          },

          // 🔥 GLOBAL DATALABELS FIX
          datalabels: {
            display: true,
            clamp: true,
            clip: false,
          },

          // ✅ Tooltip fix (no negative shown)
          tooltip: {
            callbacks: {
              label: function (context) {
                return `${context.dataset.label}: ${Math.abs(context.raw)}`;
              },
            },
          },
        },

        scales: {
          x: {
            stacked: false,
          },

          y: {
            beginAtZero: true,

            grid: {
              drawBorder: false,
            },

            // ✅ Axis shows positive values only
            ticks: {
              callback: function (value) {
                return Math.abs(value);
              },
            },

            title: {
              display: true,
              text: 'Factory (Left) — VRB (Right)',
            },
          },
        },
      },

      plugins: ['chartjs-plugin-datalabels'],
    });

    qc.setWidth(1000);
    qc.setHeight(420);
    qc.setBackgroundColor('white');

    const binary = await qc.toBinary();
    return binary.toString('base64');

  } catch (err) {
    console.error(`Chart generation failed for ${platformType}:`, err);
    return null;
  }
};

*/

//dual exis
/*
const generateBuildDeliveryChartBase64 = async (buildData, platformType) => {
  try {
    const key = platformType.toLowerCase();
    const weeks = buildData[key].weeks || [];

    if (!buildData?.[key]?.weekly?.length) return null;

    const smartQty = buildData[key].smartQty || [];
    const nonSmartQty = buildData[key].nonSmartQty || [];

    // Align arrays
    const alignedSmart = weeks.map((_, i) => smartQty[i] ?? 0);
    const alignedNonSmart = weeks.map((_, i) => nonSmartQty[i] ?? 0);

    // ✅ Combine weekly total (Factory = Smart + NonSmart)
    const weeklyTotal = weeks.map((_, i) => {
      return (alignedSmart[i] ?? 0) + (alignedNonSmart[i] ?? 0);
    });

    // ✅ Accumulative Factory Delivery
    const accumFactory = [];
    weeklyTotal.reduce((sum, val) => {
      sum += val;
      accumFactory.push(sum);
      return sum;
    }, 0);

    // ✅ Accumulative SH Delivery
    const accumSmart = [];
    alignedSmart.reduce((sum, val) => {
      sum += val;
      accumSmart.push(sum);
      return sum;
    }, 0);

    const qc = new QuickChart();
    qc.setVersion('3');

    qc.setConfig({
      type: 'bar',
      data: {
        labels: weeks,
        datasets: [
          // ✅ LINE (ON TOP)
          {
            type: 'line',
            label: 'Accum Factory delivery',
            data: accumFactory,
            borderColor: '#F97316',
            fill: false,
            tension: 0.3,
            pointRadius: 4,
            yAxisID: 'y1'
          },

          // ✅ BARS
          {
            type: 'bar',
            label: 'Non SH',
            data: alignedNonSmart,
            backgroundColor: '#94A3B8',
            stack: 'stack1',
            yAxisID: 'y'
          },
          {
            type: 'bar',
            label: 'SH',
            data: alignedSmart,
            backgroundColor: '#0EA5E9',
            stack: 'stack1',
            yAxisID: 'y'
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

          // ✅ ONLY LINE LABELS + POSITIONED ABOVE
          datalabels: {
            display: (context) => context.dataset.type === 'line',
            anchor: 'end',
            align: 'top',
            offset: -6, // slightly above line
            clamp: true,
          },
        },
        scales: {
          x: {
            stacked: true,
          },
          y: {
            type: 'linear',
            position: 'left',
            stacked: true,
            beginAtZero: true,
            title: {
              display: true,
              text: 'Quantity',
            },
          },
          y1: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            grid: {
              drawOnChartArea: false,
            },
            title: {
              display: true,
              text: 'Accumulated',
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


const generateFactoryChartBase64 = async (buildData, platformType) => {
  try {
    const key = platformType.toLowerCase();
    const weeks = buildData[key].weeks || [];

    if (!buildData?.[key]?.weekly?.length) return null;

    const smartQty = buildData[key].smartQty || [];
    const nonSmartQty = buildData[key].nonSmartQty || [];

    // Align arrays
    const alignedSmart = weeks.map((_, i) => smartQty[i] ?? 0);
    const alignedNonSmart = weeks.map((_, i) => nonSmartQty[i] ?? 0);

    // Weekly total
    const weeklyTotal = weeks.map((_, i) => {
      return (alignedSmart[i] ?? 0) + (alignedNonSmart[i] ?? 0);
    });

    // Accumulative Factory
    const accumFactory = [];
    weeklyTotal.reduce((sum, val) => {
      sum += val;
      accumFactory.push(sum);
      return sum;
    }, 0);

    const qc = new QuickChart();
    qc.setVersion('3');

    qc.setConfig({
      type: 'bar',
      data: {
        labels: weeks,
        datasets: [
          // ✅ LINE (same axis now)
          {
            type: 'line',
            label: 'Accum Factory delivery',
            data: accumFactory,
            borderColor: '#F97316',
            fill: false,
            tension: 0.3,
            pointRadius: 4,
          },

          // ✅ BARS
          {
            type: 'bar',
            label: 'Non SH',
            data: alignedNonSmart,
            backgroundColor: '#94A3B8',
            stack: 'stack1',
          },
          {
            type: 'bar',
            label: 'SH',
            data: alignedSmart,
            backgroundColor: '#0EA5E9',
            stack: 'stack1',
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: `${platformType} Factory Delivery`,
            font: { size: 18 },
          },
          legend: { position: 'bottom' },

          datalabels: {
            display: true,

            formatter: (value) => value, // show value

            // 🎯 Different positioning for bar vs line
            anchor: (context) => {
              return context.dataset.type === 'line' ? 'end' : 'center';
            },
            align: (context) => {
              return context.dataset.type === 'line' ? 'top' : 'center';
            },

            color: (context) => {
              return context.dataset.type === 'line' ? '#000' : '#fff';
            },

            font: {
              weight: 'bold',
              size: 10,
            },

            clamp: true,
          },
        },
        scales: {
          x: {
            stacked: true,
          },
          y: {
            type: 'linear',
            position: 'left',
            stacked: true,
            beginAtZero: true,
            title: {
              display: true,
              text: 'Quantity',
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


module.exports = {
  generatePieChartBase64,
  generateBarChartBase64,
  generateLocationAllocationChartBase64,
  generateBuildDeliveryChartBase64,
  generateFactoryChartBase64,
  generateLocationAllocationChartBase64NonStacked,
  generateBuildDeliveryChartBase641
};
