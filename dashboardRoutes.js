// backend/dashboardRoutes.js
/**
 * Dashboard API Routes for Smart Hand Weekly Build Delivery
 * 
 * This module provides API endpoints for the dashboard functionality:
 * - Weekly build delivery charts for PRB and VRB platforms
 * - Real-time data from builds and master_builds tables
 * - Project-based filtering
 * - Combined bar (actual delivery) and line (accumulative) charts
 */

const express = require('express');
const router = express.Router();


/**
 * GET /api/dashboard/projects
 * 
 * Get all unique project names from builds table
 * Used for populating the project filter dropdown
 * 
 * @returns {array} - Array of unique project names
 */
const getProjects = (req, res) => {
  const db = req.app.get('db');
  
  /*
  const query = `
    SELECT DISTINCT project_name 
    FROM builds 
    WHERE project_name IS NOT NULL 
      AND project_name != '' 
    ORDER BY project_name ASC
  `;
  */

  const query = `
  SELECT project_name 
  FROM project_name 
  WHERE project_name IS NOT NULL 
    AND project_name != '' 
  ORDER BY project_name ASC
`;

  db.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({ 
        error: 'Failed to fetch projects',
        details: err.message 
      });
    }

    const projects = results.map(row => row.project_name);
    res.json({ projects });
  });
};

/**
 * GET /api/dashboard/weekly-delivery
 * 
 * Get weekly build delivery data for PRB and VRB platforms
 * Returns both actual delivery quantities (bars) and accumulative quantities (line)
 * 
 * @query {string} projectName - Filter by project name (optional)
 * @query {string} startDate - Start date for data range (optional, defaults to 12 weeks ago)
 * @query {string} endDate - End date for data range (optional, defaults to current date)
 * 
 * @returns {object} - {
 *   prb: { weekly: [], accumulative: [] },
 *   vrb: { weekly: [], accumulative: [] },
 *   weeks: []
 * }
 * http://localhost:5000/api/dashboard/weekly-delivery?projectName=Weisshorn%20SP7&startDate=2025-10-19
 */


/*
const getWeeklyDeliveryData = (req, res) => {
  const db = req.app.get('db');
  const { projectName, startDate, endDate } = req.query;

  // Default to last 12 weeks if no date range specified
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - (12 * 7)); // 12 weeks ago

  const queryStartDate = startDate || defaultStartDate.toISOString().split('T')[0];
  const queryEndDate = endDate || defaultEndDate.toISOString().split('T')[0];

  // Build the query with optional project filter
  let whereClause = `
    WHERE mb.master_status = 'Delivered'
      AND mb.delivery_date IS NOT NULL
      AND mb.delivery_date BETWEEN ? AND ?
      AND (
        LOWER(b.platform_type) LIKE '%prb%' 
        OR LOWER(b.platform_type) LIKE '%vrb%'
      )
  `;
  
  const queryParams = [queryStartDate, queryEndDate];
  
  if (projectName && projectName !== 'all') {
    whereClause += ' AND b.project_name = ?';
    queryParams.push(projectName);
  }

  const query = `
    SELECT 
      b.chassis_sn,
      b.platform_type,
      b.project_name,
      mb.delivery_date,
      CASE 
        WHEN LOWER(b.platform_type) LIKE '%prb%' THEN 'PRB'
        WHEN LOWER(b.platform_type) LIKE '%vrb%' THEN 'VRB'
        ELSE 'OTHER'
      END as platform_category,
      YEARWEEK(mb.delivery_date, 1) as year_week,
      CONCAT(YEAR(mb.delivery_date), '-W', 
             LPAD(WEEK(mb.delivery_date, 1), 2, '0')) as week_label
    FROM builds b
    INNER JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
    ${whereClause}
    ORDER BY mb.delivery_date ASC
  `;

  db.query(query, queryParams, (err, results) => {
    if (err) {
      return res.status(500).json({ 
        error: 'Failed to fetch weekly delivery data',
        details: err.message 
      });
    }

    // Generate week labels for the entire range
    const weeks = generateWeekLabels(queryStartDate, queryEndDate);
    
    // Process results to get weekly counts
    const weeklyData = processWeeklyData(results, weeks);
    
    res.json(weeklyData);
  });
};

*/
const getWeeklyDeliveryData = (req, res) => {
  const db = req.app.get('db');
  const { projectName, startDate, endDate } = req.query;

  // Default to last 12 weeks if no date range specified
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - (12 * 7)); // 12 weeks ago

  const queryStartDate = startDate || defaultStartDate.toISOString().split('T')[0];
  const queryEndDate = endDate || defaultEndDate.toISOString().split('T')[0];

  const fetchProjectId = (callback) => {
    if (projectName && projectName !== 'all') {
      db.query('SELECT id FROM project_name WHERE project_name = ?', [projectName], (err, rows) => {
        if (err) return callback(err);
        if (rows.length === 0) return callback(new Error('Project not found'));
        callback(null, rows[0].id); // only one row expected
      });
    } else {
      callback(null, null); // no project filter
    }
  };

  fetchProjectId((err, projectId) => {
    if (err) {
      return res.status(500).json({
        error: 'Failed to fetch project id',
        details: err.message
      });
    }

    // Build the query with optional project filter
    let whereClause = `
      WHERE mb.master_status = 'Delivered'
        AND mb.delivery_date IS NOT NULL
        AND mb.delivery_date BETWEEN ? AND ?
        AND (
          LOWER(b.platform_type) LIKE '%prb%' 
          OR LOWER(b.platform_type) LIKE '%vrb%'
        )
    `;
    const queryParams = [queryStartDate, queryEndDate];

    if (projectId) {
      whereClause += ' AND b.project_name = ?';
      queryParams.push(projectId); // use the id from project_name table
    }

    const query = `
      SELECT 
        b.chassis_sn,
        b.platform_type,
        b.project_name,
        mb.delivery_date,
        CASE 
          WHEN LOWER(b.platform_type) LIKE '%prb%' THEN 'PRB'
          WHEN LOWER(b.platform_type) LIKE '%vrb%' THEN 'VRB'
          ELSE 'OTHER'
        END as platform_category,
        YEARWEEK(mb.delivery_date, 1) as year_week,
        CONCAT(YEAR(mb.delivery_date), '-W', 
               LPAD(WEEK(mb.delivery_date, 1), 2, '0')) as week_label
      FROM builds b
      INNER JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
      ${whereClause}
      ORDER BY mb.delivery_date ASC
    `;

    db.query(query, queryParams, (err, results) => {
      if (err) {
        return res.status(500).json({
          error: 'Failed to fetch weekly delivery data',
          details: err.message
        });
      }

      // Generate week labels for the entire range
      const weeks = generateWeekLabels(queryStartDate, queryEndDate);

      // Process results to get weekly counts
      const weeklyData = processWeeklyData(results, weeks);

      res.json(weeklyData);
    });
  });
};


