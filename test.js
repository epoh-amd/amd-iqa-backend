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