/**
 * Helper function to generate week labels for a date range
 * 
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {array} - Array of week labels in format "YYYY-WXX"
 */
function generateWeekLabels(startDate, endDate) {
  const weeks = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  // Start from the beginning of the week containing startDate
  const current = new Date(start);
  current.setDate(current.getDate() - current.getDay() + 1); // Monday of the week
  
  while (current <= end) {
    const year = current.getFullYear();
    const weekNum = getWeekNumber(current);
    const weekLabel = `${year}-W${weekNum.toString().padStart(2, '0')}`;
    
    weeks.push({
      weekLabel,
      startDate: new Date(current).toISOString().split('T')[0],
      endDate: new Date(current.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    });
    
    current.setDate(current.getDate() + 7); // Next week
  }
  
  return weeks;
}

/**
 * Helper function to get ISO week number
 * 
 * @param {Date} date - Date object
 * @returns {number} - Week number (1-53)
 */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Helper function to process weekly delivery data
 * 
 * @param {array} results - Raw query results
 * @param {array} weeks - Array of week objects
 * @returns {object} - Processed data with PRB/VRB weekly and accumulative counts
 */
function processWeeklyData(results, weeks) {
  // Initialize data structure
  const data = {
    prb: {
      weekly: [],
      accumulative: []
    },
    vrb: {
      weekly: [],
      accumulative: []
    },
    weeks: weeks.map(w => w.weekLabel)
  };

  // Group results by week and platform
  const weeklyCountsByPlatform = {};
  
  results.forEach(row => {
    const weekLabel = row.week_label;
    const platform = row.platform_category;
    
    if (!weeklyCountsByPlatform[weekLabel]) {
      weeklyCountsByPlatform[weekLabel] = { PRB: 0, VRB: 0 };
    }
    
    if (platform === 'PRB' || platform === 'VRB') {
      weeklyCountsByPlatform[weekLabel][platform]++;
    }
  });

  // Initialize counters for accumulative totals
  let prbAccumulative = 0;
  let vrbAccumulative = 0;

  // Fill in data for each week
  weeks.forEach(week => {
    const weekLabel = week.weekLabel;
    const prbWeekly = weeklyCountsByPlatform[weekLabel]?.PRB || 0;
    const vrbWeekly = weeklyCountsByPlatform[weekLabel]?.VRB || 0;
    
    // Add weekly counts to accumulative totals
    prbAccumulative += prbWeekly;
    vrbAccumulative += vrbWeekly;
    
    // Store weekly and accumulative data
    data.prb.weekly.push(prbWeekly);
    data.prb.accumulative.push(prbAccumulative);
    data.vrb.weekly.push(vrbWeekly);
    data.vrb.accumulative.push(vrbAccumulative);
  });

  return data;
}

/**
 * GET /api/dashboard/delivery-summary
 * 
 * Get summary statistics for the dashboard
 * 
 * @query {string} projectName - Filter by project name (optional)
 * @query {string} startDate - Start date for data range (optional)
 * @query {string} endDate - End date for data range (optional)
 * 
 * @returns {object} - Summary statistics
 */

/*
const getDeliverySummary = (req, res) => {
  const db = req.app.get('db');
  const { projectName, startDate, endDate } = req.query;

  // Default to last 12 weeks if no date range specified
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - (12 * 7));

  const queryStartDate = startDate || defaultStartDate.toISOString().split('T')[0];
  const queryEndDate = endDate || defaultEndDate.toISOString().split('T')[0];

  let whereClause = `
    WHERE mb.master_status = 'Delivered'
      AND mb.delivery_date IS NOT NULL
      AND mb.delivery_date BETWEEN ? AND ?
  `;
  
  const queryParams = [queryStartDate, queryEndDate];
  
  if (projectName && projectName !== 'all') {
    whereClause += ' AND b.project_name = ?';
    queryParams.push(projectName);
  }

  const query = `
    SELECT 
      COUNT(*) as total_delivered,
      SUM(CASE WHEN LOWER(b.platform_type) LIKE '%prb%' THEN 1 ELSE 0 END) as prb_delivered,
      SUM(CASE WHEN LOWER(b.platform_type) LIKE '%vrb%' THEN 1 ELSE 0 END) as vrb_delivered,
      MIN(mb.delivery_date) as first_delivery,
      MAX(mb.delivery_date) as last_delivery
    FROM builds b
    INNER JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
    ${whereClause}
  `;

  db.query(query, queryParams, (err, results) => {
    if (err) {
      return res.status(500).json({ 
        error: 'Failed to fetch delivery summary',
        details: err.message 
      });
    }

    const summary = results[0] || {
      total_delivered: 0,
      prb_delivered: 0,
      vrb_delivered: 0,
      first_delivery: null,
      last_delivery: null
    };

    res.json({ summary });
  });
};

*/
const getDeliverySummary = (req, res) => {
  const db = req.app.get('db');
  const { projectName, startDate, endDate } = req.query;

  // Default to last 12 weeks if no date range specified
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - (12 * 7));

  const queryStartDate = startDate || defaultStartDate.toISOString().split('T')[0];
  const queryEndDate = endDate || defaultEndDate.toISOString().split('T')[0];

  // Function to fetch project ID if projectName is specified
  const fetchProjectId = (callback) => {
    if (projectName && projectName !== 'all') {
      db.query('SELECT id FROM project_name WHERE project_name = ?', [projectName], (err, rows) => {
        if (err) return callback(err);
        if (rows.length === 0) return callback(new Error('Project not found'));
        callback(null, rows[0].id); // only one row expected
      });
    } else {
      callback(null, null); // no project filter
    }
  };

  fetchProjectId((err, projectId) => {
    if (err) {
      return res.status(500).json({
        error: 'Failed to fetch project id',
        details: err.message
      });
    }

    // Build the WHERE clause with optional project filter
    let whereClause = `
      WHERE mb.master_status = 'Delivered'
        AND mb.delivery_date IS NOT NULL
        AND mb.delivery_date BETWEEN ? AND ?
    `;
    const queryParams = [queryStartDate, queryEndDate];

    if (projectId) {
      whereClause += ' AND b.project_name = ?';
      queryParams.push(projectId); // use the project ID
    }

    const query = `
      SELECT 
        COUNT(*) as total_delivered,
        SUM(CASE WHEN LOWER(b.platform_type) LIKE '%prb%' THEN 1 ELSE 0 END) as prb_delivered,
        SUM(CASE WHEN LOWER(b.platform_type) LIKE '%vrb%' THEN 1 ELSE 0 END) as vrb_delivered,
        MIN(mb.delivery_date) as first_delivery,
        MAX(mb.delivery_date) as last_delivery
      FROM builds b
      INNER JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
      ${whereClause}
    `;

    db.query(query, queryParams, (err, results) => {
      if (err) {
        return res.status(500).json({
          error: 'Failed to fetch delivery summary',
          details: err.message
        });
      }

      const summary = results[0] || {
        total_delivered: 0,
        prb_delivered: 0,
        vrb_delivered: 0,
        first_delivery: null,
        last_delivery: null
      };

      res.json({ summary });
    });
  });
};

/**
 * GET /api/dashboard/location-allocation (latest)
 * 
 * Get real-time location allocation data showing delivery quantities by location and team/security
 * Clusters locations by ignoring text after ':' in location names
 * 
 * @query {string} startDate - Start date for data range (optional, defaults to current date - 3 months)  
 * @query {string} endDate - End date for data range (optional, defaults to current date)
 * 
 * @returns {object} - Real-time chart data from database
 */

/*
const getLocationAllocationData = (req, res) => {
  const db = req.app.get('db');
  const { startDate, endDate, projectName, prbSubcategories, vrbSubcategories } = req.query;

  // Default to last 3 months if no date range specified
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setMonth(defaultStartDate.getMonth() - 3);

  const queryStartDate = startDate || defaultStartDate.toISOString().split('T')[0];
  const queryEndDate = endDate || defaultEndDate.toISOString().split('T')[0];

  // SQL query that clusters locations by ignoring text after ':' and separates by platform type and subcategory
  let query = `
    SELECT
      CASE
        WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
        ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
      END as clustered_location,
      mb.team_security,
      CASE
        WHEN LOWER(b.platform_type) LIKE '%prb%' THEN 'PRB'
        WHEN LOWER(b.platform_type) LIKE '%vrb%' THEN 'VRB'
        ELSE 'Other'
      END as platform_category,
      CASE
        WHEN LOWER(b.platform_type) LIKE '%1p%' THEN '1P'
        WHEN LOWER(b.platform_type) LIKE '%2p%' THEN '2P'
        ELSE 'Others'
      END as platform_subcategory,
      COUNT(*) as quantity
    FROM master_builds mb
    INNER JOIN builds b ON mb.chassis_sn = b.chassis_sn
    WHERE mb.master_status = 'Delivered'
      AND mb.delivery_date IS NOT NULL
      AND mb.delivery_date BETWEEN ? AND ?
      AND mb.location IS NOT NULL
      AND mb.location != ''
      AND (
        LOWER(b.platform_type) LIKE '%prb%'
        OR LOWER(b.platform_type) LIKE '%vrb%'
      )
  `;

  const queryParams = [queryStartDate, queryEndDate];

  // Filter by project
  if (projectName && projectName !== 'all') {
    query += ' AND b.project_name = ?';
    queryParams.push(projectName);
  }

  // Filter by subcategories if provided
  /*
  Keep the row if ANY of these are true:

    This row is NOT a PRB

    OR it is PRB 1P

    OR it is PRB 2P
*/
/*
  if (prbSubcategories) {
    const prbList = prbSubcategories.split(',').map(s => s.trim().toLowerCase());
    query += ` AND (NOT LOWER(b.platform_type) LIKE '%prb%' OR LOWER(b.platform_type) LIKE '%${prbList.join("%' OR LOWER(b.platform_type) LIKE '%")}%' )`;
  }
  if (vrbSubcategories) {
    const vrbList = vrbSubcategories.split(',').map(s => s.trim().toLowerCase());
    query += ` AND (NOT LOWER(b.platform_type) LIKE '%vrb%' OR LOWER(b.platform_type) LIKE '%${vrbList.join("%' OR LOWER(b.platform_type) LIKE '%")}%' )`;
  }

  query += `
    GROUP BY
      CASE
        WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
        ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
      END,
      mb.team_security,
      platform_category,
      platform_subcategory
    ORDER BY clustered_location, mb.team_security, platform_category, platform_subcategory
  `;

  // Query to get original locations for each cluster (unchanged)
  let clusterQuery = `
    SELECT DISTINCT
      mb.location as original_location,
      CASE
        WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
        ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
      END as clustered_location
    FROM master_builds mb
    INNER JOIN builds b ON mb.chassis_sn = b.chassis_sn
    WHERE mb.master_status = 'Delivered'
      AND mb.delivery_date IS NOT NULL
      AND mb.delivery_date BETWEEN ? AND ?
      AND mb.location IS NOT NULL
      AND mb.location != ''
  `;

  if (projectName && projectName !== 'all') {
    clusterQuery += ' AND b.project_name = ?';
  }

  clusterQuery += `
    ORDER BY clustered_location, mb.location
  `;

  // Execute both queries
  db.query(query, queryParams, (err, deliveryResults) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({
        error: 'Failed to fetch location allocation data',
        details: err.message
      });
    }

    db.query(clusterQuery, queryParams, (err, clusterResults) => {
      if (err) {
        return res.status(500).json({ 
          error: 'Failed to fetch location cluster data',
          details: err.message 
        });
      }

      // === Processing logic stays the same as your original code ===
      const prbLocationMap = new Map();
      const vrbLocationMap = new Map();
      const clusterToOriginalMap = new Map();
      const teamColorMap = new Map();
      const colors = [
        '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4',
        '#84CC16', '#F97316', '#EC4899', '#14B8A6', '#A855F7', '#6366F1'
      ];
      let colorIndex = 0;

      clusterResults.forEach(row => {
        const clusteredLocation = row.clustered_location;
        if (!clusterToOriginalMap.has(clusteredLocation)) {
          clusterToOriginalMap.set(clusteredLocation, []);
        }
        if (!clusterToOriginalMap.get(clusteredLocation).includes(row.original_location)) {
          clusterToOriginalMap.get(clusteredLocation).push(row.original_location);
        }
      });

      deliveryResults.forEach(row => {
        const location = row.clustered_location;
        const team = row.team_security || 'Unassigned';
        const quantity = parseInt(row.quantity) || 0;
        const platformCategory = row.platform_category;
        const platformSubcategory = row.platform_subcategory;

        const locationMap = platformCategory === 'PRB' ? prbLocationMap : vrbLocationMap;

        if (!locationMap.has(location)) {
          locationMap.set(location, {
            location,
            clusters: clusterToOriginalMap.get(location) || [location],
            teams: new Map(),
            subcategories: new Map(),
            totalQuantity: 0
          });
        }

        const locationData = locationMap.get(location);

        if (!locationData.subcategories.has(platformSubcategory)) {
          locationData.subcategories.set(platformSubcategory, {
            subcategory: platformSubcategory,
            teams: new Map(),
            totalQuantity: 0
          });
        }

        const subcategoryData = locationData.subcategories.get(platformSubcategory);

        if (!locationData.teams.has(team)) {
          if (!teamColorMap.has(team)) {
            teamColorMap.set(team, colors[colorIndex % colors.length]);
            colorIndex++;
          }

          locationData.teams.set(team, {
            team,
            quantity: 0,
            color: teamColorMap.get(team)
          });
        }

        if (!subcategoryData.teams.has(team)) {
          subcategoryData.teams.set(team, {
            team,
            quantity: 0,
            color: teamColorMap.get(team)
          });
        }

        locationData.teams.get(team).quantity += quantity;
        subcategoryData.teams.get(team).quantity += quantity;
        locationData.totalQuantity += quantity;
        subcategoryData.totalQuantity += quantity;
      });

      const convertToChartData = (locationMap) => {
        return Array.from(locationMap.values()).map(locationData => ({
          location: locationData.location,
          clusters: locationData.clusters,
          teams: Array.from(locationData.teams.values()).sort((a, b) => b.quantity - a.quantity),
          totalQuantity: locationData.totalQuantity,
          subcategories: Array.from(locationData.subcategories.values()).map(subcat => ({
            subcategory: subcat.subcategory,
            teams: Array.from(subcat.teams.values()).sort((a, b) => b.quantity - a.quantity),
            totalQuantity: subcat.totalQuantity
          })).sort((a, b) => b.totalQuantity - a.totalQuantity)
        })).sort((a, b) => b.totalQuantity - a.totalQuantity);
      };

      const prbChartData = convertToChartData(prbLocationMap);
      const vrbChartData = convertToChartData(vrbLocationMap);

      const prbTotalDelivered = prbChartData.reduce((sum, location) => sum + location.totalQuantity, 0);
      const vrbTotalDelivered = vrbChartData.reduce((sum, location) => sum + location.totalQuantity, 0);

      const finalResponse = {
        PRB: {
          chartData: prbChartData,
          totalDelivered: prbTotalDelivered
        },
        VRB: {
          chartData: vrbChartData,
          totalDelivered: vrbTotalDelivered
        },
        dateRange: {
          startDate: queryStartDate,
          endDate: queryEndDate
        }
      };

      res.json(finalResponse);
    });
  });
};

*/

const getLocationAllocationData = (req, res) => {
  const db = req.app.get('db');
  const { startDate, endDate, projectName, prbSubcategories, vrbSubcategories } = req.query;

  // Default to last 3 months if no date range specified
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setMonth(defaultStartDate.getMonth() - 3);

  const queryStartDate = startDate || defaultStartDate.toISOString().split('T')[0];
  const queryEndDate = endDate || defaultEndDate.toISOString().split('T')[0];

  // Function to fetch project ID if projectName is specified
  const fetchProjectId = (callback) => {
    if (projectName && projectName !== 'all') {
      db.query('SELECT id FROM project_name WHERE project_name = ?', [projectName], (err, rows) => {
        if (err) return callback(err);
        if (rows.length === 0) return callback(new Error('Project not found'));
        callback(null, rows[0].id); // only one row expected
      });
    } else {
      callback(null, null); // no project filter
    }
  };

  fetchProjectId((err, projectId) => {
    if (err) {
      return res.status(500).json({
        error: 'Failed to fetch project id',
        details: err.message
      });
    }

    // SQL query that clusters locations by ignoring text after ':' and separates by platform type and subcategory
    let query = `
      SELECT
        CASE
          WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
          ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
        END as clustered_location,
        mb.team_security,
        CASE
          WHEN LOWER(b.platform_type) LIKE '%prb%' THEN 'PRB'
          WHEN LOWER(b.platform_type) LIKE '%vrb%' THEN 'VRB'
          ELSE 'Other'
        END as platform_category,
        CASE
          WHEN LOWER(b.platform_type) LIKE '%1p%' THEN '1P'
          WHEN LOWER(b.platform_type) LIKE '%2p%' THEN '2P'
          ELSE 'Others'
        END as platform_subcategory,
        COUNT(*) as quantity
      FROM master_builds mb
      INNER JOIN builds b ON mb.chassis_sn = b.chassis_sn
      WHERE mb.master_status = 'Delivered'
        AND mb.delivery_date IS NOT NULL
        AND mb.delivery_date BETWEEN ? AND ?
        AND mb.location IS NOT NULL
        AND mb.location != ''
        AND (
          LOWER(b.platform_type) LIKE '%prb%'
          OR LOWER(b.platform_type) LIKE '%vrb%'
        )
    `;

    const queryParams = [queryStartDate, queryEndDate];

    // Filter by project ID
    if (projectId) {
      query += ' AND b.project_name = ?';
      queryParams.push(projectId);
    }

    // Filter by PRB subcategories
    if (prbSubcategories) {
      const prbList = prbSubcategories.split(',').map(s => s.trim().toLowerCase());
      query += ` AND (NOT LOWER(b.platform_type) LIKE '%prb%' OR LOWER(b.platform_type) LIKE '%${prbList.join("%' OR LOWER(b.platform_type) LIKE '%")}%' )`;
    }

    // Filter by VRB subcategories
    if (vrbSubcategories) {
      const vrbList = vrbSubcategories.split(',').map(s => s.trim().toLowerCase());
      query += ` AND (NOT LOWER(b.platform_type) LIKE '%vrb%' OR LOWER(b.platform_type) LIKE '%${vrbList.join("%' OR LOWER(b.platform_type) LIKE '%")}%' )`;
    }

    query += `
      GROUP BY
        CASE
          WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
          ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
        END,
        mb.team_security,
        platform_category,
        platform_subcategory
      ORDER BY clustered_location, mb.team_security, platform_category, platform_subcategory
    `;

    // Query to get original locations for each cluster
    let clusterQuery = `
      SELECT DISTINCT
        mb.location as original_location,
        CASE
          WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
          ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
        END as clustered_location
      FROM master_builds mb
      INNER JOIN builds b ON mb.chassis_sn = b.chassis_sn
      WHERE mb.master_status = 'Delivered'
        AND mb.delivery_date IS NOT NULL
        AND mb.delivery_date BETWEEN ? AND ?
        AND mb.location IS NOT NULL
        AND mb.location != ''
    `;

    const clusterQueryParams = [queryStartDate, queryEndDate];
    if (projectId) {
      clusterQuery += ' AND b.project_name = ?';
      clusterQueryParams.push(projectId);
    }

    clusterQuery += `
      ORDER BY clustered_location, mb.location
    `;

    // Execute both queries
    db.query(query, queryParams, (err, deliveryResults) => {
      if (err) {
        return res.status(500).json({
          error: 'Failed to fetch location allocation data',
          details: err.message
        });
      }

      db.query(clusterQuery, clusterQueryParams, (err, clusterResults) => {
        if (err) {
          return res.status(500).json({
            error: 'Failed to fetch cluster locations',
            details: err.message
          });
        }
        // === Processing logic stays the same as your original code ===
      const prbLocationMap = new Map();
      const vrbLocationMap = new Map();
      const clusterToOriginalMap = new Map();
      const teamColorMap = new Map();
      const colors = [
        '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4',
        '#84CC16', '#F97316', '#EC4899', '#14B8A6', '#A855F7', '#6366F1'
      ];
      let colorIndex = 0;

      clusterResults.forEach(row => {
        const clusteredLocation = row.clustered_location;
        if (!clusterToOriginalMap.has(clusteredLocation)) {
          clusterToOriginalMap.set(clusteredLocation, []);
        }
        if (!clusterToOriginalMap.get(clusteredLocation).includes(row.original_location)) {
          clusterToOriginalMap.get(clusteredLocation).push(row.original_location);
        }
      });

      deliveryResults.forEach(row => {
        const location = row.clustered_location;
        const team = row.team_security || 'Unassigned';
        const quantity = parseInt(row.quantity) || 0;
        const platformCategory = row.platform_category;
        const platformSubcategory = row.platform_subcategory;

        const locationMap = platformCategory === 'PRB' ? prbLocationMap : vrbLocationMap;

        if (!locationMap.has(location)) {
          locationMap.set(location, {
            location,
            clusters: clusterToOriginalMap.get(location) || [location],
            teams: new Map(),
            subcategories: new Map(),
            totalQuantity: 0
          });
        }

        const locationData = locationMap.get(location);

        if (!locationData.subcategories.has(platformSubcategory)) {
          locationData.subcategories.set(platformSubcategory, {
            subcategory: platformSubcategory,
            teams: new Map(),
            totalQuantity: 0
          });
        }

        const subcategoryData = locationData.subcategories.get(platformSubcategory);

        if (!locationData.teams.has(team)) {
          if (!teamColorMap.has(team)) {
            teamColorMap.set(team, colors[colorIndex % colors.length]);
            colorIndex++;
          }

          locationData.teams.set(team, {
            team,
            quantity: 0,
            color: teamColorMap.get(team)
          });
        }

        if (!subcategoryData.teams.has(team)) {
          subcategoryData.teams.set(team, {
            team,
            quantity: 0,
            color: teamColorMap.get(team)
          });
        }

        locationData.teams.get(team).quantity += quantity;
        subcategoryData.teams.get(team).quantity += quantity;
        locationData.totalQuantity += quantity;
        subcategoryData.totalQuantity += quantity;
      });

      const convertToChartData = (locationMap) => {
        return Array.from(locationMap.values()).map(locationData => ({
          location: locationData.location,
          clusters: locationData.clusters,
          teams: Array.from(locationData.teams.values()).sort((a, b) => b.quantity - a.quantity),
          totalQuantity: locationData.totalQuantity,
          subcategories: Array.from(locationData.subcategories.values()).map(subcat => ({
            subcategory: subcat.subcategory,
            teams: Array.from(subcat.teams.values()).sort((a, b) => b.quantity - a.quantity),
            totalQuantity: subcat.totalQuantity
          })).sort((a, b) => b.totalQuantity - a.totalQuantity)
        })).sort((a, b) => b.totalQuantity - a.totalQuantity);
      };

      const prbChartData = convertToChartData(prbLocationMap);
      const vrbChartData = convertToChartData(vrbLocationMap);

      const prbTotalDelivered = prbChartData.reduce((sum, location) => sum + location.totalQuantity, 0);
      const vrbTotalDelivered = vrbChartData.reduce((sum, location) => sum + location.totalQuantity, 0);

      const finalResponse = {
        PRB: {
          chartData: prbChartData,
          totalDelivered: prbTotalDelivered
        },
        VRB: {
          chartData: vrbChartData,
          totalDelivered: vrbTotalDelivered
        },
        dateRange: {
          startDate: queryStartDate,
          endDate: queryEndDate
        }
      };

      res.json(finalResponse);

        
      });
    });
  });
};
/*
const getLocationAllocationData = (req, res) => {
  const db = req.app.get('db');
  const { startDate, endDate, projectName } = req.query;

  // Default to last 3 months if no date range specified
  const defaultEndDate = new Date();
  const defaultStartDate = new Date();
  defaultStartDate.setMonth(defaultStartDate.getMonth() - 3);

  const queryStartDate = startDate || defaultStartDate.toISOString().split('T')[0];
  const queryEndDate = endDate || defaultEndDate.toISOString().split('T')[0];

  // SQL query that clusters locations by ignoring text after ':' and separates by platform type and subcategory
  const query = `
    SELECT
      CASE
        WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
        ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
      END as clustered_location,
      mb.team_security,
      CASE
        WHEN LOWER(b.platform_type) LIKE '%prb%' THEN 'PRB'
        WHEN LOWER(b.platform_type) LIKE '%vrb%' THEN 'VRB'
        ELSE 'Other'
      END as platform_category,
      CASE
        WHEN LOWER(b.platform_type) LIKE '%1p%' THEN '1P'
        WHEN LOWER(b.platform_type) LIKE '%2p%' THEN '2P'
        ELSE 'Others'
      END as platform_subcategory,
      COUNT(*) as quantity
    FROM master_builds mb
    INNER JOIN builds b ON mb.chassis_sn = b.chassis_sn
    WHERE mb.master_status = 'Delivered'
      AND mb.delivery_date IS NOT NULL
      AND mb.delivery_date BETWEEN ? AND ?
      AND mb.location IS NOT NULL
      AND mb.location != ''
      AND (
        LOWER(b.platform_type) LIKE '%prb%'
        OR LOWER(b.platform_type) LIKE '%vrb%'
      )`;

  // Add project filter if specified
  let whereClauseAddition = '';
  const queryParams = [queryStartDate, queryEndDate];

  if (projectName && projectName !== 'all') {
    whereClauseAddition = ' AND b.project_name = ?';
    queryParams.push(projectName);
  }

  const finalQuery = query + whereClauseAddition + `
    GROUP BY
      CASE
        WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
        ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
      END,
      mb.team_security,
      platform_category,
      platform_subcategory
    ORDER BY clustered_location, mb.team_security, platform_category, platform_subcategory
  `;

  // Query to get original locations for each cluster
  const clusterQuery = `
    SELECT DISTINCT
      mb.location as original_location,
      CASE
        WHEN mb.location LIKE 'B800.%' THEN 'MetCenter'
        ELSE TRIM(SUBSTRING_INDEX(mb.location, ':', 1))
      END as clustered_location
    FROM master_builds mb
    INNER JOIN builds b ON mb.chassis_sn = b.chassis_sn
    WHERE mb.master_status = 'Delivered'
      AND mb.delivery_date IS NOT NULL
      AND mb.delivery_date BETWEEN ? AND ?
      AND mb.location IS NOT NULL
      AND mb.location != ''` + whereClauseAddition + `
    ORDER BY clustered_location, mb.location
  `;

  // Execute both queries
  console.log('Executing location allocation query:', finalQuery);
  console.log('Query parameters:', queryParams);

  db.query(finalQuery, queryParams, (err, deliveryResults) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({
        error: 'Failed to fetch location allocation data',
        details: err.message
      });
    }

    console.log('Delivery query results:', deliveryResults);

    db.query(clusterQuery, queryParams, (err, clusterResults) => {
      if (err) {
        return res.status(500).json({ 
          error: 'Failed to fetch location cluster data',
          details: err.message 
        });
      }

      // Process results into chart format, separated by platform type
      const prbLocationMap = new Map();
      const vrbLocationMap = new Map();
      const clusterToOriginalMap = new Map();
      const teamColorMap = new Map();
      const colors = [
        '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4',
        '#84CC16', '#F97316', '#EC4899', '#14B8A6', '#A855F7', '#6366F1'
      ];
      let colorIndex = 0;

      // Build cluster mapping from second query
      clusterResults.forEach(row => {
        const clusteredLocation = row.clustered_location;
        if (!clusterToOriginalMap.has(clusteredLocation)) {
          clusterToOriginalMap.set(clusteredLocation, []);
        }
        if (!clusterToOriginalMap.get(clusteredLocation).includes(row.original_location)) {
          clusterToOriginalMap.get(clusteredLocation).push(row.original_location);
        }
      });

      // Process delivery results, separating by platform type and subcategory
      deliveryResults.forEach(row => {
        const location = row.clustered_location;
        const team = row.team_security || 'Unassigned';
        const quantity = parseInt(row.quantity) || 0;
        const platformCategory = row.platform_category;
        const platformSubcategory = row.platform_subcategory;

        // Choose the appropriate location map based on platform type
        const locationMap = platformCategory === 'PRB' ? prbLocationMap : vrbLocationMap;

        if (!locationMap.has(location)) {
          locationMap.set(location, {
            location,
            clusters: clusterToOriginalMap.get(location) || [location],
            teams: new Map(),
            subcategories: new Map(), // Track subcategory data
            totalQuantity: 0
          });
        }

        const locationData = locationMap.get(location);

        // Initialize subcategory if not exists
        if (!locationData.subcategories.has(platformSubcategory)) {
          locationData.subcategories.set(platformSubcategory, {
            subcategory: platformSubcategory,
            teams: new Map(),
            totalQuantity: 0
          });
        }

        const subcategoryData = locationData.subcategories.get(platformSubcategory);

        // Handle team data at location level (for overall chart)
        if (!locationData.teams.has(team)) {
          if (!teamColorMap.has(team)) {
            teamColorMap.set(team, colors[colorIndex % colors.length]);
            colorIndex++;
          }

          locationData.teams.set(team, {
            team,
            quantity: 0,
            color: teamColorMap.get(team)
          });
        }

        // Handle team data at subcategory level
        if (!subcategoryData.teams.has(team)) {
          subcategoryData.teams.set(team, {
            team,
            quantity: 0,
            color: teamColorMap.get(team)
          });
        }

        // Update quantities
        locationData.teams.get(team).quantity += quantity;
        subcategoryData.teams.get(team).quantity += quantity;
        locationData.totalQuantity += quantity;
        subcategoryData.totalQuantity += quantity;
      });

      // Helper function to convert location map to chart data format
      const convertToChartData = (locationMap) => {
        return Array.from(locationMap.values()).map(locationData => ({
          location: locationData.location,
          clusters: locationData.clusters,
          teams: Array.from(locationData.teams.values()).sort((a, b) => b.quantity - a.quantity),
          totalQuantity: locationData.totalQuantity,
          subcategories: Array.from(locationData.subcategories.values()).map(subcat => ({
            subcategory: subcat.subcategory,
            teams: Array.from(subcat.teams.values()).sort((a, b) => b.quantity - a.quantity),
            totalQuantity: subcat.totalQuantity
          })).sort((a, b) => b.totalQuantity - a.totalQuantity)
        })).sort((a, b) => b.totalQuantity - a.totalQuantity);
      };

      // Convert both maps to chart data format
      const prbChartData = convertToChartData(prbLocationMap);
      const vrbChartData = convertToChartData(vrbLocationMap);

      const prbTotalDelivered = prbChartData.reduce((sum, location) => sum + location.totalQuantity, 0);
      const vrbTotalDelivered = vrbChartData.reduce((sum, location) => sum + location.totalQuantity, 0);

      const finalResponse = {
        PRB: {
          chartData: prbChartData,
          totalDelivered: prbTotalDelivered
        },
        VRB: {
          chartData: vrbChartData,
          totalDelivered: vrbTotalDelivered
        },
        dateRange: {
          startDate: queryStartDate,
          endDate: queryEndDate
        }
      };

      console.log('Final location allocation response:', JSON.stringify(finalResponse, null, 2));
      res.json(finalResponse);
    });
  });
};


*/

// Export route handlers
module.exports = {
  getProjects,
  getWeeklyDeliveryData,
  getDeliverySummary,
  getLocationAllocationData,
};


