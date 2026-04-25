// backend/server.js (updated)
// important pls note that. The server.js is actually separate folder at backend, in order to perform AI, i add that file here.
/**
 * AMD Smart Hand Backend Server
 * 
 * This Express.js server provides API endpoints for the AMD Smart Hand application,
 * which manages system builds, BKC details, quality indicators, and customer escalations.
 * 
 * Main Features:
 * - StartBuild: Multi-step build creation and management
 * - BKC Management: Firmware version extraction and storage
 * - Quality Indicators: FPY tracking and failure management
 * - Rework System: Component replacement tracking
 * - Customer Escalations: External customer issue management
 * 
 * Database: MySQL with connection pooling
 * File Storage: Local filesystem with multer
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();
const { extractBMCFirmwareVersions } = require('./firmwareExtractor');
const { executeQueryCallback, testConnection, setGlobalPool } = require('./utils/database');
const { getProjects, getWeeklyDeliveryData, getDeliverySummary, getLocationAllocationData, getLocationAllocationDataWithSubcategories } = require('./dashboardRoutes');
const { generateTicketIdSafeAlt, validateTicketId } = require('./utils/ticketGenerator');
const { ensureDbConnection, addDbInfo, handleDatabaseErrors } = require('./middleware/database');
const {
  generateWeeklyDates,
  autoCalculateMilestoneDates,
  ensurePorTargetsSize,
  validateConfiguration,
  convertPorTargetsToWeeklyObject,
  convertWeeklyObjectToPorTargets
} = require('./utils/dashboardUtils');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const passport = require('passport');
const { generatePieChartBase64, generateBarChartBase64, generateWeeklyChart, generateLocationAllocationChartBase64, generateLocationAllocationChartBase64NonStacked, generateBuildDeliveryChartBase64 } = require('./utils/generateCharts');
const { setupOktaAuth } = require('./middleware/auth');
const axios = require('axios');
const app = express();

// ============================================================================
// PRODUCTION MIDDLEWARE SETUP
// ============================================================================

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:", "*"], // Allow images from any origin for image proxy
      connectSrc: ["'self'"]
    }
  }
}));

// Compression middleware
app.use(compression());

// CORS middleware - Production configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000']; // Fallback for development

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow credentials for authentication
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar'],
  optionsSuccessStatus: 200 // For legacy browser support
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Additional global CORS middleware to ensure all responses have permissive headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  next();
});

// Trust proxy (needed for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// ============================================================================
// STATIC FILE SERVING (for non-sudo deployments without Nginx)
// ============================================================================

// Serve React build files when in production and no reverse proxy
if (process.env.NODE_ENV === 'production' && !process.env.USE_REVERSE_PROXY) {
  const path = require('path');
  const buildPath = path.join(__dirname, '../amd-smart-hand-process/build');

  console.log('🗂️  Serving static files from:', buildPath);

  // Serve static files with proper caching
  app.use(express.static(buildPath, {
    maxAge: '1y', // Cache static assets for 1 year
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
      // Set cache headers based on file type
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
}

// ============================================================================
// DATABASE CONNECTION WITH CONNECTION POOL
// ============================================================================

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'iqadb01',    //amd_smart_hand
  port: process.env.DB_PORT || 3306,

  // Optimized connection pool settings for 100-200 concurrent users
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 50, // Increased from 10
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT) || 200,         // Increased from 0
  acquireTimeout: parseInt(process.env.DB_ACQUIRE_TIMEOUT) || 30000, // 30 seconds
  timeout: parseInt(process.env.DB_TIMEOUT) || 60000,               // 60 seconds
  idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT) || 600000,     // 10 minutes

  // Keep alive settings to prevent timeout
  keepAliveInitialDelay: 0,
  enableKeepAlive: true, // Always enabled for production

  // Performance optimizations
  charset: 'utf8mb4',
  timezone: 'Z',
  multipleStatements: false,        // Security
  reconnect: true,                  // Auto-reconnect

  // Connection optimization
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: false
  } : false
};

// Create connection pool with promise support
const db = mysql.createPool(dbConfig);

// Set the global pool for the database utilities
setGlobalPool(db);

// MySQL2 already provides promise support - no need to override

// Test initial connection
db.getConnection((err, connection) => {
  if (err) {
    console.error('Error connecting to database:', err);
    console.error('Database config:', { ...dbConfig, password: '***' });
    process.exit(1);
  }
  console.log(`Connected to MySQL database: ${dbConfig.database} at ${dbConfig.host}`);
  console.log(`Connection pool created with limit: ${dbConfig.connectionLimit}`);

  // Release the test connection back to pool
  connection.release();
});

// ============================================================================
// AUTHENTICATION & SESSION SETUP
// ============================================================================

const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000, // 15 minutes
  expiration: 86400000, // 24 hours
}, db);

// Configure session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport.js
app.use(passport.initialize());
app.use(passport.session());

// Setup Okta OIDC authentication
setupOktaAuth();

// Store database connection for profile routes
app.set('db', db);
global.db = db;

// ============================================================================
// PERFORMANCE MONITORING MIDDLEWARE
// ============================================================================


// ============================================================================
// PROFILE AND AUTH ROUTES
// ============================================================================

const profileRoutes = require('./routes/profile');
app.use('/api/profile', profileRoutes);

// ============================================================================
// OFFLINE UPLOAD ROUTES
// ============================================================================

const offlineUploadRoutes = require('./routes/offlineUpload');
app.use('/api/offline', offlineUploadRoutes);

// ============================================================================
// SYSTEM HEALTH ENDPOINT
// ============================================================================

// System health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ============================================================================
// PROTECTED ROUTE EXAMPLE
// ============================================================================

/**
 * GET /api/protected
 * 
 * Example of a protected route that requires authentication
 */
app.get('/api/protected', (req, res) => {
  // Check if the user is authenticated
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ message: 'This is a protected route', user: req.user });
});

// ============================================================================
// FILE UPLOAD CONFIGURATION
// ============================================================================

/**
 * Create upload directories if they don't exist
 * Directory structure:
 * - uploads/visual_inspection: Visual inspection photos
 * - uploads/boot: Boot test photos  
 * - uploads/dimms_detected: DIMM detection photos
 * - uploads/lom_working: LOM working photos
 * - uploads/rework: Rework process photos
 * - uploads/escalations: Customer escalation files
 */
const uploadDirs = [
  'uploads',
  'uploads/visual_inspection',
  'uploads/boot',
  'uploads/dimms_detected',
  'uploads/lom_working',
  'uploads/rework',
  'uploads/escalations'
];

uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Multer configuration for file uploads
 * - Organizes files by type into appropriate folders
 * - Generates unique filenames to prevent conflicts
 * - 10MB file size limit
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Configure multer for escalation file uploads
const escalationStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads', 'escalations');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitizedFilename}`);
  }
});

const escalationUpload = multer({
  storage: escalationStorage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit for escalation files
  },
  fileFilter: (req, file, cb) => {
    // Accept all file types for escalation uploads
    cb(null, true);
  }
});

// Serve static files from the escalations directory
app.use('/uploads/escalations', express.static(path.join(__dirname, 'uploads', 'escalations')));

// Serve static files from the uploads directory
app.use('/uploads', (req, res, next) => {
  // Set CORS headers for static files
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  res.header('Cross-Origin-Embedder-Policy', 'unsafe-none');

  const filePath = path.join(__dirname, 'uploads', req.path);

  console.log('Static file request:', {
    requestPath: req.path,
    fullPath: filePath,
    exists: fs.existsSync(filePath)
  });

  if (!fs.existsSync(filePath)) {
    console.log('Static file not found:', filePath);
    return res.status(404).json({ error: 'File not found' });
  }

  next();
}, express.static(path.join(__dirname, 'uploads')));

// ============================================================================
// IMAGE PROXY ENDPOINT - Fix CORS issues for image loading
// ============================================================================

/**
 * Helper function to build timeline tree structure
 * Creates parent-child relationships for timeline entries
 * 
 * @param {Array} timeline - Flat array of timeline entries
 * @returns {Array} - Hierarchical timeline structure
 */
function buildTimelineTree(timeline) {
  const timelineMap = new Map();
  const rootItems = [];

  timeline.forEach(item => {
    timelineMap.set(item.id, { ...item, children: [] });
  });

  timeline.forEach(item => {
    if (item.parent_timeline_id) {
      const parent = timelineMap.get(item.parent_timeline_id);
      if (parent) {
        parent.children.push(timelineMap.get(item.id));
      }
    } else {
      rootItems.push(timelineMap.get(item.id));
    }
  });

  return rootItems;
}

/**
 * OPTIONS /api/image-proxy
 * Handle CORS preflight requests for image proxy
 */
app.options('/api/image-proxy', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Max-Age', '86400');
  res.status(200).end();
});

/**
 * GET /api/image-proxy
 * 
 * Enhanced proxy endpoint for serving images with proper CORS headers
 * Handles client disconnections and network errors gracefully
 * Solves CORS issues when frontend loads images from different origin
 * 
 * @query {string} path - Relative path to image file
 */
app.get('/api/image-proxy', (req, res) => {
  const imagePath = req.query.path;

  if (!imagePath) {
    return res.status(400).json({ error: 'Image path is required' });
  }

  // Set CORS headers for images
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  res.header('Cross-Origin-Embedder-Policy', 'unsafe-none');

  // Construct full file path
  const fullPath = path.join(__dirname, imagePath);

  console.log('Image proxy request:', {
    requestedPath: imagePath,
    fullPath: fullPath,
    exists: fs.existsSync(fullPath)
  });

  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    console.log('Image not found:', fullPath);
    return res.status(404).json({ error: 'Image not found' });
  }

  // Handle client disconnections gracefully
  req.on('close', () => {
    console.log('Client disconnected during image proxy request');
  });

  req.on('error', (err) => {
    console.log('Request error during image proxy:', err.code);
  });

  res.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
      console.log('Client disconnected during image transfer');
      return;
    }
    console.error('Response error during image proxy:', err);
  });

  try {
    // Set appropriate content type based on file extension
    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    // Add caching headers
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year
    res.setHeader('ETag', `"${fs.statSync(fullPath).mtime.getTime()}"`);

    // Stream the file
    const fileStream = fs.createReadStream(fullPath);

    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read image file' });
      }
    });

    fileStream.pipe(res);

  } catch (error) {
    console.error('Error serving image:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

/**
 * GET /api/photo/:filename
 * 
 * Direct photo access endpoint with CORS headers
 */
app.get('/api/photo/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, 'uploads', filename);

  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  res.header('Cross-Origin-Embedder-Policy', 'unsafe-none');

  console.log('Direct photo access:', {
    filename,
    fullPath: filePath,
    exists: fs.existsSync(filePath)
  });

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  // Set content type
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  };

  res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
  res.sendFile(filePath);
});
// ============================================================================
function getAutoMappedMasterStatus(buildStatus) {
  switch (buildStatus) {
    case 'Complete':
      return 'Build Completed';
    case 'Fail':
      return 'Bad';
    case 'In Progress':
      return 'Incomplete';
    default:
      return null;
  }
}

// ============================================================================
// BUILD FORECAST DASHBOARD API ENDPOINTS
// ============================================================================

/**
 * GET /api/dashboard/projects
 * 
 * Get all unique project names from builds table
 * @returns {array} - Array of unique project names
 */
app.get('/api/dashboard/projects', (req, res) => {
  /*
  const query = `
    SELECT DISTINCT project_name 
    FROM builds 
    WHERE project_name IS NOT NULL 
    ORDER BY project_name
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
      console.error('Error fetching projects:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const projects = results.map(row => row.project_name);
    res.json(projects);
  });
});

const generateBMCName = (platformType, chassisSN) => {
  if (!platformType || !chassisSN) return '';

  const platformName = extractManufacturerPrefix(platformType);
  const lastFourDigits = chassisSN.slice(-4); // or .padStart(4, '0')

  return `${platformName}-${lastFourDigits}`;
};

// Helper: Extract manufacturer prefix
const extractManufacturerPrefix = (platformType) => {
  const specialCases = {
    'Marley-Jamaica': 'Marley-Jamaica'
  };

  for (const [key, value] of Object.entries(specialCases)) {
    if (platformType.includes(key)) {
      return value;
    }
  }

  const matches = platformType.match(/(?::\s*)([A-Z][a-z]{3,})/);
  if (matches && matches[1]) {
    return matches[1];
  }

  const words = platformType.split(/\s+/);
  return words.find(word => word.length > 3) || words[0] || '';
};


// PUT /api/builds/:chassis_sn
app.put('/api/builds/bulk-update', async (req, res) => {
  const { updates } = req.body;

  if (!updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  try {
    const conn = db.promise();

    for (const chassis_sn in updates) {
      const row = updates[chassis_sn];

      const fields = [];
      const values = [];

      let generatedBMC = null;
      let manufacturerName = null;

      // ✅ Only trigger when chassis_sn changes
      if (row.chassis_sn !== undefined && row.chassis_sn !== chassis_sn) {

        // 1. Get existing platform_type
        const [rows] = await conn.execute(
          'SELECT platform_type FROM builds WHERE chassis_sn = ?',
          [chassis_sn]
        );

        const platformType = rows[0]?.platform_type;

        if (platformType) {
          // 2. Generate BMC name
          generatedBMC = generateBMCName(platformType, row.chassis_sn);

          // 3. Extract prefix from BMC name
          const prefix = extractPrefixFromBMC(generatedBMC);

          // 4. Lookup manufacturer
          const [mRows] = await conn.execute(
            'SELECT manufacturer_name FROM manufacturers WHERE platform_prefix = ?',
            [prefix]
          );

          if (mRows.length > 0) {
            manufacturerName = mRows[0].manufacturer_name;
          }
        }
      }

      const allowedFields = [
        'location',
        'system_pn',
        'po',
        'bmc_mac',
        'mb_sn',
        'ethernet_mac',
        'cpu_socket',
        'cpu_vendor',
        'chassis_sn',
        'chassis_type',
        'cpu_p0_sn',
        'cpu_p0_socket_date_code',
        'cpu_p1_sn',
        'cpu_p1_socket_date_code'
      ];

      allowedFields.forEach((field) => {
        if (row[field] !== undefined) {
          fields.push(`${field} = ?`);
          values.push(row[field]);
        }
      });

      // ✅ Update BMC name
      if (generatedBMC) {
        fields.push('bmc_name = ?');
        values.push(generatedBMC);
      }

      // ✅ Update manufacturer
      if (manufacturerName) {
        fields.push('manufacturer = ?');
        values.push(manufacturerName);
      }

      if (fields.length === 0) continue;

      values.push(chassis_sn);

      await conn.execute(
        `UPDATE builds SET ${fields.join(', ')}, updated_at = NOW()
         WHERE chassis_sn = ?`,
        values
      );
    }

    res.json({ success: true });

  } catch (err) {
    console.error('Bulk update error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});


app.get('/api/projects', async (req, res) => {
  const { chassis_sn } = req.query;

  try {
    const [rows] = await db.promise().execute(`
      SELECT p.id, p.project_name
      FROM builds b
      JOIN project_name p ON b.project_name = p.id
      WHERE b.chassis_sn = ?
      LIMIT 1
    `, [chassis_sn]);

    res.json(rows[0] || null);
  } catch (err) {
    console.error('Error fetching project by chassis:', err);
    res.status(500).send('Error fetching project');
  }
});



//http://localhost:5000/api/dashboard/build-data/Weisshorn%20SP7
/**
 * GET /api/dashboard/build-data/:projectName
 * 
 * Get actual build data for a project - CORRECTED VERSION
 * Searches for PRB/VRB keywords within platform_type descriptions
 * 
 * @param {string} projectName - Project name
 * @returns {object} - { PRB: [], VRB: [] } with weekly build counts
 */

/*
app.get('/api/dashboard/build-data/:projectName', (req, res) => {
  const { projectName } = req.params;

  console.log(`Fetching build data for project: ${projectName}`);

  //projectName = 'Weisshorn SP7';

  // Enhanced query to properly detect PRB/VRB and include build data
  // FIXED: Use delivery_date for Dashboard 1 (Weekly Build Delivery Dashboard)
  const query = `
    SELECT
      b.chassis_sn,
      b.platform_type,
      b.system_pn,
      b.project_name,
      DATE(mb.delivery_date) as build_date,
      YEARWEEK(mb.delivery_date, 1) as year_week,
      WEEK(mb.delivery_date, 1) as week_number,
      YEAR(mb.delivery_date) as year,
      mb.delivery_date as created_at,
      mb.master_status,
      CASE
        WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
        WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
        ELSE 'Other'
      END as detected_platform,
      CASE
        WHEN mb.chassis_sn IS NULL THEN 'No Master Record'
        ELSE 'Has Master Record'
      END as master_record_status
    FROM builds b
    INNER JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
    WHERE b.project_name = ?
      AND mb.delivery_date IS NOT NULL
      AND (UPPER(b.platform_type) LIKE '%PRB%' OR UPPER(b.platform_type) LIKE '%VRB%')
    ORDER BY mb.delivery_date ASC
  `;

  db.query(query, [projectName], (err, results) => {
    if (err) {
      console.error('Error fetching build data:', err);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }

    console.log(`Found ${results.length} builds with PRB/VRB in platform_type for project: ${projectName}`);

    // Debug: Log some sample platform_type values
    if (results.length > 0) {
      console.log('Sample platform_type values:');
      results.slice(0, 3).forEach(build => {
        console.log(`- ${build.chassis_sn}: "${build.platform_type}" -> ${build.detected_platform}`);
      });
    }

    // Filter builds based on master status - ONLY include Delivered builds for Dashboard 1
    const relevantBuilds = results.filter(build => {
      return build.master_status === 'Delivered';
    });

    console.log(`Filtered to ${relevantBuilds.length} relevant builds after master status filter`);

    // Group by detected platform and create weekly data structure
    const weeklyData = { PRB: {}, VRB: {} };

    relevantBuilds.forEach(build => {
      const platform = build.detected_platform;
      if (platform !== 'PRB' && platform !== 'VRB') return;

      // Create a consistent week key
      const buildDate = new Date(build.build_date);
      const yearWeek = `${build.year}-W${build.week_number.toString().padStart(2, '0')}`;

      if (!weeklyData[platform][yearWeek]) {
        // Calculate week start date (Monday of that week)
        const jan1 = new Date(build.year, 0, 1);
        const weekStart = new Date(jan1);
        weekStart.setDate(jan1.getDate() + (build.week_number - 1) * 7 - jan1.getDay() + 1);

        weeklyData[platform][yearWeek] = {
          week_number: build.week_number,
          year: build.year,
          week_start: weekStart,
          builds: []
        };
      }

      weeklyData[platform][yearWeek].builds.push(build);
    });

    // Convert to the frontend-expected format
    const processedData = { PRB: [], VRB: [] };

    ['PRB', 'VRB'].forEach(platformType => {
      if (weeklyData[platformType]) {
        // Sort weeks chronologically
        const sortedWeeks = Object.entries(weeklyData[platformType])
          .sort(([a], [b]) => {
            const [yearA, weekA] = a.split('-W').map(Number);
            const [yearB, weekB] = b.split('-W').map(Number);
            if (yearA !== yearB) return yearA - yearB;
            return weekA - weekB;
          });

        sortedWeeks.forEach(([yearWeek, weekData]) => {
          // Format week display string (MM/DD format expected by frontend)
          const weekStart = weekData.week_start;
          const weekFormatted = `${(weekStart.getMonth() + 1).toString().padStart(2, '0')}/${weekStart.getDate().toString().padStart(2, '0')}`;

          processedData[platformType].push({
            week: weekFormatted,
            date: weekStart.toISOString().split('T')[0],
            actualBuilds: weekData.builds.length,
            porTarget: 0, // Will be populated from forecast config by frontend
            buildDetails: weekData.builds.map(b => ({
              chassis_sn: b.chassis_sn,
              platform_type: b.platform_type,
              detected_platform: b.detected_platform,
              master_status: b.master_status,
              created_at: b.created_at
            }))
          });
        });
      }
    });

    // Log summary for debugging
    console.log('==== WEEKLY DATA (Grouped) ====');
    console.log(JSON.stringify(weeklyData, null, 2));


    console.log(`Processed data summary:`, {
      PRB_weeks: processedData.PRB.length,
      VRB_weeks: processedData.VRB.length,
      PRB_total_builds: processedData.PRB.reduce((sum, week) => sum + week.actualBuilds, 0),
      VRB_total_builds: processedData.VRB.reduce((sum, week) => sum + week.actualBuilds, 0)
    });

    // Print each PRB week actualBuilds
    console.log('\n--- PRB Weekly Actual Builds ---');
    processedData.VRB.forEach(week => {
      console.log(`Week: ${week.week} | Actual Builds: ${week.actualBuilds}`);
    });

    //console.log('===== PROCESSED DATA (API RESPONSE) =====');
    //  console.log(JSON.stringify(processedData, null, 2));
    //console.log('========================================');

    res.json(processedData);

  });
});

*/

app.get('/api/dashboard/build-data/:projectName', (req, res) => {
  const db = req.app.get('db');
  const { projectName } = req.params;

  console.log(`Fetching build data for project: ${projectName}`);

  // Step 1: get project id
  const getProjectIdQuery = `
    SELECT id 
    FROM project_name 
    WHERE project_name = ?
  `;

  db.query(getProjectIdQuery, [projectName], (err, projectRows) => {

    if (err) {
      console.error('Error fetching project id:', err);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }

    if (projectRows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectId = projectRows[0].id;

    console.log(`Project ID: ${projectId}`);

    // Step 2: main query
    const query = `
      SELECT
        b.chassis_sn,
        b.platform_type,
        b.system_pn,
        b.project_name,
        DATE(mb.delivery_date) as build_date,
        YEARWEEK(mb.delivery_date, 1) as year_week,
        WEEK(mb.delivery_date, 1) as week_number,
        YEAR(mb.delivery_date) as year,
        mb.delivery_date as created_at,
        mb.master_status,
        CASE
          WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
          WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
          ELSE 'Other'
        END as detected_platform,
        CASE
          WHEN mb.chassis_sn IS NULL THEN 'No Master Record'
          ELSE 'Has Master Record'
        END as master_record_status
      FROM builds b
      INNER JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
      WHERE b.project_name = ?
        AND mb.delivery_date IS NOT NULL
        AND (UPPER(b.platform_type) LIKE '%PRB%' OR UPPER(b.platform_type) LIKE '%VRB%')
      ORDER BY mb.delivery_date ASC
    `;

    db.query(query, [projectId], (err, results) => {

      if (err) {
        console.error('Error fetching build data:', err);
        return res.status(500).json({ error: 'Database error', details: err.message });
      }

      console.log(`Found ${results.length} builds with PRB/VRB for project: ${projectName}`);

      if (results.length > 0) {
        console.log('Sample platform_type values:');
        results.slice(0, 3).forEach(build => {
          console.log(`- ${build.chassis_sn}: "${build.platform_type}" -> ${build.detected_platform}`);
        });
      }

      // Only include Delivered builds
      const relevantBuilds = results.filter(build => build.master_status === 'Delivered');

      console.log(`Filtered to ${relevantBuilds.length} relevant builds`);

      const weeklyData = { PRB: {}, VRB: {} };

      relevantBuilds.forEach(build => {

        const platform = build.detected_platform;
        if (platform !== 'PRB' && platform !== 'VRB') return;

        const buildDate = new Date(build.build_date);
        const yearWeek = `${build.year}-W${build.week_number.toString().padStart(2, '0')}`;

        if (!weeklyData[platform][yearWeek]) {

          const jan1 = new Date(build.year, 0, 1);
          const weekStart = new Date(jan1);
          weekStart.setDate(jan1.getDate() + (build.week_number - 1) * 7 - jan1.getDay() + 1);

          weeklyData[platform][yearWeek] = {
            week_number: build.week_number,
            year: build.year,
            week_start: weekStart,
            builds: []
          };
        }

        weeklyData[platform][yearWeek].builds.push(build);
      });

      const processedData = { PRB: [], VRB: [] };

      ['PRB', 'VRB'].forEach(platformType => {

        const sortedWeeks = Object.entries(weeklyData[platformType] || {})
          .sort(([a], [b]) => {
            const [yearA, weekA] = a.split('-W').map(Number);
            const [yearB, weekB] = b.split('-W').map(Number);
            if (yearA !== yearB) return yearA - yearB;
            return weekA - weekB;
          });

        sortedWeeks.forEach(([yearWeek, weekData]) => {

          const weekStart = weekData.week_start;
          const weekFormatted =
            `${(weekStart.getMonth() + 1).toString().padStart(2, '0')}/${weekStart.getDate().toString().padStart(2, '0')}`;

          processedData[platformType].push({
            week: weekFormatted,
            date: weekStart.toISOString().split('T')[0],
            actualBuilds: weekData.builds.length,
            porTarget: 0,
            buildDetails: weekData.builds.map(b => ({
              chassis_sn: b.chassis_sn,
              platform_type: b.platform_type,
              detected_platform: b.detected_platform,
              master_status: b.master_status,
              created_at: b.created_at
            }))
          });

        });

      });

      res.json(processedData);

    });

  });

});

//http://localhost:5000/api/dashboard/build-data-summary/Weisshorn%20SP7
//convert to formatted json to generate charts
//old version without stackbars
/*
app.get('/api/dashboard/build-data-summary/:projectName', (req, res) => {
  const { projectName } = req.params;

  console.log(`Fetching build summary for project: ${projectName}`);

  const query = `
    SELECT
      b.chassis_sn,   
      b.platform_type,
      b.system_pn,
      b.project_name,
      DATE(mb.delivery_date) as build_date,
      YEARWEEK(mb.delivery_date, 1) as year_week,
      WEEK(mb.delivery_date, 1) as week_number,
      YEAR(mb.delivery_date) as year,
      mb.delivery_date as created_at,
      mb.master_status,
      CASE
        WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
        WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
        ELSE 'Other'
      END as detected_platform
    FROM builds b
    INNER JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
    WHERE b.project_name = ?
      AND mb.delivery_date IS NOT NULL
      AND (UPPER(b.platform_type) LIKE '%PRB%' OR UPPER(b.platform_type) LIKE '%VRB%')
    ORDER BY mb.delivery_date ASC
  `;

  db.query(query, [projectName], (err, results) => {
    if (err) {
      console.error('Error fetching build data:', err);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }

    // Only Delivered builds
    const relevantBuilds = results.filter(build => build.master_status === 'Delivered');

    // Group by platform & week
    const weeklyData = { PRB: {}, VRB: {} };

    relevantBuilds.forEach(build => {
      const platform = build.detected_platform;
      if (platform !== 'PRB' && platform !== 'VRB') return;

      const yearWeek = `${build.year}-W${build.week_number.toString().padStart(2, '0')}`;

      if (!weeklyData[platform][yearWeek]) {
        const jan1 = new Date(build.year, 0, 1);
        const weekStartDate = new Date(jan1);
        weekStartDate.setDate(jan1.getDate() + (build.week_number - 1) * 7 - jan1.getDay() + 1);
        weeklyData[platform][yearWeek] = { week_start: weekStartDate, builds: [] };
      }

      weeklyData[platform][yearWeek].builds.push(build);
    });

    // Convert to weekly + accumulative format
    const data2 = {
      prb: { weekly: [], accumulative: [], weeks: [] },
      vrb: { weekly: [], accumulative: [], weeks: [] }
    };

    const calculateAccumulative = (weeklyArr) => {
      const accum = [];
      weeklyArr.reduce((sum, val) => {
        sum += val;
        accum.push(sum);
        return sum;
      }, 0);
      return accum;
    };

    ['PRB', 'VRB'].forEach(platform => {
      const weeksSorted = Object.entries(weeklyData[platform])
        .sort(([a], [b]) => {
          const [yA, wA] = a.split('-W').map(Number);
          const [yB, wB] = b.split('-W').map(Number);
          return yA !== yB ? yA - yB : wA - wB;
        });

      weeksSorted.forEach(([_, weekData]) => {
        const actualBuilds = weekData.builds.length;
        const weekFormatted = `${(weekData.week_start.getMonth() + 1).toString().padStart(2, '0')}/${weekData.week_start.getDate().toString().padStart(2, '0')}`;

        console.log(weekFormatted);

        if (platform === 'PRB') {
          data2.prb.weekly.push(actualBuilds);
          data2.prb.weeks.push(weekFormatted); // PRB weekly dates
        } else {
          data2.vrb.weekly.push(actualBuilds);
          data2.vrb.weeks.push(weekFormatted); // VRB weekly dates
        }
      });
    });

    data2.prb.accumulative = calculateAccumulative(data2.prb.weekly);
    data2.vrb.accumulative = calculateAccumulative(data2.vrb.weekly);

    res.json(data2);

  });
});

*/
app.get('/api/dashboard/build-data-summary/:projectName', (req, res) => {
  const { projectName } = req.params;

  console.log(`Fetching build summary for project: ${projectName}`);

  // Step 1: Get all builds for the project
  const buildQuery = `
    SELECT
  b.chassis_sn,   
  b.platform_type,
  b.system_pn,
  b.project_name,
  DATE(mb.delivery_date) as build_date,
  YEARWEEK(mb.delivery_date, 1) as year_week,
  WEEK(mb.delivery_date, 1) as week_number,
  YEAR(mb.delivery_date) as year,
  mb.delivery_date as created_at,
  mb.master_status,
  CASE
    WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
    WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
    ELSE 'Other'
  END as detected_platform
FROM builds b
INNER JOIN master_builds mb 
  ON b.chassis_sn = mb.chassis_sn
WHERE b.project_name = (
    SELECT id 
    FROM project_name 
    WHERE project_name = ?
)
AND mb.delivery_date IS NOT NULL
AND (
  UPPER(b.platform_type) LIKE '%PRB%' 
  OR UPPER(b.platform_type) LIKE '%VRB%'
)
ORDER BY mb.delivery_date ASC;
  `;

  db.query(buildQuery, [projectName], (err, buildResults) => {
    if (err) {
      console.error('Error fetching build data:', err);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }

    // Only Delivered builds
    const relevantBuilds = buildResults.filter(build => build.master_status === 'Delivered');

    // Group builds by platform & week
    const weeklyData = { PRB: {}, VRB: {} };
    relevantBuilds.forEach(build => {
      const platform = build.detected_platform;
      if (platform !== 'PRB' && platform !== 'VRB') return;

      const yearWeek = `${build.year}-W${build.week_number.toString().padStart(2, '0')}`;

      if (!weeklyData[platform][yearWeek]) {
        const jan1 = new Date(build.year, 0, 1);
        const weekStartDate = new Date(jan1);
        weekStartDate.setDate(jan1.getDate() + (build.week_number - 1) * 7 - jan1.getDay() + 1);
        weeklyData[platform][yearWeek] = { week_start: weekStartDate, builds: [] };
      }

      weeklyData[platform][yearWeek].builds.push(build);
    });

    // Utility to calculate accumulative array
    const calculateAccumulative = (weeklyArr) => {
      const accum = [];
      weeklyArr.reduce((sum, val) => {
        sum += val;
        accum.push(sum);
        return sum;
      }, 0);
      return accum;
    };

    // Step 2: Get POR targets from forecast config
    const getPorTargets = (platform, callback) => {
      const configQuery = `
       SELECT * 
FROM project_forecast_configs
WHERE project_name = (
    SELECT id 
    FROM project_name 
    WHERE project_name = ?
)
AND platform_type = ?
      `;

      db.query(configQuery, [projectName, platform], (err, configResults) => {
        if (err) return callback(err);
        if (configResults.length === 0) return callback(null, []);

        const config = configResults[0];

        const porQuery = `
          SELECT 
          week_date, 
          smart_quantity, 
          non_smart_quantity 
        FROM project_por_targets
          WHERE config_id = ?
          ORDER BY week_date
        `;

        db.query(porQuery, [config.id], (err, porResults) => {
          if (err) return callback(err);

          const porWeeks = [];
          const smartQty = [];
          const nonSmartQty = [];

          porResults.forEach(row => {
            const dateKey = new Date(row.week_date);
            const weekStr = `${(dateKey.getMonth() + 1).toString().padStart(2, '0')}/${dateKey.getDate().toString().padStart(2, '0')}`;

            porWeeks.push(weekStr);
            smartQty.push(row.smart_quantity || 0);
            nonSmartQty.push(row.non_smart_quantity || 0);
          });

          callback(null, { porWeeks, smartQty, nonSmartQty });
        });
      });
    };

    // Step 3: Combine weekly builds + accumulative + POR targets
    const data2 = { prb: {}, vrb: {} };

    ['PRB', 'VRB'].forEach(platform => {
      const weeksSorted = Object.entries(weeklyData[platform])
        .sort(([a], [b]) => {
          const [yA, wA] = a.split('-W').map(Number);
          const [yB, wB] = b.split('-W').map(Number);
          return yA !== yB ? yA - yB : wA - wB;
        });

      const weeklyCounts = [];
      const weeklyLabels = [];

      weeksSorted.forEach(([_, weekData]) => {
        const actualBuilds = weekData.builds.length;
        const weekFormatted = `${(weekData.week_start.getMonth() + 1).toString().padStart(2, '0')}/${weekData.week_start.getDate().toString().padStart(2, '0')}`;

        weeklyCounts.push(actualBuilds);
        weeklyLabels.push(weekFormatted);
      });

      data2[platform.toLowerCase()] = {
        weekly: weeklyCounts,
        accumulative: calculateAccumulative(weeklyCounts),
        weeks: weeklyLabels
      };
    });

    // Step 4: Fetch POR targets for PRB & VRB in parallel
    getPorTargets('PRB', (err, prbPor) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch PRB POR', details: err.message });
      data2.prb.porWeeks = prbPor.porWeeks;
      data2.prb.smartQty = prbPor.smartQty;
      data2.prb.nonSmartQty = prbPor.nonSmartQty;

      getPorTargets('VRB', (err, vrbPor) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch VRB POR', details: err.message });
        data2.vrb.porWeeks = vrbPor.porWeeks;
        data2.vrb.porQuantities = vrbPor.porQuantities;
        data2.vrb.smartQty = vrbPor.smartQty;
        data2.vrb.nonSmartQty = vrbPor.nonSmartQty;


        res.json(data2);
      });
    });
  });
});

/**
 * http://localhost:5000/api/dashboard/forecast-config/Weisshorn%20SP7/PRB
 * GET /api/dashboard/forecast-config/:projectName/:platformType
 * 
 * Get forecast configuration for a specific project and platform type
 * UPDATED: Now includes additional reference dates and weekly POR targets
 * 
 * @param {string} projectName - Project name
 * @param {string} platformType - PRB or VRB
 * @returns {object} - Forecast configuration with milestones and weekly targets
 */
app.get('/api/dashboard/forecast-config/:projectName/:platformType', (req, res) => {
  const { projectName, platformType } = req.params;

  const configQuery = `
     SELECT pfc.*
  FROM project_forecast_configs pfc
  JOIN project_name pn ON pfc.project_name = pn.id
  WHERE pn.project_name = ? 
    AND pfc.platform_type = ?
  `;

  db.query(configQuery, [projectName, platformType], (err, configResults) => {
    if (err) {
      console.error('Error fetching forecast config:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (configResults.length === 0) {
      console.log('No configuration found');
      return res.json(null); // No configuration found
    }

    const config = configResults[0];

    // Get milestones for this configuration
    const milestonesQuery = `
      SELECT * FROM project_milestones 
      WHERE config_id = ? 
      ORDER BY milestone_order
    `;

    db.query(milestonesQuery, [config.id], (err, milestoneResults) => {
      if (err) {
        console.error('Error fetching milestones:', err);
        return res.status(500).json({ error: 'Database error' });
      }


      // Get weekly POR targets for this configuration
      const porTargetsQuery = `
        SELECT week_date, por_quantity FROM project_por_targets 
        WHERE config_id = ? 
        ORDER BY week_date
      `;

      db.query(porTargetsQuery, [config.id], (err, porResults) => {
        if (err) {
          console.error('Error fetching POR targets:', err);
          return res.status(500).json({ error: 'Database error' });
        }


        // Convert POR targets to frontend-expected format (array indexed by week)
        const porTargetsByWeek = {};
        porResults.forEach(row => {
          // Convert date to YYYY-MM-DD format to match generateWeeklyDates output
          const dateKey = new Date(row.week_date).toISOString().split('T')[0];
          porTargetsByWeek[dateKey] = row.por_quantity;
        });


        // Use utility function to convert to array format expected by frontend
        const porTargets = convertWeeklyObjectToPorTargets(
          porTargetsByWeek,
          config.start_date,
          config.end_date
        );


        // Format response to match frontend EditData structure exactly
        const response = {
          startDate: config.start_date,
          endDate: config.end_date,
          afeDate: config.afe_date || '',
          tvDate: config.tv_date || '',
          iodDate: config.iod_date || '',
          uuDate: config.uu_date || '',
          milestones: milestoneResults.map(m => ({
            name: m.milestone_name,
            startDate: m.start_date,
            endDate: m.end_date
            // Milestones are defined ONLY by start/end dates - POR targets are weekly, not by milestone
          })),
          porTargets: porTargets
        };

        console.log('Sending response:', response);
        res.json(response);
      });
    });
  });
});

/**
 * POST /api/dashboard/forecast-config/:projectName/:platformType
 * 
 * Save or update forecast configuration
 * UPDATED: Now handles additional reference dates and weekly POR targets
 * 
 * @param {string} projectName - Project name
 * @param {string} platformType - PRB or VRB
 * @body {object} - Configuration data with milestones and weekly targets
 * @returns {object} - Success response
 */
app.post('/api/dashboard/forecast-config/:projectName/:platformType', async (req, res) => {
  const { projectName, platformType } = req.params;
  const configData = req.body;

  console.log('Received configuration data:', {
    projectName,
    platformType,
    startDate: configData.startDate,
    endDate: configData.endDate,
    milestoneCount: configData.milestones?.length || 0,
    //porTargetCount: configData.porTargets?.length || 0
    smartTargetCount: configData.smartTargets?.length || 0,
    nonSmartTargetCount: configData.nonSmartTargets?.length || 0,
    porTargetCount: configData.porTargets?.length || 0
  });

  // Validate configuration data
  const validation = validateConfiguration(configData);
  if (!validation.isValid) {
    return res.status(400).json({
      error: 'Invalid configuration data',
      errors: validation.errors
    });
  }

  let connection;

  try {
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    const {
      startDate,
      endDate,
      afeDate,
      tvDate,
      iodDate,
      uuDate,
      milestones,
      smartTargets,
      nonSmartTargets,
      porTargets
    } = configData;

    // Convert empty strings to null for date fields (match frontend behavior)
    const convertEmptyToNull = (value) => value === '' ? null : value;

    // Insert or update main configuration
    const [configResult] = await connection.execute(`
       INSERT INTO project_forecast_configs (
    project_name, platform_type, start_date, end_date,
    afe_date, tv_date, iod_date, uu_date
  )
  VALUES (
    (SELECT id FROM project_name WHERE project_name = ?),
    ?, ?, ?, ?, ?, ?, ?
  )
  ON DUPLICATE KEY UPDATE
    start_date = VALUES(start_date),
    end_date = VALUES(end_date),
    afe_date = VALUES(afe_date),
    tv_date = VALUES(tv_date),
    iod_date = VALUES(iod_date),
    uu_date = VALUES(uu_date),
    updated_at = CURRENT_TIMESTAMP
    `, [
      projectName,
      platformType,
      startDate,
      endDate,
      convertEmptyToNull(afeDate),
      convertEmptyToNull(tvDate),
      convertEmptyToNull(iodDate),
      convertEmptyToNull(uuDate)
    ]);

    // Get the configuration ID
    let configId;
    if (configResult.insertId) {
      configId = configResult.insertId;
    } else {
      const [existingConfig] = await connection.execute(`
        SELECT id 
        FROM project_forecast_configs 
        WHERE project_id = (
          SELECT id 
          FROM project_name 
          WHERE project_name = ?
        )
        AND platform_type = ?
      `, [
        projectName,
        platformType
      ]);
      configId = existingConfig[0].id;
    }

    console.log('Config ID:', configId);

    // Delete existing milestones and POR targets
    await connection.execute('DELETE FROM project_milestones WHERE config_id = ?', [configId]);
    //await connection.execute('DELETE FROM project_por_targets WHERE config_id = ?', [configId]);

    // Insert new milestones (matching frontend structure exactly)
    if (milestones && milestones.length > 0) {
      for (let i = 0; i < milestones.length; i++) {
        const milestone = milestones[i];
        console.log(`Inserting milestone ${i}:`, milestone);

        await connection.execute(`
          INSERT INTO project_milestones (
            config_id, milestone_name, start_date, end_date, milestone_order
          )
          VALUES (?, ?, ?, ?, ?)
        `, [
          configId,
          milestone.name,
          milestone.startDate,
          milestone.endDate,
          i + 1
        ]);
      }
    }

    // 🔥 NEW: SAFE ARRAY ALIGNMENT
    const safeSmart = smartTargets || [];
    const safeNonSmart = nonSmartTargets || [];
    const safePOR = porTargets || [];


    // Insert weekly POR targets using utility function
    if (safePOR.length > 0) {
      const porTargetsByWeek = convertPorTargetsToWeeklyObject(safeSmart,
        safeNonSmart,
        safePOR,
        startDate,
        endDate);

      //console.log('Converting POR targets:', {
      //  arrayLength: porTargets.length,
      //  objectKeys: Object.keys(porTargetsByWeek).length
      //});

      console.log('Saving weekly targets:', {
        smart: safeSmart.length,
        nonSmart: safeNonSmart.length,
        por: safePOR.length
      });

      for (const [weekDate, data] of Object.entries(porTargetsByWeek)) {
        //const qty = parseInt(porTargetsByWeek[weekDate]) || 0;

        // Save all values, including zeros, to preserve user input
        console.log(`Inserting POR target for ${weekDate}: ${data}`);

        try {
          await connection.execute(`
            INSERT INTO project_por_targets (
            config_id,
            week_date,
            por_quantity,
            smart_quantity,
            non_smart_quantity
          )
          VALUES (?, ?, ?, ?, ?)
          `, [configId, weekDate, data.por,
            data.smart,
            data.nonSmart]);
        } catch (insertError) {
          console.error(`Error inserting POR target for ${weekDate}:`, insertError);
          // Continue with other targets
        }
      }
    }

    await connection.commit();
    console.log('Configuration saved successfully');

    res.json({
      success: true,
      message: 'Forecast configuration saved successfully',
      configId: configId
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error saving forecast config:', error);

    // Provide more specific error messages
    let errorMessage = 'Failed to save configuration';
    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Configuration already exists for this project and platform.';
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      errorMessage = 'Invalid reference constraint. Please check your data.';
    } else {
      errorMessage = error.message || 'Database error occurred';
    }

    res.status(500).json({ error: errorMessage });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/dashboard/quality-data/:projectName
 * 
 * Get quality data for pie charts and bar charts
 * @param {string} projectName - Project name
 * @returns {object} - Quality data for PRB and VRB
 */

/*
app.get('/api/dashboard/quality-data/:projectName', (req, res) => {
  const { projectName } = req.params;

  const query = `
    SELECT
      b.platform_type,
      b.chassis_sn,
      bf.failure_mode,
      bf.failure_category
    FROM builds b
    LEFT JOIN build_failures bf ON b.chassis_sn = bf.chassis_sn
    WHERE b.project_name = ?
      AND (b.platform_type LIKE '%PRB%' OR b.platform_type LIKE '%VRB%')
  `;

  db.query(query, [projectName], (err, results) => {
    if (err) {
      console.error('Error fetching quality data:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Initialize data structures
    const qualityData = { PRB: { good: 0, failures: {} }, VRB: { good: 0, failures: {} } };
    const breakdownData = { PRB: {}, VRB: {} };
    const buildsByPlatform = { PRB: new Set(), VRB: new Set() };

    // Collect all unique categories globally
    const allCategories = new Set();

    // Group data per platform
    results.forEach(row => {
      let platformType = null;
      if (row.platform_type && row.platform_type.toUpperCase().includes('PRB')) {
        platformType = 'PRB';
      } else if (row.platform_type && row.platform_type.toUpperCase().includes('VRB')) {
        platformType = 'VRB';
      }

      if (platformType) {
        buildsByPlatform[platformType].add(row.chassis_sn);

        if (row.failure_category && row.failure_mode) {
          allCategories.add(row.failure_category);
         
          // Pie chart failures
          if (!qualityData[platformType].failures[row.failure_category]) {
            qualityData[platformType].failures[row.failure_category] = new Set();
          }
          qualityData[platformType].failures[row.failure_category].add(row.chassis_sn);

          // Bar chart breakdown
          if (!breakdownData[platformType][row.failure_mode]) {
            breakdownData[platformType][row.failure_mode] = {
              category: row.failure_category,
              qty: 0
            };
          }
          breakdownData[platformType][row.failure_mode].qty++;
        }
      }
    });
    //console.log("All categories collected:", Array.from(allCategories));

    // Define defect colors
    const defectColors = [
      '#f97316', '#8b5cf6', '#ec4899', '#6366f1',
      '#f59e0b', '#7c3aed', '#a855f7', '#be185d',
      '#b45309', '#7c2d12', '#92400e', '#78350f',
      '#581c87', '#a21caf', '#9333ea'
    ];

    // Hash function for deterministic color assignment
    function hashStringToIndex(str, arrayLength) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      return Math.abs(hash) % arrayLength;
    }

    // Create a global category -> color map
    const categoryColorMap = {};
    Array.from(allCategories).forEach((category, index) => {
      categoryColorMap[category] = defectColors[index % defectColors.length];
    });

    // Build the response
    const response = { PRB: {}, VRB: {} };

    ['PRB', 'VRB'].forEach(platformType => {
      const totalBuilds = buildsByPlatform[platformType].size;
      const failureCategories = qualityData[platformType].failures;

      // Calculate good builds
      const buildsWithFailures = new Set();
      Object.values(failureCategories).forEach(buildSet => {
        buildSet.forEach(chassis => buildsWithFailures.add(chassis));
      });
      const goodBuilds = totalBuilds - buildsWithFailures.size;

      // Pie chart data
      const pieData = [
        {
          name: 'Good',
          value: totalBuilds > 0 ? Math.round((goodBuilds / totalBuilds) * 100) : 0,
          count: goodBuilds,
          color: '#10b981' // always green
        }
      ];

      Object.entries(failureCategories).forEach(([category, buildSet]) => {
        const percentage = totalBuilds > 0
        ? (buildSet.size > 0 
            ? Math.max(1, Math.round((buildSet.size / totalBuilds) * 100))
            : 0)
        : 0;
        console.log("Processing category:", category, "Builds:", Array.from(buildSet));
        if (percentage > 0) {
          pieData.push({
            name: category,
            value: percentage,
            count: buildSet.size,
            color: categoryColorMap[category]
          });
        }
      });

      // Bar chart data
      const barData = Object.entries(breakdownData[platformType]).map(([failureMode, data]) => ({
        issue: failureMode,
        category: data.category,
        qty: data.qty
      }));

      response[platformType] = { pieData, breakdownData: barData };
    });

    res.json(response);
  });
});
*/

app.get('/api/dashboard/quality-data/:projectName', (req, res) => {
  const { projectName } = req.params;

  const projectQuery = ` SELECT id FROM project_name WHERE project_name = ? `;

  const query = `
    SELECT
      b.platform_type,
      b.chassis_sn,
      bf.failure_mode,
      bf.failure_category
    FROM builds b
    LEFT JOIN build_failures bf ON b.chassis_sn = bf.chassis_sn
    WHERE b.project_name = ?
      AND (b.platform_type LIKE '%PRB%' OR b.platform_type LIKE '%VRB%')
  `;

  db.query(projectQuery, [projectName], (err, projectRows) => {

    if (err) {
      console.error('Error fetching quality data:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const projectId = projectRows[0].id;

    // STEP 2: Get quality data
    const query = `
      SELECT
        b.platform_type,
        b.chassis_sn,
        bf.failure_mode,
        bf.failure_category
      FROM builds b
      LEFT JOIN build_failures bf ON b.chassis_sn = bf.chassis_sn
      WHERE b.project_name = ?
        AND (UPPER(b.platform_type) LIKE '%PRB%' OR UPPER(b.platform_type) LIKE '%VRB%')
    `;

    db.query(query, [projectId], (err, results) => {

      if (err) {
        console.error('Error fetching quality data:', err);
        return res.status(500).json({ error: 'Database error', details: err.message });
      }

      // Initialize data structures
      const qualityData = { PRB: { good: 0, failures: {} }, VRB: { good: 0, failures: {} } };
      const breakdownData = { PRB: {}, VRB: {} };
      const buildsByPlatform = { PRB: new Set(), VRB: new Set() };

      const allCategories = new Set();

      // Process results
      results.forEach(row => {

        let platformType = null;

        if (row.platform_type && row.platform_type.toUpperCase().includes('PRB')) {
          platformType = 'PRB';
        } else if (row.platform_type && row.platform_type.toUpperCase().includes('VRB')) {
          platformType = 'VRB';
        }

        if (platformType) {

          buildsByPlatform[platformType].add(row.chassis_sn);

          if (row.failure_category && row.failure_mode) {

            allCategories.add(row.failure_category);

            // Pie chart failures
            if (!qualityData[platformType].failures[row.failure_category]) {
              qualityData[platformType].failures[row.failure_category] = new Set();
            }

            qualityData[platformType].failures[row.failure_category].add(row.chassis_sn);

            // Bar chart breakdown
            if (!breakdownData[platformType][row.failure_mode]) {
              breakdownData[platformType][row.failure_mode] = {
                category: row.failure_category,
                qty: 0
              };
            }

            breakdownData[platformType][row.failure_mode].qty++;

          }
        }

      });

      // Defect colors
      const defectColors = [
        '#f97316', '#8b5cf6', '#ffff00', '#6366f1', '#ec4899', '#7c3aed', '#a855f7', '#be185d',
        '#b45309', '#7c2d12', '#92400e', '#78350f',
        '#581c87', '#a21caf', '#9333ea'
      ];

      const categoryColorMap = {};

      Array.from(allCategories).forEach((category, index) => {
        categoryColorMap[category] = defectColors[index % defectColors.length];
      });

      const response = { PRB: {}, VRB: {} };

      ['PRB', 'VRB'].forEach(platformType => {

        const totalBuilds = buildsByPlatform[platformType].size;
        const failureCategories = qualityData[platformType].failures;

        const buildsWithFailures = new Set();

        Object.values(failureCategories).forEach(buildSet => {
          buildSet.forEach(chassis => buildsWithFailures.add(chassis));
        });

        const goodBuilds = totalBuilds - buildsWithFailures.size;

        const pieData = [
          {
            name: 'Good',
            value: totalBuilds > 0
              ? Number(((goodBuilds / totalBuilds) * 100).toFixed(1))
              : 0,
            count: goodBuilds,
            color: '#10b981'
          }
        ];

        Object.entries(failureCategories).forEach(([category, buildSet]) => {

          const percentage = totalBuilds > 0
            ? Math.max(1, Math.round((buildSet.size / totalBuilds) * 100))
            : 0;

          if (percentage > 0) {

            pieData.push({
              name: category,
              value: percentage,
              count: buildSet.size,
              color: categoryColorMap[category]
            });

            // ✅ Fix total to 100%
            let totalPercent = pieData.reduce((sum, item) => sum + item.value, 0);
            let diff = 100 - totalPercent;

            if (diff !== 0 && pieData.length > 0) {
              // Adjust the largest slice (usually "Good")
              const maxIndex = pieData.reduce(
                (maxIdx, item, i, arr) =>
                  item.value > arr[maxIdx].value ? i : maxIdx,
                0
              );

              pieData[maxIndex].value += diff;
            }

          }

        });

        const barData = Object.entries(breakdownData[platformType]).map(([failureMode, data]) => ({
          issue: failureMode,
          category: data.category,
          qty: data.qty
        }));

        response[platformType] = {
          pieData,
          breakdownData: barData
        };

      });

      res.json(response);

    });

  });

});
// Enhanced debug endpoint that shows platform_type analysis
/**
 * GET /api/dashboard/debug/:projectName
 * 
 * Enhanced debug endpoint to analyze platform_type content
 * @param {string} projectName - Project name
 * @returns {object} - Detailed debug information
 */
app.get('/api/dashboard/debug/:projectName', (req, res) => {
  const { projectName } = req.params;

  const debugQueries = {
    // Check all builds for this project
    allBuilds: `
      SELECT 
        b.chassis_sn,
        b.project_name,
        b.platform_type,
        b.created_at,
        b.status as build_status,
        CASE 
          WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
          WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
          ELSE 'Other'
        END as detected_platform
      FROM builds b
      WHERE b.project_name = ?
      ORDER BY b.created_at DESC
    `,

    // Check platform_type distribution
    platformDistribution: `
      SELECT 
        CASE 
          WHEN UPPER(platform_type) LIKE '%PRB%' THEN 'PRB'
          WHEN UPPER(platform_type) LIKE '%VRB%' THEN 'VRB'
          ELSE 'Other'
        END as platform_category,
        COUNT(*) as count,
        GROUP_CONCAT(DISTINCT LEFT(platform_type, 100) SEPARATOR ' | ') as sample_values
      FROM builds 
      WHERE project_name = ?
      GROUP BY 
        CASE 
          WHEN UPPER(platform_type) LIKE '%PRB%' THEN 'PRB'
          WHEN UPPER(platform_type) LIKE '%VRB%' THEN 'VRB'
          ELSE 'Other'
        END
    `,

    // Check master builds status
    masterBuilds: `
      SELECT 
        b.chassis_sn,
        b.platform_type,
        mb.master_status,
        mb.created_at as master_created_at,
        CASE 
          WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
          WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
          ELSE 'Other'
        END as detected_platform
      FROM builds b
      LEFT JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
      WHERE b.project_name = ?
        AND (UPPER(b.platform_type) LIKE '%PRB%' OR UPPER(b.platform_type) LIKE '%VRB%')
      ORDER BY b.created_at DESC
    `,

    // Check what the dashboard should show (delivered builds with PRB/VRB)
    dashboardData: `
      SELECT 
        CASE 
          WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
          WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
          ELSE 'Other'
        END as platform_category,
        DATE(b.created_at) as build_date,
        WEEK(b.created_at, 1) as week_number,
        YEAR(b.created_at) as year,
        COUNT(*) as build_count,
        mb.master_status
      FROM builds b
      LEFT JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
      WHERE b.project_name = ? 
        AND (UPPER(b.platform_type) LIKE '%PRB%' OR UPPER(b.platform_type) LIKE '%VRB%')
      GROUP BY 
        CASE 
          WHEN UPPER(b.platform_type) LIKE '%PRB%' THEN 'PRB'
          WHEN UPPER(b.platform_type) LIKE '%VRB%' THEN 'VRB'
          ELSE 'Other'
        END,
        YEAR(b.created_at), 
        WEEK(b.created_at, 1),
        DATE(b.created_at),
        mb.master_status
      ORDER BY platform_category, year, week_number
    `
  };

  // Execute all debug queries
  const results = {};
  const queryPromises = Object.entries(debugQueries).map(([key, query]) => {
    return new Promise((resolve, reject) => {
      db.query(query, [projectName], (err, queryResults) => {
        if (err) {
          console.error(`Error in debug query ${key}:`, err);
          results[key] = { error: err.message };
        } else {
          results[key] = queryResults;
        }
        resolve();
      });
    });
  });

  Promise.all(queryPromises).then(() => {
    // Add summary information
    const summary = {
      totalBuilds: results.allBuilds?.length || 0,
      buildsWithPRB: results.allBuilds?.filter(b => b.detected_platform === 'PRB').length || 0,
      buildsWithVRB: results.allBuilds?.filter(b => b.detected_platform === 'VRB').length || 0,
      buildsWithOther: results.allBuilds?.filter(b => b.detected_platform === 'Other').length || 0,
      masterRecords: results.masterBuilds?.length || 0,
      deliveredBuilds: results.masterBuilds?.filter(b => b.master_status === 'Delivered').length || 0,
      platformTypes: results.platformDistribution || []
    };

    res.json({
      projectName,
      summary,
      details: results,
      recommendations: generateRecommendations(summary)
    });
  });
});

function generateRecommendations(summary) {
  const recommendations = [];

  if (summary.totalBuilds === 0) {
    recommendations.push("No builds found for this project.");
  } else if (summary.buildsWithPRB === 0 && summary.buildsWithVRB === 0) {
    recommendations.push("No builds found with 'PRB' or 'VRB' in their platform_type field.");
    recommendations.push("Check the platform_type values in your builds table.");
  } else if (summary.masterRecords === 0) {
    recommendations.push("Builds with PRB/VRB found but no master_builds records exist.");
    recommendations.push("Run: INSERT INTO master_builds (chassis_sn, master_status) SELECT chassis_sn, 'Delivered' FROM builds WHERE project_name = 'your_project' AND (UPPER(platform_type) LIKE '%PRB%' OR UPPER(platform_type) LIKE '%VRB%');");
  } else if (summary.deliveredBuilds === 0) {
    recommendations.push("Master records exist but none are marked as 'Delivered'.");
    recommendations.push("Update master_status to 'Delivered' for builds that should appear in dashboard.");
  } else {
    recommendations.push(`Found ${summary.buildsWithPRB} PRB builds and ${summary.buildsWithVRB} VRB builds.`);
    recommendations.push(`${summary.deliveredBuilds} builds are marked as delivered and should appear in dashboard.`);
  }

  return recommendations;
}

/**
 * GET /api/dashboard/location-allocation
 * 
 * Get real-time location allocation data showing delivery quantities by location and team/security
 * Clusters locations by ignoring text after ':' in location names
 * 
 * @query {string} startDate - Start date for data range (optional, defaults to current date - 3 months)
 * @query {string} endDate - End date for data range (optional, defaults to current date)
 * 
 * @returns {object} - Real-time chart data from database
 */
app.get('/api/dashboard/location-allocation', getLocationAllocationData);


// ============================================================================
// CONTINUE BUILD API ENDPOINTS
// ============================================================================

/**
 * GET /api/builds/in-progress
 * 
 * Get all builds with status 'In Progress'
 * Includes step completion data for continue functionality
 * 
 * @returns {array} - Array of in-progress builds with step completion info
 */
app.get('/api/builds/in-progress', (req, res) => {
  console.log('Fetching in-progress builds...');

  const query = `
SELECT 
    b.chassis_sn,
    b.jira_ticket_no,
    b.location,
    b.build_engineer,
    b.is_custom_config,
    b.system_pn,
    b.platform_type,
    b.manufacturer,
    b.chassis_type,
    b.bmc_name,
    b.mb_sn,
    b.ethernet_mac,
    b.cpu_socket,
    b.cpu_vendor,
    b.cpu_p0_sn,
    b.cpu_p0_socket_date_code,
    b.cpu_p1_sn,
    b.cpu_p1_socket_date_code,
    b.cpu_program_name,
    b.m2_pn,
    b.m2_sn,
    b.dimm_pn,
    b.dimm_qty,
    b.visual_inspection_status,
    b.visual_inspection_notes,
    b.boot_status,
    b.boot_notes,
    b.dimms_detected_status,
    b.dimms_detected_notes,
    b.lom_working_status,
    b.lom_working_notes,
    b.fpy_status,
    b.can_continue,
    b.status,
    b.created_at,
    b.updated_at,
    b.bios_version,
    b.bmc_version,
    b.scm_fpga_version,
    b.hpm_fpga_version,
    b.problem_description,
    b.bmc_mac,
    b.po,

    pn.project_name AS project_name,   -- readable name

    GROUP_CONCAT(DISTINCT d.dimm_sn ORDER BY d.id SEPARATOR ',') AS dimm_sns,

    CASE 
        WHEN b.fpy_status IS NOT NULL THEN 1 ELSE 0 
    END AS has_quality_data,

    CASE 
        WHEN b.bios_version IS NOT NULL THEN 1 ELSE 0 
    END AS has_bkc_data

FROM builds b

LEFT JOIN project_name pn 
    ON b.project_name = pn.id

LEFT JOIN dimm_serial_numbers d 
    ON b.chassis_sn = d.chassis_sn

WHERE b.status = 'In Progress'

GROUP BY b.chassis_sn

ORDER BY b.updated_at DESC;
  `;

  dbQuery(query, (err, results) => {
    if (err) {
      console.error('Error fetching in-progress builds:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log(`Found ${results.length} in-progress builds`);

    // Process results to add step completion data
    results.forEach(build => {
      // Parse DIMM SNs
      build.dimmSNs = build.dimm_sns ? build.dimm_sns.split(',') : [];
      delete build.dimm_sns;

      // Add Build Engineer and CPU Vendor to top-level for frontend compatibility
      // Map Build Engineer from all possible sources
      build.buildEngineer = build.build_engineer || build.buildEngineer || build.build_engineer_from_build || '';
      // Map CPU Vendor from all possible sources
      build.cpuVendor = build.cpu_vendor || build.cpuVendor || build.cpu_vendor_from_build || '';
      // Map Jira Ticket No from all possible sources
      build.jiraTicketNo = build.jira_ticket_no || build.jiraTicketNo || build.jira_ticket_no_from_build || '';

      // Determine completed steps based on data presence
      build.stepCompleted = {
        // Check location exists and is_custom_config is set (0 or 1, not null)
        generalInfo: !!(build.location && (build.is_custom_config === 0 || build.is_custom_config === 1)),

        // Check all required chassis info fields
        // Ethernet MAC is now optional
        chassisInfo: !!(build.project_name && build.system_pn && build.chassis_sn &&
          build.bmc_mac && build.mb_sn && build.cpu_socket),

        // Check CPU info
        cpuInfo: !!(build.cpu_program_name),

        // Check component info
        componentInfo: !!(build.m2_pn && build.m2_sn && build.dimm_pn && build.dimm_qty),

        // Check all testing fields are filled
        testing: !!(build.visual_inspection_status && build.boot_status &&
          build.dimms_detected_status && build.lom_working_status),

        // Check BKC data exists
        bkcDetails: !!(build.bios_version && build.hpm_fpga_version && build.bmc_version),

        // Check quality data exists
        qualityDetails: build.has_quality_data === 1
      };

      // Clean up temporary fields
      delete build.has_quality_data;
      delete build.has_bkc_data;
    });

    res.json(results);
  });
});

/**
 * PATCH /api/builds/:chassisSN
 * 
 * Update an existing build record
 * Used by Continue Build functionality
 * 
 * @param {string} chassisSN - Chassis serial number
 * @body {object} - Build update data
 * @returns {object} - Success response
 */
app.patch('/api/builds/:chassisSN', (req, res) => {
  const { chassisSN } = req.params;
  const updateData = req.body;

  console.log('Updating build:', chassisSN);

  // Build UPDATE query dynamically based on provided fields
  const updateFields = [];
  const updateValues = [];

  // General Information fields
  if (updateData.location !== undefined) {
    updateFields.push('location = ?');
    updateValues.push(updateData.location);
  }
  if (updateData.buildEngineer !== undefined) {
    updateFields.push('build_engineer = ?');
    updateValues.push(updateData.buildEngineer);
  }
  if (updateData.isCustomConfig !== undefined) {
    updateFields.push('is_custom_config = ?');
    updateValues.push(updateData.isCustomConfig === 'Yes' ? 1 : 0);
  }
  if (updateData.platformType !== undefined) {
    updateFields.push('platform_type = ?');
    updateValues.push(updateData.platformType);
  }
  if (updateData.extension1 !== undefined) {
    updateFields.push('extension1 = ?');
    updateValues.push(updateData.extension1);
  }
  if (updateData.extension2 !== undefined) {
    updateFields.push('extension2 = ?');
    updateValues.push(updateData.extension2);
  }
  if (updateData.extension3 !== undefined) {
    updateFields.push('extension3 = ?');
    updateValues.push(updateData.extension3);
  }
  if (updateData.buildDate !== undefined) {
    updateFields.push('build_date = ?');
    updateValues.push(updateData.buildDate);
  }

  // System Information fields
  if (updateData.projectName !== undefined) {
    updateFields.push('project_name = ?');
    updateValues.push(updateData.projectName);
  }
  if (updateData.systemPN !== undefined) {
    updateFields.push('system_pn = ?');
    updateValues.push(updateData.systemPN);
  }
  if (updateData.bmcMac !== undefined) {
    updateFields.push('bmc_mac = ?');
    updateValues.push(updateData.bmcMac);
  }
  if (updateData.mbSN !== undefined) {
    updateFields.push('mb_sn = ?');
    updateValues.push(updateData.mbSN);
  }
  if (updateData.ethernetMac !== undefined) {
    updateFields.push('ethernet_mac = ?');
    updateValues.push(updateData.ethernetMac);
  }
  if (updateData.cpuSocket !== undefined) {
    updateFields.push('cpu_socket = ?');
    updateValues.push(updateData.cpuSocket);
  }
  if (updateData.cpuVendor !== undefined) {
    updateFields.push('cpu_vendor = ?');
    updateValues.push(updateData.cpuVendor);
  }

  if (updateData.jiraTicketNo !== undefined) {
    updateFields.push('jira_ticket_no = ?');
    updateValues.push(updateData.jiraTicketNo);
  }
  if (updateData.cpuProgramName !== undefined) {
    updateFields.push('cpu_program_name = ?');
    updateValues.push(updateData.cpuProgramName);
  }
  if (updateData.cpuP0SN !== undefined) {
    updateFields.push('cpu_p0_sn = ?');
    updateValues.push(updateData.cpuP0SN);
  }
  if (updateData.cpuP1SN !== undefined) {
    updateFields.push('cpu_p1_sn = ?');
    updateValues.push(updateData.cpuP1SN);
  }
  if (updateData.m2PN !== undefined) {
    updateFields.push('m2_pn = ?');
    updateValues.push(updateData.m2PN);
  }
  if (updateData.m2SN !== undefined) {
    updateFields.push('m2_sn = ?');
    updateValues.push(updateData.m2SN);
  }
  if (updateData.dimmPN !== undefined) {
    updateFields.push('dimm_pn = ?');
    updateValues.push(updateData.dimmPN);
  }
  if (updateData.dimmQty !== undefined) {
    updateFields.push('dimm_qty = ?');
    updateValues.push(updateData.dimmQty);
  }

  // Testing fields
  if (updateData.visualInspection !== undefined) {
    updateFields.push('visual_inspection_status = ?');
    updateValues.push(updateData.visualInspection);
  }
  if (updateData.visualInspectionNotes !== undefined) {
    updateFields.push('visual_inspection_notes = ?');
    updateValues.push(updateData.visualInspectionNotes);
  }
  if (updateData.visualInspectionPhotos !== undefined) {
    updateFields.push('visual_inspection_photos = ?');
    updateValues.push(updateData.visualInspectionPhotos.join(','));
  }
  if (updateData.bootStatus !== undefined) {
    updateFields.push('boot_status = ?');
    updateValues.push(updateData.bootStatus);
  }
  if (updateData.bootStatusNotes !== undefined) {
    updateFields.push('boot_status_notes = ?');
    updateValues.push(updateData.bootStatusNotes);
  }
  if (updateData.bootStatusPhotos !== undefined) {
    updateFields.push('boot_status_photos = ?');
    updateValues.push(updateData.bootStatusPhotos.join(','));
  }
  if (updateData.dimmsDetectedStatus !== undefined) {
    updateFields.push('dimms_detected_status = ?');
    updateValues.push(updateData.dimmsDetectedStatus);
  }
  if (updateData.dimmsDetectedNotes !== undefined) {
    updateFields.push('dimms_detected_notes = ?');
    updateValues.push(updateData.dimmsDetectedNotes);
  }
  if (updateData.dimmsDetectedPhotos !== undefined) {
    updateFields.push('dimms_detected_photos = ?');
    updateValues.push(updateData.dimmsDetectedPhotos.join(','));
  }
  if (updateData.lomWorkingStatus !== undefined) {
    updateFields.push('lom_working_status = ?');
    updateValues.push(updateData.lomWorkingStatus);
  }
  if (updateData.lomWorkingNotes !== undefined) {
    updateFields.push('lom_working_notes = ?');
    updateValues.push(updateData.lomWorkingNotes);
  }
  if (updateData.lomWorkingPhotos !== undefined) {
    updateFields.push('lom_working_photos = ?');
    updateValues.push(updateData.lomWorkingPhotos.join(','));
  }

  // Status field
  if (updateData.status !== undefined) {
    updateFields.push('status = ?');
    updateValues.push(updateData.status);
  }

  // Always update the timestamp
  updateFields.push('updated_at = CURRENT_TIMESTAMP');

  // Add chassis_sn to the end for WHERE clause
  updateValues.push(chassisSN);

  if (updateFields.length === 1) { // Only timestamp
    return res.status(400).json({ error: 'No fields to update' });
  }

  const query = `
    UPDATE builds 
    SET ${updateFields.join(', ')}
    WHERE chassis_sn = ?
  `;

  dbQuery(query, updateValues, (err, results) => {
    if (err) {
      console.error('Error updating build:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ error: 'Build not found' });
    }

    res.json({ success: true, message: 'Build updated successfully' });
  });
});

/**
 * GET /api/builds/:chassisSN/complete
 * 
 * Retrieve complete build details with quality data, failures, and DIMMs
 * Enhanced version that properly structures photo data
 * 
 * @param {string} chassisSN - Chassis serial number
 * @returns {object} - Complete build record with quality details and photos formatted
 */
app.get('/api/builds/:chassisSN/complete', (req, res) => {
  const { chassisSN } = req.params;

  // Get complete build details including quality data
  const buildQuery = `
   SELECT 
    b.chassis_sn,
    b.jira_ticket_no,
    b.location,
    b.build_engineer,
    b.is_custom_config,
    pn.project_name AS project_name,
    b.system_pn,
    b.platform_type,
    b.manufacturer,
    b.chassis_type,
    b.bmc_name,
    b.mb_sn,
    b.ethernet_mac,
    b.cpu_socket,
    b.cpu_vendor,
    b.cpu_p0_sn,
    b.cpu_p0_socket_date_code,
    b.cpu_p1_sn,
    b.cpu_p1_socket_date_code,
    b.cpu_program_name,
    b.m2_pn,
    b.m2_sn,
    b.dimm_pn,
    b.dimm_qty,
    b.visual_inspection_status,
    b.visual_inspection_notes,
    b.boot_status,
    b.boot_notes,
    b.dimms_detected_status,
    b.dimms_detected_notes,
    b.lom_working_status,
    b.lom_working_notes,
    b.fpy_status,
    b.can_continue,
    b.status,
    b.created_at,
    b.updated_at,
    b.bios_version,
    b.bmc_version,
    b.scm_fpga_version,
    b.hpm_fpga_version,
    b.problem_description,
    b.bmc_mac,
    b.po,

    GROUP_CONCAT(DISTINCT d.dimm_sn ORDER BY d.id SEPARATOR ',') AS dimm_sns

FROM builds b

LEFT JOIN project_name pn 
    ON b.project_name = pn.id

LEFT JOIN dimm_serial_numbers d 
    ON b.chassis_sn = d.chassis_sn

WHERE b.chassis_sn = ?

GROUP BY b.chassis_sn;
  `;

  db.query(buildQuery, [chassisSN], (err, buildResults) => {
    if (err) {
      console.error('Error fetching complete build details:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (buildResults.length === 0) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const build = buildResults[0];

    // Parse dimm serial numbers
    build.dimmSNs = build.dimm_sns ? build.dimm_sns.split(',') : [];
    delete build.dimm_sns;

    // Get failures
    const failureQuery = `
      SELECT failure_mode, failure_category 
      FROM build_failures 
      WHERE chassis_sn = ?
      ORDER BY id
    `;

    dbQuery(failureQuery, [chassisSN], (err, failureResults) => {
      if (err) {
        console.error('Error fetching failures:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      const failures = failureResults || [];

      // Get photos
      const photoQuery = `
        SELECT photo_type, file_path 
        FROM build_photos 
        WHERE chassis_sn = ?
      `;

      dbQuery(photoQuery, [chassisSN], (err, photoResults) => {
        if (err) {
          console.error('Error fetching photos:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        // Structure the response
        const response = {
          ...build,
          failures: failures,
          photos: photoResults || [],
          qualityDetails: {
            fpyStatus: build.fpy_status,
            problemDescription: build.problem_description,
            numberOfFailures: failures.length.toString(),
            failureModes: failures.map(f => f.failure_mode),
            failureCategories: failures.map(f => f.failure_category),
            canRework: build.can_continue === 'Yes' ? 'Yes, Need to update hardware/PCBA information' :
              build.can_continue === 'No' ? 'No, mark this build as a failed build' : '',
            saveOption: build.status === 'In Progress' ? 'continue' :
              build.status === 'Fail' ? 'failed' :
                build.status === 'Complete' ? 'complete' : 'continue'
          }
        };

        res.json(response);
      });
    });
  });
});

// ============================================================================
// EDIT BUILD DATA API ENDPOINTS
// ============================================================================

/**
 * POST /api/builds/search-for-edit
 *
 * Search builds by BMC Names and/or Chassis S/Ns for editing
 * Used by EditBuildData component to find builds to edit
 *
 * @body {array} bmcNames - Array of BMC names to search
 * @body {array} chassisSNs - Array of chassis serial numbers to search
 * @returns {array} - Array of matching builds with complete data
 */
app.post('/api/builds/search-for-edit', (req, res) => {
  const { bmcNames, chassisSNs } = req.body;

  console.log('Searching builds for edit:', { bmcNames, chassisSNs });

  // Build WHERE clause dynamically
  const whereClauses = [];
  const queryParams = [];

  if (bmcNames && bmcNames.length > 0) {
    const placeholders = bmcNames.map(() => '?').join(',');
    whereClauses.push(`b.bmc_name IN (${placeholders})`);
    queryParams.push(...bmcNames);
  }

  if (chassisSNs && chassisSNs.length > 0) {
    const placeholders = chassisSNs.map(() => '?').join(',');
    whereClauses.push(`b.chassis_sn IN (${placeholders})`);
    queryParams.push(...chassisSNs);
  }

  if (whereClauses.length === 0) {
    return res.status(400).json({ error: 'At least one BMC Name or Chassis S/N is required' });
  }

  const whereClause = whereClauses.join(' OR ');

  const query = `
    SELECT 
    b.chassis_sn,
    b.jira_ticket_no,
    b.location,
    b.build_engineer,
    b.is_custom_config,
    pn.project_name AS project_name,
    b.system_pn,
    b.platform_type,
    b.manufacturer,
    b.chassis_type,
    b.bmc_name,
    b.mb_sn,
    b.ethernet_mac,
    b.cpu_socket,
    b.cpu_vendor,
    b.cpu_p0_sn,
    b.cpu_p0_socket_date_code,
    b.cpu_p1_sn,
    b.cpu_p1_socket_date_code,
    b.cpu_program_name,
    b.m2_pn,
    b.m2_sn,
    b.dimm_pn,
    b.dimm_qty,
    b.visual_inspection_status,
    b.visual_inspection_notes,
    b.boot_status,
    b.boot_notes,
    b.dimms_detected_status,
    b.dimms_detected_notes,
    b.lom_working_status,
    b.lom_working_notes,
    b.fpy_status,
    b.can_continue,
    b.status,
    b.created_at,
    b.updated_at,
    b.bios_version,
    b.bmc_version,
    b.scm_fpga_version,
    b.hpm_fpga_version,
    b.problem_description,
    b.bmc_mac,

    GROUP_CONCAT(DISTINCT d.dimm_sn ORDER BY d.id SEPARATOR ',') AS dimm_sns

FROM builds b

LEFT JOIN project_name pn 
    ON b.project_name = pn.id

LEFT JOIN dimm_serial_numbers d 
    ON b.chassis_sn = d.chassis_sn

WHERE ${whereClause}

GROUP BY b.chassis_sn

ORDER BY b.updated_at DESC;
  `;

  dbQuery(query, queryParams, (err, results) => {
    if (err) {
      console.error('Error searching builds for edit:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log(`Found ${results.length} builds matching search criteria`);

    // Process results
    results.forEach(build => {
      build.dimmSNs = build.dimm_sns ? build.dimm_sns.split(',') : [];
      delete build.dimm_sns;
    });

    res.json(results);
  });
});

/**
 * PUT /api/builds/:chassisSN/edit
 *
 * Update build with edited data
 * Comprehensive update for all editable fields in EditBuildData
 * Includes validation, duplicate checking, and photo management
 *
 * @param {string} chassisSN - Chassis serial number
 * @body {object} - Complete build update data
 * @returns {object} - Success response
 */
app.put('/api/builds/:chassisSN/edit', async (req, res) => {
  const { chassisSN } = req.params;
  const updateData = req.body;

  console.log('Editing build:', chassisSN);

  let connection;

  try {
    // Get connection from pool and start transaction
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    // 1. Update main builds table
    const buildUpdateFields = [];
    const buildUpdateValues = [];

    // Chassis Information (editable)
    if (updateData.projectName !== undefined) {
      // Get project ID from projects table
      const [rows] = await connection.execute(
        'SELECT id FROM project_name WHERE project_name = ? LIMIT 1',
        [updateData.projectName]
      );

      if (rows.length === 0) {
        throw new Error(`Project not found: ${updateData.projectName}`);
      }

      const projectId = rows[0].id;

      buildUpdateFields.push('project_name = ?');
      buildUpdateValues.push(projectId);
    }
    if (updateData.jiraTicketNo !== undefined) {
      buildUpdateFields.push('jira_ticket_no = ?');
      buildUpdateValues.push(updateData.jiraTicketNo);
    }

    if (updateData.po !== undefined) {
      buildUpdateFields.push('po = ?');
      buildUpdateValues.push(updateData.po);
    }

    if (updateData.bmcMac !== undefined) {
      buildUpdateFields.push('bmc_mac = ?');
      buildUpdateValues.push(updateData.bmcMac);
    }
    if (updateData.mbSN !== undefined) {
      buildUpdateFields.push('mb_sn = ?');
      buildUpdateValues.push(updateData.mbSN);
    }
    if (updateData.ethernetMac !== undefined) {
      buildUpdateFields.push('ethernet_mac = ?');
      buildUpdateValues.push(updateData.ethernetMac);
    }
    if (updateData.cpuSocket !== undefined) {
      buildUpdateFields.push('cpu_socket = ?');
      buildUpdateValues.push(updateData.cpuSocket);
    }
    if (updateData.cpuVendor !== undefined) {
      buildUpdateFields.push('cpu_vendor = ?');
      buildUpdateValues.push(updateData.cpuVendor);
    }

    // CPU Information (editable)
    if (updateData.cpuProgramName !== undefined) {
      buildUpdateFields.push('cpu_program_name = ?');
      buildUpdateValues.push(updateData.cpuProgramName);
    }
    if (updateData.cpuP0SN !== undefined) {
      buildUpdateFields.push('cpu_p0_sn = ?');
      buildUpdateValues.push(updateData.cpuP0SN);
    }
    if (updateData.cpuP0SocketDateCode !== undefined) {
      buildUpdateFields.push('cpu_p0_socket_date_code = ?');
      buildUpdateValues.push(updateData.cpuP0SocketDateCode);
    }
    if (updateData.cpuP1SN !== undefined) {
      buildUpdateFields.push('cpu_p1_sn = ?');
      buildUpdateValues.push(updateData.cpuP1SN);
    }
    if (updateData.cpuP1SocketDateCode !== undefined) {
      buildUpdateFields.push('cpu_p1_socket_date_code = ?');
      buildUpdateValues.push(updateData.cpuP1SocketDateCode);
    }

    // Component Information (editable)
    if (updateData.m2PN !== undefined) {
      buildUpdateFields.push('m2_pn = ?');
      buildUpdateValues.push(updateData.m2PN);
    }
    if (updateData.m2SN !== undefined) {
      buildUpdateFields.push('m2_sn = ?');
      buildUpdateValues.push(updateData.m2SN);
    }
    if (updateData.dimmPN !== undefined) {
      buildUpdateFields.push('dimm_pn = ?');
      buildUpdateValues.push(updateData.dimmPN);
    }
    if (updateData.dimmQty !== undefined) {
      buildUpdateFields.push('dimm_qty = ?');
      buildUpdateValues.push(updateData.dimmQty);
    }

    // Testing (editable)
    if (updateData.visualInspection !== undefined) {
      buildUpdateFields.push('visual_inspection_status = ?');
      buildUpdateValues.push(updateData.visualInspection);
    }
    if (updateData.visualInspectionNotes !== undefined) {
      buildUpdateFields.push('visual_inspection_notes = ?');
      buildUpdateValues.push(updateData.visualInspectionNotes);
    }
    if (updateData.bootStatus !== undefined) {
      buildUpdateFields.push('boot_status = ?');
      buildUpdateValues.push(updateData.bootStatus);
    }
    if (updateData.bootNotes !== undefined) {
      buildUpdateFields.push('boot_notes = ?');
      buildUpdateValues.push(updateData.bootNotes);
    }
    if (updateData.dimmsDetectedStatus !== undefined) {
      buildUpdateFields.push('dimms_detected_status = ?');
      buildUpdateValues.push(updateData.dimmsDetectedStatus);
    }
    if (updateData.dimmsDetectedNotes !== undefined) {
      buildUpdateFields.push('dimms_detected_notes = ?');
      buildUpdateValues.push(updateData.dimmsDetectedNotes);
    }
    if (updateData.lomWorkingStatus !== undefined) {
      buildUpdateFields.push('lom_working_status = ?');
      buildUpdateValues.push(updateData.lomWorkingStatus);
    }
    if (updateData.lomWorkingNotes !== undefined) {
      buildUpdateFields.push('lom_working_notes = ?');
      buildUpdateValues.push(updateData.lomWorkingNotes);
    }

    // BKC Details (editable)
    if (updateData.biosVersion !== undefined) {
      buildUpdateFields.push('bios_version = ?');
      buildUpdateValues.push(updateData.biosVersion);
    }
    if (updateData.bmcVersion !== undefined) {
      buildUpdateFields.push('bmc_version = ?');
      buildUpdateValues.push(updateData.bmcVersion);
    }
    if (updateData.scmFpgaVersion !== undefined) {
      buildUpdateFields.push('scm_fpga_version = ?');
      buildUpdateValues.push(updateData.scmFpgaVersion);
    }
    if (updateData.hpmFpgaVersion !== undefined) {
      buildUpdateFields.push('hpm_fpga_version = ?');
      buildUpdateValues.push(updateData.hpmFpgaVersion);
    }

    // Quality Details (editable)
    if (updateData.fpyStatus !== undefined) {
      buildUpdateFields.push('fpy_status = ?');
      buildUpdateValues.push(updateData.fpyStatus);
    }
    if (updateData.problemDescription !== undefined) {
      buildUpdateFields.push('problem_description = ?');
      buildUpdateValues.push(updateData.problemDescription);
    }
    if (updateData.canContinue !== undefined) {
      buildUpdateFields.push('can_continue = ?');
      buildUpdateValues.push(updateData.canContinue);
    }

    // Build Status (editable)
    if (updateData.status !== undefined) {
      buildUpdateFields.push('status = ?');
      buildUpdateValues.push(updateData.status);
    }

    // Always update timestamp
    buildUpdateFields.push('updated_at = CURRENT_TIMESTAMP');
    buildUpdateValues.push(chassisSN);

    if (buildUpdateFields.length > 1) { // More than just timestamp
      const buildUpdateQuery = `
        UPDATE builds
        SET ${buildUpdateFields.join(', ')}
        WHERE chassis_sn = ?
      `;

      await connection.execute(buildUpdateQuery, buildUpdateValues);
    }

    // 2. Update DIMM Serial Numbers
    if (updateData.dimmSNs && Array.isArray(updateData.dimmSNs)) {
      // Delete existing DIMM SNs
      await connection.execute('DELETE FROM dimm_serial_numbers WHERE chassis_sn = ?', [chassisSN]);

      // Insert new DIMM SNs
      if (updateData.dimmSNs.length > 0) {
        const dimmInsertValues = updateData.dimmSNs.filter(sn => sn && sn.trim() !== '').map(sn => [chassisSN, sn]);
        if (dimmInsertValues.length > 0) {
          await connection.query('INSERT INTO dimm_serial_numbers (chassis_sn, dimm_sn) VALUES ?', [dimmInsertValues]);
        }
      }
    }

    // 3. Update Photos
    const photoTypes = ['visual_inspection', 'boot', 'dimms_detected', 'lom_working'];
    for (const photoType of photoTypes) {
      const photoField = `${photoType}Photos`;
      if (updateData[photoField] && Array.isArray(updateData[photoField])) {
        // Delete existing photos of this type
        await connection.execute(
          'DELETE FROM build_photos WHERE chassis_sn = ? AND photo_type = ?',
          [chassisSN, photoType]
        );

        // Insert new photos
        if (updateData[photoField].length > 0) {
          const photoInsertValues = updateData[photoField].map(photo => [
            chassisSN,
            photoType,
            photo.path
          ]);
          await connection.query('INSERT INTO build_photos (chassis_sn, photo_type, file_path) VALUES ?', [photoInsertValues]);
        }
      }
    }

    // 4. Update Failure Modes
    if (updateData.failureModes && Array.isArray(updateData.failureModes)) {
      // Delete existing failures
      await connection.execute('DELETE FROM build_failures WHERE chassis_sn = ?', [chassisSN]);

      // Insert new failures
      if (updateData.failureModes.length > 0 && updateData.failureCategories) {
        const failureInsertValues = updateData.failureModes
          .filter(mode => mode && mode.trim() !== '')
          .map((mode, index) => [
            chassisSN,
            mode,
            updateData.failureCategories[index] || null
          ]);
        if (failureInsertValues.length > 0) {
          await connection.query(
            'INSERT INTO build_failures (chassis_sn, failure_mode, failure_category) VALUES ?',
            [failureInsertValues]
          );
        }
      }
    }

    // 5. Update Rework Data
    if (updateData.reworkData) {
      const { status, notes } = updateData.reworkData;

      if (status === 'Yes') {
        await connection.execute(
          `
      INSERT INTO rework_pass (chassis_sn, notes)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE
        notes = VALUES(notes)
      `,
          [chassisSN, notes || '']
        );
      } else {
        // If No → remove rework record
        await connection.execute(
          `DELETE FROM rework_pass WHERE chassis_sn = ?`,
          [chassisSN]
        );
      }
    }

    // Commit transaction
    await connection.commit();

    console.log('Incoming updateData:', updateData);
    console.log('Build edited successfully:', chassisSN);
    res.json({
      success: true,
      message: 'Build updated successfully',
      chassisSN: chassisSN
    });

  } catch (error) {
    console.error('Error editing build:', error);
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    res.status(500).json({
      error: 'Failed to update build',
      details: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// ============================================================================
// STARTBUILD API ENDPOINTS
// ============================================================================

/**
 * GET /api/platform-info/:systemPN
 * 
 * Retrieves platform type based on system part number
 * Used in StartBuild for auto-populating platform information
 * 
 * @param {string} systemPN - System part number
 * @returns {object} - { platformType: string }
 */
app.get('/api/platform-info/:systemPN', (req, res) => {
  const { systemPN } = req.params;

  const query = 'SELECT platform_type FROM platform_info WHERE system_pn = ?';

  db.query(query, [systemPN], (err, results) => {
    if (err) {
      console.error('Error fetching platform info:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'System P/N not found in platform database' });
    }

    res.json({ platformType: results[0].platform_type });
  });
});

app.get('/api/platform', (req, res) => {
  const query = `
    SELECT system_pn, platform_type
    FROM platform_info
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching platform info:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(results);
  });
});

/**
 * GET /api/manufacturer/:platformPrefix
 * 
 * Retrieves manufacturer name based on platform prefix
 * Used for auto-populating manufacturer field in SystemInfo
 * 
 * @param {string} platformPrefix - Platform prefix from system PN
 * @returns {object} - { manufacturer: string }
 */
app.get('/api/manufacturer/:platformPrefix', (req, res) => {
  const { platformPrefix } = req.params;

  const query = 'SELECT manufacturer_name FROM manufacturers WHERE platform_prefix = ?';

  db.query(query, [platformPrefix], (err, results) => {
    if (err) {
      console.error('Error fetching manufacturer:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ manufacturer: 'Unknown' });
    }

    res.json({ manufacturer: results[0].manufacturer_name });
  });
});

/**
 * POST /api/part-numbers
 * 
 * Add new part number to the database
 * Called when user enters a custom part number through "Other" option
 * 
 * @body {string} partNumber - The new part number to add
 * @body {string} type - Part type ('Drive' or 'Module')
 * @returns {object} - Success response
 */
app.post('/api/part-numbers', (req, res) => {
  const { partNumber, type } = req.body;

  // Validate input
  if (!partNumber || !type) {
    return res.status(400).json({ error: 'Part number and type are required' });
  }

  if (type !== 'Drive' && type !== 'Module') {
    return res.status(400).json({ error: 'Invalid type. Must be "Drive" or "Module"' });
  }

  // Check if part number already exists
  const checkQuery = 'SELECT part_number FROM part_numbers WHERE part_number = ? AND type = ?';

  db.query(checkQuery, [partNumber, type], (err, results) => {
    if (err) {
      console.error('Error checking part number:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length > 0) {
      // Part number already exists, return success anyway
      return res.json({
        message: 'Part number already exists',
        partNumber,
        type,
        alreadyExists: true
      });
    }

    // Insert new part number
    const insertQuery = 'INSERT INTO part_numbers (part_number, type) VALUES (?, ?)';

    db.query(insertQuery, [partNumber, type], (err, result) => {
      if (err) {
        console.error('Error inserting part number:', err);
        return res.status(500).json({ error: 'Failed to add part number' });
      }

      console.log(`New part number added: ${partNumber} (${type})`);

      res.json({
        message: 'Part number added successfully',
        partNumber,
        type,
        alreadyExists: false
      });
    });
  });
});

/**
 * GET /api/part-numbers/search
 * 
 * Search part numbers with autocomplete functionality
 * Supports M.2 (Drive) and DIMM (Module) part numbers
 * 
 * @query {string} query - Search term (partial part number)
 * @query {string} type - Part type ('Drive' or 'Module')
 * @returns {object} - { suggestions: string[] }
 */
app.get('/api/part-numbers/search', (req, res) => {
  const { query = '', type } = req.query;

  let sqlQuery = 'SELECT part_number FROM part_numbers WHERE 1=1';
  const params = [];

  if (type) {
    sqlQuery += ' AND type = ?';
    params.push(type);
  }

  if (query) {
    sqlQuery += ' AND part_number LIKE ?';
    params.push(`%${query}%`);
  }

  sqlQuery += ' ORDER BY part_number LIMIT 50';

  db.query(sqlQuery, params, (err, results) => {
    if (err) {
      console.error('Error searching part numbers:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const suggestions = results.map(row => row.part_number);
    res.json({ suggestions });
  });
});

/**
 * POST /api/check-duplicates
 * 
 * Validates serial numbers for duplicates across the system
 * Supports both new builds and rework mode (excludes current build)
 * 
 * @body {object} - Serial numbers to check and rework mode flag
 * @returns {object} - { hasDuplicates: boolean, duplicates: object }
 */
app.post('/api/check-duplicates', (req, res) => {
  const { chassisSN, mbSN, bmcMac, ethernetMac, cpuP0SN, cpuP1SN, m2SN, dimmSNs, isReworkMode } = req.body;

  const duplicates = {
    chassisSN: false,
    mbSN: false,
    bmcMac: false,
    ethernetMac: false
    // Removed: cpuP0SN, cpuP1SN, m2SN, dimmSNs - duplicates now allowed
  };

  // In rework mode, check if build exists first
  if (isReworkMode) {
    const checkBuildQuery = 'SELECT chassis_sn, status FROM builds WHERE chassis_sn = ?';
    db.query(checkBuildQuery, [chassisSN], (err, results) => {
      if (err) {
        console.error('Error checking build existence:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(404).json({
          notFound: true,
          error: 'Build not found. Please save the build first before entering rework mode.'
        });
      }

      const buildStatus = results[0].status;
      if (buildStatus !== 'In Progress' && buildStatus !== 'Complete' && buildStatus !== 'Fail') {
        return res.status(400).json({
          invalidStatus: true,
          error: 'Build must be saved before rework can be performed.'
        });
      }

      // Continue with duplicate checks excluding current build
      checkDuplicatesExcludingCurrent();
    });
  } else {
    // Normal mode - check all duplicates
    checkAllDuplicates();
  }

  /**
   * Check for duplicates excluding the current chassis (rework mode)
   */
  function checkDuplicatesExcludingCurrent() {
    const queries = [];

    // Check each serial number type excluding current chassis
    if (mbSN) {
      queries.push(new Promise((resolve) => {
        db.query('SELECT mb_sn FROM builds WHERE mb_sn = ? AND chassis_sn != ?',
          [mbSN, chassisSN], (err, results) => {
            if (!err && results.length > 0) duplicates.mbSN = true;
            resolve();
          });
      }));
    }

    if (bmcMac) {
      queries.push(new Promise((resolve) => {
        db.query('SELECT bmc_mac FROM builds WHERE bmc_mac = ? AND chassis_sn != ?',
          [bmcMac, chassisSN], (err, results) => {
            if (!err && results.length > 0) duplicates.bmcMac = true;
            resolve();
          });
      }));
    }

    if (ethernetMac) {
      queries.push(new Promise((resolve) => {
        db.query('SELECT ethernet_mac FROM builds WHERE ethernet_mac = ? AND chassis_sn != ?',
          [ethernetMac, chassisSN], (err, results) => {
            if (!err && results.length > 0) duplicates.ethernetMac = true;
            resolve();
          });
      }));
    }

    // Removed: cpuP0SN, cpuP1SN, m2SN, dimmSNs validation - duplicates now allowed

    Promise.all(queries).then(() => {
      const hasDuplicates = Object.values(duplicates).some(val =>
        Array.isArray(val) ? val.length > 0 : val
      );

      res.json({ hasDuplicates, duplicates });
    });
  }

  /**
   * Check for duplicates across all builds (new build mode)
   */
  function checkAllDuplicates() {
    const queries = [];

    // Check chassis S/N
    if (chassisSN) {
      queries.push(new Promise((resolve) => {
        db.query('SELECT chassis_sn FROM builds WHERE chassis_sn = ?', [chassisSN], (err, results) => {
          if (!err && results.length > 0) duplicates.chassisSN = true;
          resolve();
        });
      }));
    }

    // Check other serial numbers (similar to above but without exclusion)
    if (mbSN) {
      queries.push(new Promise((resolve) => {
        db.query('SELECT mb_sn FROM builds WHERE mb_sn = ?', [mbSN], (err, results) => {
          if (!err && results.length > 0) duplicates.mbSN = true;
          resolve();
        });
      }));
    }

    if (bmcMac) {
      queries.push(new Promise((resolve) => {
        db.query('SELECT bmc_mac FROM builds WHERE bmc_mac = ?', [bmcMac], (err, results) => {
          if (!err && results.length > 0) duplicates.bmcMac = true;
          resolve();
        });
      }));
    }

    if (ethernetMac) {
      queries.push(new Promise((resolve) => {
        db.query('SELECT ethernet_mac FROM builds WHERE ethernet_mac = ?', [ethernetMac], (err, results) => {
          if (!err && results.length > 0) duplicates.ethernetMac = true;
          resolve();
        });
      }));
    }

    // Removed: cpuP0SN, cpuP1SN, m2SN, dimmSNs validation - duplicates now allowed

    Promise.all(queries).then(() => {
      const hasDuplicates = Object.values(duplicates).some(val =>
        Array.isArray(val) ? val.length > 0 : val
      );

      res.json({ hasDuplicates, duplicates });
    });
  }
});

/**
 * POST /api/upload-photo
 * 
 * Upload single photo file for testing documentation
 * Returns file path for database storage
 * 
 * @body {File} photo - Image file
 * @body {string} type - Photo type (visual_inspection, boot, etc.)
 * @returns {object} - { filePath: string, fileName: string }
 */
app.post('/api/upload-photo', upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const relativePath = path.relative(path.join(__dirname, 'uploads'), req.file.path).replace(/\\/g, '/');
  const filePath = `uploads/${relativePath}`;
  res.json({
    filePath: filePath,
    fileName: req.file.filename
  });
});

/**
 * Helper function to check for duplicates
 * Returns Promise<{ hasDuplicates: boolean, duplicates: object }>
 */
async function checkForDuplicates(chassisSN, mbSN, bmcMac, ethernetMac, isReworkMode = false) {
  const duplicates = {
    chassisSN: false,
    mbSN: false,
    bmcMac: false,
    ethernetMac: false
  };

  const queries = [];

  if (isReworkMode) {
    // Rework mode - for chassis, we don't check duplicates since we're updating the same record
    // Skip chassis duplicate check in rework mode

    if (mbSN) {
      queries.push(
        db.promise().query('SELECT mb_sn FROM builds WHERE mb_sn = ? AND chassis_sn != ?', [mbSN, chassisSN])
          .then(([results]) => { if (results.length > 0) duplicates.mbSN = true; })
      );
    }

    if (bmcMac) {
      queries.push(
        db.promise().query('SELECT bmc_mac FROM builds WHERE bmc_mac = ? AND chassis_sn != ?', [bmcMac, chassisSN])
          .then(([results]) => { if (results.length > 0) duplicates.bmcMac = true; })
      );
    }

    if (ethernetMac) {
      queries.push(
        db.promise().query('SELECT ethernet_mac FROM builds WHERE ethernet_mac = ? AND chassis_sn != ?', [ethernetMac, chassisSN])
          .then(([results]) => { if (results.length > 0) duplicates.ethernetMac = true; })
      );
    }
  } else {
    // New build mode - check all duplicates
    if (chassisSN) {
      queries.push(
        db.promise().query('SELECT chassis_sn FROM builds WHERE chassis_sn = ?', [chassisSN])
          .then(([results]) => { if (results.length > 0) duplicates.chassisSN = true; })
      );
    }

    if (mbSN) {
      queries.push(
        db.promise().query('SELECT mb_sn FROM builds WHERE mb_sn = ?', [mbSN])
          .then(([results]) => { if (results.length > 0) duplicates.mbSN = true; })
      );
    }

    if (bmcMac) {
      queries.push(
        db.promise().query('SELECT bmc_mac FROM builds WHERE bmc_mac = ?', [bmcMac])
          .then(([results]) => { if (results.length > 0) duplicates.bmcMac = true; })
      );
    }

    if (ethernetMac) {
      queries.push(
        db.promise().query('SELECT ethernet_mac FROM builds WHERE ethernet_mac = ?', [ethernetMac])
          .then(([results]) => { if (results.length > 0) duplicates.ethernetMac = true; })
      );
    }
  }

  await Promise.all(queries);

  const hasDuplicates = Object.values(duplicates).some(val => val === true);
  return { hasDuplicates, duplicates };
}

/**
 * POST /api/builds
 * 
 * Create or update a complete build record with all associated data
 * FIXED: Column count mismatch in INSERT statement
 * 
 * @body {object} - Complete build data including:
 *   - location, isCustomConfig
 *   - systemInfo (chassis, components, testing results)
 *   - qualityDetails (FPY status, failures, rework options)
 *   - status (In Progress, Complete, Fail)
 * @returns {object} - Success response with chassis SN and final status
 */
app.post('/api/builds', async (req, res) => {
  // Accept both camelCase and snake_case for build engineer
  const { location, isCustomConfig, systemInfo, qualityDetails, status, buildEngineer, build_engineer } = req.body;

  // Prefer snake_case if present, else camelCase
  const resolvedBuildEngineer = build_engineer || buildEngineer || null;
  console.log('Saving build with details:', {
    chassis_sn: systemInfo?.chassisSN,
    buildEngineer: resolvedBuildEngineer,
    qualityDetails: qualityDetails || 'Not provided',
    status: status || 'Not provided',
    saveOption: qualityDetails?.saveOption || 'Not provided'
  });

  let connection;

  try {
    // Get connection from pool and start transaction
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    // Check for duplicates BEFORE attempting any database operations
    const duplicateCheckResult = await checkForDuplicates(
      systemInfo.chassisSN,
      systemInfo.mbSN,
      systemInfo.bmcMac,
      systemInfo.ethernetMac,
      qualityDetails?.saveOption === 'rework' // isReworkMode
    );

    if (duplicateCheckResult.hasDuplicates) {
      const duplicateFields = Object.entries(duplicateCheckResult.duplicates)
        .filter(([_, isDuplicate]) => isDuplicate)
        .map(([field, _]) => field);

      throw new Error(`Duplicate entries found: ${duplicateFields.join(', ')}. Please check these serial numbers and try again.`);
    }

    // Calculate FPY status if not provided
    let fpyStatus = null;
    if (qualityDetails?.fpyStatus) {
      fpyStatus = qualityDetails.fpyStatus;
    } else if (systemInfo) {
      fpyStatus = (
        systemInfo.visualInspection === 'Pass' &&
        systemInfo.bootStatus === 'Yes' &&
        systemInfo.dimmsDetectedStatus === 'Yes' &&
        systemInfo.lomWorkingStatus === 'Yes'
      ) ? 'Pass' : 'Fail';
    }

    // CENTRALIZED STATUS MAPPING - consistent with frontend
    let finalBuildStatus = 'In Progress'; // default

    if (status) {
      // If explicit status is provided, use it (from frontend)
      finalBuildStatus = status;
      console.log('Using explicit status from frontend:', finalBuildStatus);
    } else if (qualityDetails?.saveOption) {
      // Otherwise, map from saveOption (backend fallback)
      switch (qualityDetails.saveOption) {
        case 'continue':
          finalBuildStatus = 'In Progress';
          break;
        case 'failed':
          finalBuildStatus = 'Fail';
          break;
        case 'complete':
          finalBuildStatus = 'Complete';
          break;
        default:
          finalBuildStatus = 'In Progress';
      }
      console.log('Mapped from saveOption:', qualityDetails.saveOption, 'to status:', finalBuildStatus);
    } else {
      console.log('Using default status:', finalBuildStatus);
    }

    // Validate status
    const validStatuses = ['In Progress', 'Complete', 'Fail'];
    if (!validStatuses.includes(finalBuildStatus)) {
      throw new Error(`Invalid status value: ${finalBuildStatus}`);
    }

    console.log('Final build status for database:', finalBuildStatus);

    // Map quality details to database fields
    let canContinue = null;
    if (qualityDetails?.canRework) {
      if (qualityDetails.canRework === 'Yes, Need to update hardware/PCBA information') {
        canContinue = 'Yes';
      } else if (qualityDetails.canRework === 'No, mark this build as a failed build') {
        canContinue = 'No';
      }
    }

    // Get project id from project_name table
    const [projectRows] = await connection.query(
      `SELECT id FROM project_name WHERE project_name = ?`,
      [systemInfo.projectName]
    );

    if (projectRows.length === 0) {
      throw new Error(`Project not found: ${systemInfo.projectName}`);
    }

    const projectId = projectRows[0].id;

    console.log("po:", systemInfo.po);

    // FIXED: Insert main build record with correct number of values
    const buildQuery = `
      INSERT INTO builds (
        chassis_sn, location, build_engineer, is_custom_config, project_name, system_pn, 
        platform_type, manufacturer, chassis_type, bmc_name, bmc_mac, mb_sn, 
        ethernet_mac, cpu_socket, cpu_vendor, jira_ticket_no, po, cpu_program_name, 
        cpu_p0_sn, cpu_p0_socket_date_code, cpu_p1_sn, cpu_p1_socket_date_code, m2_pn, m2_sn, dimm_pn, dimm_qty, 
        visual_inspection_status, visual_inspection_notes, boot_status, boot_notes, 
        dimms_detected_status, dimms_detected_notes, lom_working_status, lom_working_notes, 
        fpy_status, problem_description, can_continue, status, bios_version, 
        scm_fpga_version, hpm_fpga_version, bmc_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        location = VALUES(location),
        build_engineer = VALUES(build_engineer),
        is_custom_config = VALUES(is_custom_config),
        project_name = VALUES(project_name),
        system_pn = VALUES(system_pn),
        platform_type = VALUES(platform_type),
        manufacturer = VALUES(manufacturer),
        chassis_type = VALUES(chassis_type),
        bmc_name = VALUES(bmc_name),
        bmc_mac = VALUES(bmc_mac),
        mb_sn = VALUES(mb_sn),
        ethernet_mac = VALUES(ethernet_mac),
        cpu_socket = VALUES(cpu_socket),
        cpu_vendor = VALUES(cpu_vendor),
        jira_ticket_no = VALUES(jira_ticket_no),
        po = VALUES(po),
        cpu_p0_sn = VALUES(cpu_p0_sn),
        cpu_p0_socket_date_code = VALUES(cpu_p0_socket_date_code),
        cpu_p1_sn = VALUES(cpu_p1_sn),
        cpu_p1_socket_date_code = VALUES(cpu_p1_socket_date_code),
        cpu_program_name = VALUES(cpu_program_name),
        m2_pn = VALUES(m2_pn),
        m2_sn = VALUES(m2_sn),
        dimm_pn = VALUES(dimm_pn),
        dimm_qty = VALUES(dimm_qty),
        visual_inspection_status = VALUES(visual_inspection_status),
        visual_inspection_notes = VALUES(visual_inspection_notes),
        boot_status = VALUES(boot_status),
        boot_notes = VALUES(boot_notes),
        dimms_detected_status = VALUES(dimms_detected_status),
        dimms_detected_notes = VALUES(dimms_detected_notes),
        lom_working_status = VALUES(lom_working_status),
        lom_working_notes = VALUES(lom_working_notes),
        fpy_status = VALUES(fpy_status),
        problem_description = VALUES(problem_description),
        can_continue = VALUES(can_continue),
        status = VALUES(status),
        bios_version = VALUES(bios_version),
        scm_fpga_version = VALUES(scm_fpga_version),
        hpm_fpga_version = VALUES(hpm_fpga_version),
        bmc_version = VALUES(bmc_version),
        updated_at = CURRENT_TIMESTAMP
    `;

    // FIXED: Include ALL values including BKC details (39 values total)
    const buildValues = [
      systemInfo.chassisSN,                           // 1. chassis_sn
      location,                                       // 2. location
      resolvedBuildEngineer,                          // 3. build_engineer
      isCustomConfig ? 1 : 0,                        // 4. is_custom_config
      projectId,                        // 5. project_name
      systemInfo.systemPN,                           // 6. system_pn
      systemInfo.platformType,                       // 7. platform_type
      systemInfo.manufacturer,                       // 8. manufacturer
      systemInfo.chassisType,                        // 9. chassis_type
      systemInfo.bmcName,                             // 10. bmc_name
      systemInfo.bmcMac,                             // 11. bmc_mac
      systemInfo.mbSN,                               // 12. mb_sn
      systemInfo.ethernetMac || null,                // 13. ethernet_mac
      systemInfo.cpuSocket,                          // 14. cpu_socket
      systemInfo.cpuVendor || null,                  // 15. cpu_vendor
      systemInfo.jiraTicketNo || null,               // 16. jira_ticket_no
      systemInfo.po || null,
      systemInfo.cpuProgramName,                     // 17. cpu_program_name
      systemInfo.cpuP0SN || null,                    // 18. cpu_p0_sn
      systemInfo.cpuP0SocketDateCode || null,        // 19. cpu_p0_socket_date_code
      systemInfo.cpuP1SN || null,                    // 20. cpu_p1_sn
      systemInfo.cpuP1SocketDateCode || null,        // 21. cpu_p1_socket_date_code
      systemInfo.m2PN,                               // 22. m2_pn
      systemInfo.m2SN,                               // 21. m2_sn
      systemInfo.dimmPN,                             // 22. dimm_pn
      systemInfo.dimmQty,                            // 23. dimm_qty
      systemInfo.visualInspection,                   // 24. visual_inspection_status
      systemInfo.visualInspectionNotes || null,     // 25. visual_inspection_notes
      systemInfo.bootStatus,                         // 26. boot_status
      systemInfo.bootNotes || null,                  // 27. boot_notes
      systemInfo.dimmsDetectedStatus,                // 28. dimms_detected_status
      systemInfo.dimmsDetectedNotes || null,         // 29. dimms_detected_notes
      systemInfo.lomWorkingStatus,                   // 30. lom_working_status
      systemInfo.lomWorkingNotes || null,            // 31. lom_working_notes
      fpyStatus,                                      // 32. fpy_status
      qualityDetails?.problemDescription || null,    // 33. problem_description
      canContinue,                                    // 34. can_continue
      finalBuildStatus,                               // 35. status
      // FIXED: Added missing BKC details (4 more values)
      systemInfo.bkcDetails?.biosVersion || null,    // 36. bios_version
      systemInfo.bkcDetails?.scmFpgaVersion || null, // 37. scm_fpga_version
      systemInfo.bkcDetails?.hpmFpgaVersion || null, // 38. hpm_fpga_version
      systemInfo.bkcDetails?.bmcVersion || null      // 39. bmc_version
    ];

    console.log(`Executing INSERT with ${buildValues.length} values for 41 columns`);

    const [buildResult] = await connection.execute(buildQuery, buildValues);

    // Verify build was actually inserted
    if (!buildResult.insertId && !buildResult.affectedRows) {
      throw new Error('Failed to save build: Build INSERT did not create any record');
    }

    console.log(`Build successfully inserted with ${buildResult.affectedRows} affected rows`);


    // Handle DIMM serial numbers
    if (systemInfo.dimmSNs && systemInfo.dimmSNs.length > 0) {
      // First delete existing DIMMs for this chassis
      await connection.execute('DELETE FROM dimm_serial_numbers WHERE chassis_sn = ?', [systemInfo.chassisSN]);

      // Insert new DIMMs
      const validDimmSNs = systemInfo.dimmSNs.filter(sn => sn && sn.trim() !== '');
      for (const dimmSN of validDimmSNs) {
        await connection.execute(
          'INSERT INTO dimm_serial_numbers (chassis_sn, dimm_sn) VALUES (?, ?)',
          [systemInfo.chassisSN, dimmSN]
        );
      }
    }

    // Handle photos
    if (systemInfo.uploadedPhotos && systemInfo.uploadedPhotos.length > 0) {
      // Delete existing photos for this chassis first
      await connection.execute('DELETE FROM build_photos WHERE chassis_sn = ?', [systemInfo.chassisSN]);

      // Insert new photos
      for (const photo of systemInfo.uploadedPhotos) {
        await connection.execute(
          'INSERT INTO build_photos (chassis_sn, photo_type, file_path) VALUES (?, ?, ?)',
          [systemInfo.chassisSN, photo.type, photo.path]
        );
      }
    }

    // Handle failure records
    if (qualityDetails?.failureModes && qualityDetails.failureModes.length > 0) {
      // Delete existing failures first
      await connection.execute('DELETE FROM build_failures WHERE chassis_sn = ?', [systemInfo.chassisSN]);

      // Insert new failures
      for (let i = 0; i < qualityDetails.failureModes.length; i++) {
        if (qualityDetails.failureModes[i] && qualityDetails.failureCategories[i]) {
          await connection.execute(
            'INSERT INTO build_failures (chassis_sn, failure_mode, failure_category) VALUES (?, ?, ?)',
            [systemInfo.chassisSN, qualityDetails.failureModes[i], qualityDetails.failureCategories[i]]
          );
        }
      }
    }

    // Auto-map to master status
    if (finalBuildStatus) {
      const autoMappedStatus = getAutoMappedMasterStatus(finalBuildStatus);

      if (autoMappedStatus) {
        try {
          await connection.execute(
            'INSERT INTO master_builds (chassis_sn, master_status) VALUES (?, ?) ON DUPLICATE KEY UPDATE master_status = ?',
            [systemInfo.chassisSN, autoMappedStatus, autoMappedStatus]
          );
          console.log(`Auto-mapped master status for ${systemInfo.chassisSN} to: ${autoMappedStatus}`);
        } catch (error) {
          console.error('Error auto-mapping master status:', error);
          // Don't fail the whole transaction for this
        }
      }
    }

    // Commit transaction
    await connection.commit();

    res.json({
      success: true,
      message: 'Build saved successfully',
      chassisSN: systemInfo.chassisSN,
      status: finalBuildStatus,
      fpyStatus: fpyStatus
    });

  } catch (error) {
    // Rollback transaction on error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Error rolling back transaction:', rollbackError);
      }
    }

    console.error('Error saving build:', error);
    res.status(500).json({
      error: 'Failed to save build',
      message: error.message
    });
  } finally {
    // Always release the connection back to the pool
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/builds/:chassisSN
 * 
 * Retrieve complete build details by chassis serial number
 * Includes DIMM serial numbers and associated photos
 * 
 * @param {string} chassisSN - Chassis serial number
 * @returns {object} - Complete build record with related data
 */
app.get('/api/builds/:chassisSN', (req, res) => {
  const { chassisSN } = req.params;

  // Get build details
  const buildQuery = 'SELECT * FROM builds WHERE chassis_sn = ?';

  db.query(buildQuery, [chassisSN], (err, buildResults) => {
    if (err) {
      console.error('Error fetching build:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (buildResults.length === 0) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const build = buildResults[0];

    // Get DIMM serial numbers
    const dimmQuery = 'SELECT dimm_sn FROM dimm_serial_numbers WHERE chassis_sn = ? ORDER BY id';

    db.query(dimmQuery, [chassisSN], (err, dimmResults) => {
      if (err) {
        console.error('Error fetching DIMM serial numbers:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      // Get photos
      const photoQuery = 'SELECT * FROM build_photos WHERE chassis_sn = ?';

      db.query(photoQuery, [chassisSN], (err, photoResults) => {
        if (err) {
          console.error('Error fetching photos:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        // Format response
        const response = {
          ...build,
          dimmSNs: dimmResults.map(d => d.dimm_sn),
          photos: photoResults
        };

        res.json(response);
      });
    });
  });
});

/**
 * PATCH /api/builds/:chassisSN/status
 * 
 * Update build status (In Progress, Complete, Fail)
 * Used after successful rework completion
 * 
 * @param {string} chassisSN - Chassis serial number
 * @body {string} status - New status value
 * @returns {object} - Success response with updated status
 */
app.patch('/api/builds/:chassisSN/status', async (req, res) => {
  const { chassisSN } = req.params;
  const { status } = req.body;

  console.log(`Received status update request for ${chassisSN}: ${status}`);

  // Validate status
  const validStatuses = ['In Progress', 'Complete', 'Fail'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  let connection;

  try {
    // Get connection from pool
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    // Update build status
    const buildQuery = 'UPDATE builds SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE chassis_sn = ?';
    const [buildResults] = await connection.execute(buildQuery, [status, chassisSN]);

    if (buildResults.affectedRows === 0) {
      throw new Error('Build not found');
    }

    // Auto-map to master status
    const autoMappedStatus = getAutoMappedMasterStatus(status);

    if (autoMappedStatus) {
      // Check if master build record exists
      const [masterExists] = await connection.execute(
        'SELECT chassis_sn FROM master_builds WHERE chassis_sn = ?',
        [chassisSN]
      );

      if (masterExists.length > 0) {
        // Update existing master status
        await connection.execute(
          'UPDATE master_builds SET master_status = ?, updated_at = CURRENT_TIMESTAMP WHERE chassis_sn = ?',
          [autoMappedStatus, chassisSN]
        );
      } else {
        // Create new master build record with auto-mapped status
        await connection.execute(
          'INSERT INTO master_builds (chassis_sn, master_status) VALUES (?, ?)',
          [chassisSN, autoMappedStatus]
        );
      }
    }

    await connection.commit();

    console.log(`Build ${chassisSN} status updated to: ${status}, master status auto-mapped to: ${autoMappedStatus}`);
    res.json({
      success: true,
      message: `Build status updated to ${status}`,
      status: status,
      masterStatus: autoMappedStatus
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error updating build status:', error);
    res.status(500).json({ error: error.message || 'Database error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// POST /api/rework-pass
app.post('/api/rework-pass', async (req, res) => {
  const { chassis_sn, notes } = req.body;

  console.log('Incoming body:', req.body);

  if (!chassis_sn) {
    return res.status(400).json({ error: 'chassis_sn is required' });
  }

  try {
    await db.promise().execute(
      `INSERT INTO rework_pass (chassis_sn, notes)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
       notes = VALUES(notes)`,
      [chassis_sn, notes || null]
    );

    res.json({
      success: true,
      message: 'Rework pass saved successfully'
    });

  } catch (error) {
    console.error('Error inserting rework pass:', error);
    res.status(500).json({ error: 'Database error' });
  }
});



app.get('/api/rework-pass/:chassisSN', async (req, res) => {
  const { chassisSN } = req.params;

  try {
    const [rows] = await db.promise().execute(
      `SELECT chassis_sn, notes FROM rework_pass WHERE chassis_sn = ?`,
      [chassisSN]
    );

    res.json(rows[0] || null);
  } catch (error) {
    console.error('Error fetching rework:', error);
    res.status(500).json({ error: 'Database error' });
  }
});


app.get('/api/rma/:chassisSN', async (req, res) => {
  const { chassisSN } = req.params;

  try {
    const [rows] = await db.promise().execute(
      `SELECT * FROM rma WHERE chassis_sn = ?`,
      [chassisSN]
    );

    res.json(rows[0] || null);
  } catch (error) {
    console.error('Error fetching rework:', error);
    res.status(500).json({ error: 'Database error' });
  }
});


app.get('/api/rma-history/:chassis_sn', async (req, res) => {
  const { chassis_sn } = req.params;

  try {
    const [rows] = await db.promise().execute(
      `
      SELECT 
        chassis_sn,
        pass_fail,
        notes,
        dimm,
        bmc,
        m2,
        liquid_cooler,
        location,
        rma,
        status,
        updated_at,
        updated_by
      FROM rma_history
      WHERE chassis_sn = ?
      ORDER BY updated_at DESC
      `,
      [chassis_sn]
    );

    res.json(rows);
  } catch (error) {
    console.error('Error fetching RMA history:', error);
    res.status(500).json({ error: 'Database error' });
  }
});


// POST /api/rma
app.post('/api/rma', async (req, res) => {
  const {
    chassis_sn,
    pass_fail,
    notes,
    dimm,
    bmc,
    m2,
    liquid_cooler,
    location,
    rma,
    status,
    updated_by
  } = req.body;

  if (!chassis_sn) {
    return res.status(400).json({ error: 'chassis_sn is required' });
  }

  try {
    // 🔥 1. Check if existing record exists
    const [existingRows] = await db.promise().execute(
      `SELECT * FROM rma WHERE chassis_sn = ?`,
      [chassis_sn]
    );

    // 🔥 2. If exists → save to history BEFORE update
    if (existingRows.length > 0) {
      const current = existingRows[0];

      await db.promise().execute(
        `
        INSERT INTO rma_history (
          chassis_sn,
          pass_fail,
          notes,
          dimm,
          bmc,
          m2,
          liquid_cooler,
          location,
          rma,
          status,
          updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          current.chassis_sn,
          current.pass_fail,
          current.notes,
          current.dimm,
          current.bmc,
          current.m2,
          current.liquid_cooler,
          current.location,
          current.rma,
          current.status,
          updated_by || 'unknown'
        ]
      );
    }

    // 🔥 3. Insert or update current table
    await db.promise().execute(
      `
      INSERT INTO rma (
        chassis_sn,
        pass_fail,
        notes,
        dimm,
        bmc,
        m2,
        liquid_cooler,
        location,
        rma,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        pass_fail = VALUES(pass_fail),
        notes = VALUES(notes),
        dimm = VALUES(dimm),
        bmc = VALUES(bmc),
        m2 = VALUES(m2),
        liquid_cooler = VALUES(liquid_cooler),
        location = VALUES(location),
        rma = VALUES(rma),
        status = VALUES(status)
      `,
      [
        chassis_sn,
        pass_fail || null,
        notes || null,
        dimm || null,
        bmc || null,
        m2 || null,
        liquid_cooler || null,
        location || null,
        rma || null,
        status || 'Available'
      ]
    );

    res.json({
      success: true,
      message: 'RMA saved + history tracked'
    });

  } catch (error) {
    console.error('Error saving RMA:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/builds/:chassisSN/complete
 * 
 * Retrieve complete build details with quality data, failures, and DIMMs
 * More comprehensive than basic getBuild - includes failure modes and quality structure
 * 
 * @param {string} chassisSN - Chassis serial number
 * @returns {object} - Complete build record with quality details formatted
 */
app.get('/api/builds/:chassisSN/complete', (req, res) => {
  const { chassisSN } = req.params;

  // Get complete build details including quality data
  const buildQuery = `
    SELECT b.*, 
           GROUP_CONCAT(DISTINCT d.dimm_sn ORDER BY d.id SEPARATOR ',') as dimm_sns,
           GROUP_CONCAT(DISTINCT CONCAT(bf.failure_mode, ':', bf.failure_category) SEPARATOR ',') as failures
    FROM builds b
    LEFT JOIN dimm_serial_numbers d ON b.chassis_sn = d.chassis_sn
    LEFT JOIN build_failures bf ON b.chassis_sn = bf.chassis_sn
    WHERE b.chassis_sn = ?
    GROUP BY b.chassis_sn
  `;

  db.query(buildQuery, [chassisSN], (err, buildResults) => {
    if (err) {
      console.error('Error fetching complete build details:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (buildResults.length === 0) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const build = buildResults[0];

    // Parse dimm serial numbers
    build.dimmSNs = build.dimm_sns ? build.dimm_sns.split(',') : [];
    delete build.dimm_sns;

    // Parse failures
    const failures = {
      failureModes: [],
      failureCategories: []
    };

    if (build.failures) {
      build.failures.split(',').forEach(failure => {
        const [mode, category] = failure.split(':');
        if (mode && category) {
          failures.failureModes.push(mode);
          failures.failureCategories.push(category);
        }
      });
    }
    delete build.failures;

    // Add quality details structure
    build.qualityDetails = {
      fpyStatus: build.fpy_status,
      problemDescription: build.problem_description,
      numberOfFailures: failures.failureModes.length.toString(),
      failureModes: failures.failureModes,
      failureCategories: failures.failureCategories,
      canRework: build.can_continue === 'Yes' ? 'Yes, Need to update hardware/PCBA information' :
        build.can_continue === 'No' ? 'No, mark this build as a failed build' : '',
      saveOption: build.status === 'In Progress' ? 'continue' :
        build.status === 'Fail' ? 'failed' :
          build.status === 'Complete' ? 'complete' : 'continue'
    };

    // Get photos
    const photoQuery = 'SELECT * FROM build_photos WHERE chassis_sn = ?';

    db.query(photoQuery, [chassisSN], (err, photoResults) => {
      if (err) {
        console.error('Error fetching photos:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      build.photos = photoResults;

      res.json(build);
    });
  });
});

// ============================================================================
// BKC (BEST KNOWN CONFIGURATION) ENDPOINTS
// ============================================================================

/**
 * POST /api/extract-firmware-versions
 * 
 * Extract firmware versions from BMC using external script
 * Returns BIOS, SCM FPGA, HPM FPGA, and BMC versions
 * 
 * @body {string} bmcName - BMC hostname/IP for connection
 * @returns {object} - { success: boolean, versions: object }
 */
app.post('/api/extract-firmware-versions', async (req, res) => {
  const { bmcName } = req.body;

  if (!bmcName) {
    return res.status(400).json({ error: 'BMC name is required' });
  }

  try {
    console.log(`Starting firmware extraction for BMC: ${bmcName}`);
    const versions = await extractBMCFirmwareVersions(bmcName);

    res.json({
      success: true,
      versions: versions
    });
  } catch (error) {
    console.error('Firmware extraction error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to extract firmware versions'
    });
  }
});

/**
 * PATCH /api/builds/:chassisSN/bkc
 * 
 * Save BKC (firmware) details to existing build
 * Updates BIOS, SCM FPGA, HPM FPGA, and BMC versions
 * 
 * @param {string} chassisSN - Chassis serial number
 * @body {object} - { biosVersion, scmFpgaVersion, hpmFpgaVersion, bmcVersion }
 * @returns {object} - Success response
 */
app.patch('/api/builds/:chassisSN/bkc', (req, res) => {
  const { chassisSN } = req.params;
  const { biosVersion, scmFpgaVersion, hpmFpgaVersion, bmcVersion } = req.body;

  const query = `
    UPDATE builds 
    SET bios_version = ?, scm_fpga_version = ?, hpm_fpga_version = ?, bmc_version = ?
    WHERE chassis_sn = ?
  `;

  db.query(query, [biosVersion, scmFpgaVersion, hpmFpgaVersion, bmcVersion, chassisSN], (err, results) => {
    if (err) {
      console.error('Error updating BKC details:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ error: 'Build not found' });
    }

    res.json({ success: true, message: 'BKC details saved successfully' });
  });
});

// ============================================================================
// QUALITY MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * GET /api/failure-modes
 * 
 * Retrieve all failure modes organized by category
 * Used for populating failure mode dropdowns in Quality Indicator
 * 
 * @returns {object} - Failure modes grouped by category
 */
app.get('/api/failure-modes', (req, res) => {
  const query = 'SELECT DISTINCT failure_mode, failure_category FROM failure_mode_category_map ORDER BY failure_category, failure_mode';

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching failure modes:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Group by category
    const grouped = results.reduce((acc, row) => {
      if (!acc[row.failure_category]) {
        acc[row.failure_category] = [];
      }
      acc[row.failure_category].push(row.failure_mode);
      return acc;
    }, {});

    res.json(grouped);
  });
});

/**
 * PATCH /api/builds/:chassisSN/quality
 * 
 * Save quality indicator details including FPY status and failure information
 * Updates build status based on saveOption and manages failure records
 * 
 * @param {string} chassisSN - Chassis serial number
 * @body {object} - Quality details including FPY, failures, and save option
 * @returns {object} - Success response
 */
app.patch('/api/builds/:chassisSN/quality', async (req, res) => {
  const { chassisSN } = req.params;
  const {
    fpyStatus,
    problemDescription,
    numberOfFailures,
    failureModes,
    failureCategories,
    canRework,
    saveOption,
    status
  } = req.body;

  console.log('Updating quality details for:', chassisSN);

  // Determine build status based on save option
  let buildStatus = 'In Progress'; // default  
  switch (saveOption) {
    case 'continue':
      buildStatus = 'In Progress';
      break;
    case 'failed':
      buildStatus = 'Fail';
      break;
    case 'complete':
      buildStatus = 'Complete';
      break;
  }

  // Map canRework to database fields
  const canContinue = canRework === 'Yes, Need to update hardware/PCBA information' ? 'Yes' :
    canRework === 'No, mark this build as a failed build' ? 'No' : null;

  let connection;

  try {
    // Get connection from pool and start transaction
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    // Update build with quality data and status including problem_description
    const updateQuery = `
      UPDATE builds 
      SET fpy_status = ?, problem_description = ?, can_continue = ?, status = ?
      WHERE chassis_sn = ?
    `;

    const [results] = await connection.execute(updateQuery, [fpyStatus, problemDescription || null, canContinue, buildStatus, chassisSN]);

    if (results.affectedRows === 0) {
      throw new Error('Build not found');
    }

    // Clear existing failures for this build
    await connection.execute('DELETE FROM build_failures WHERE chassis_sn = ?', [chassisSN]);

    // Insert new failures if any
    if (failureModes && failureModes.length > 0) {
      const failureInserts = [];

      for (let i = 0; i < failureModes.length; i++) {
        if (failureModes[i] && failureCategories[i]) {
          failureInserts.push([chassisSN, failureModes[i], failureCategories[i]]);
        }
      }

      if (failureInserts.length > 0) {
        for (const failureInsert of failureInserts) {
          await connection.execute(
            'INSERT INTO build_failures (chassis_sn, failure_mode, failure_category) VALUES (?, ?, ?)',
            failureInsert
          );
        }
      }
    }

    // Auto-map to master status
    const autoMappedStatus = getAutoMappedMasterStatus(buildStatus);

    if (autoMappedStatus) {
      // Check if master build record exists
      const [masterExists] = await connection.execute(
        'SELECT chassis_sn FROM master_builds WHERE chassis_sn = ?',
        [chassisSN]
      );

      if (masterExists.length > 0) {
        // Update existing master status
        await connection.execute(
          'UPDATE master_builds SET master_status = ?, updated_at = CURRENT_TIMESTAMP WHERE chassis_sn = ?',
          [autoMappedStatus, chassisSN]
        );
      } else {
        // Create new master build record with auto-mapped status
        await connection.execute(
          'INSERT INTO master_builds (chassis_sn, master_status) VALUES (?, ?)',
          [chassisSN, autoMappedStatus]
        );
      }
    }

    // Commit transaction
    await connection.commit();

    console.log('Quality data saved successfully for:', chassisSN);
    res.json({ success: true, message: 'Quality data saved successfully' });

  } catch (error) {
    // Rollback transaction on error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Error rolling back transaction:', rollbackError);
      }
    }

    console.error('Error updating quality data:', error);
    res.status(500).json({
      error: 'Failed to save quality data',
      message: error.message
    });
  } finally {
    // Always release the connection back to the pool
    if (connection) {
      connection.release();
    }
  }
});

// ============================================================================
// REWORK MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * PATCH /api/builds/:chassisSN/rework
 * 
 * Process rework operation - updates build with new component data
 * and maintains complete rework history with before/after tracking
 * 
 * @param {string} chassisSN - Chassis serial number
 * @body {object} systemInfo - Updated system information after rework
 * @returns {object} - Success response with rework details
 */
app.patch('/api/builds/:chassisSN/rework', async (req, res) => {
  const { chassisSN } = req.params;
  const { systemInfo } = req.body;

  // Calculate FPY status at the beginning so it's available throughout
  const fpyStatus = (
    systemInfo.visualInspection === 'Pass' &&
    systemInfo.bootStatus === 'Yes' &&
    systemInfo.dimmsDetectedStatus === 'Yes' &&
    systemInfo.lomWorkingStatus === 'Yes'
  ) ? 'Pass' : 'Fail';

  let connection;

  try {
    // Get connection from pool and start transaction
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    // Get the CURRENT build data (this reflects the current state after any previous reworks)
    const [currentBuildResults] = await connection.execute('SELECT * FROM builds WHERE chassis_sn = ?', [chassisSN]);

    if (currentBuildResults.length === 0) {
      throw new Error('Build not found');
    }

    const currentBuild = currentBuildResults[0];

    // Get the current rework number for this build
    const [reworkCountResults] = await connection.execute('SELECT MAX(rework_number) as max_rework FROM rework_history WHERE chassis_sn = ?', [chassisSN]);
    const currentReworkNumber = (reworkCountResults[0].max_rework || 0) + 1;

    // Get CURRENT DIMM SNs (not original - current state)
    const [currentDimmResults] = await connection.execute('SELECT dimm_sn FROM dimm_serial_numbers WHERE chassis_sn = ? ORDER BY id', [chassisSN]);
    const currentDimmSNs = currentDimmResults.map(d => d.dimm_sn);

    // Get CURRENT failure info if exists - for rework_failures table
    const [currentFailureResults] = await connection.execute('SELECT * FROM build_failures WHERE chassis_sn = ? ORDER BY created_at DESC', [chassisSN]);

    // Get CURRENT photos - for rework_photos table
    const [currentPhotoResults] = await connection.execute('SELECT * FROM build_photos WHERE chassis_sn = ? ORDER BY id', [chassisSN]);

    // Insert rework history - track CURRENT state being replaced by new rework
    const reworkHistoryQuery = `
      INSERT INTO rework_history (
        chassis_sn, rework_number,
        original_mb_sn, new_mb_sn,
        original_bmc_mac, new_bmc_mac,
        original_ethernet_mac, new_ethernet_mac,
        original_cpu_p0_sn, new_cpu_p0_sn,
        original_cpu_p0_socket_date_code, new_cpu_p0_socket_date_code,
        original_cpu_p1_sn, new_cpu_p1_sn,
        original_cpu_p1_socket_date_code, new_cpu_p1_socket_date_code,
        original_m2_pn, new_m2_pn,
        original_m2_sn, new_m2_sn,
        original_dimm_pn, new_dimm_pn,
        original_visual_inspection, original_visual_inspection_notes,
        original_boot_status, original_boot_notes,
        original_dimms_detected, original_dimms_detected_notes,
        original_lom_working, original_lom_working_notes,
        original_fpy_status, problem_description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // Helper function to convert undefined to null for MySQL compatibility
    const toDbValue = (value) => value === undefined ? null : value;

    const reworkValues = [
      chassisSN,
      currentReworkNumber,
      // Store CURRENT values as "original" (what's being replaced)
      toDbValue(currentBuild.mb_sn),
      systemInfo.mbSN !== currentBuild.mb_sn ? toDbValue(systemInfo.mbSN) : null,
      toDbValue(currentBuild.bmc_mac),
      systemInfo.bmcMac !== currentBuild.bmc_mac ? toDbValue(systemInfo.bmcMac) : null,
      toDbValue(currentBuild.ethernet_mac),
      systemInfo.ethernetMac !== currentBuild.ethernet_mac ? toDbValue(systemInfo.ethernetMac) : null,
      toDbValue(currentBuild.cpu_p0_sn),
      systemInfo.cpuP0SN !== currentBuild.cpu_p0_sn ? toDbValue(systemInfo.cpuP0SN) : null,
      toDbValue(currentBuild.cpu_p0_socket_date_code),
      systemInfo.cpuP0SocketDateCode !== currentBuild.cpu_p0_socket_date_code ? toDbValue(systemInfo.cpuP0SocketDateCode) : null,
      toDbValue(currentBuild.cpu_p1_sn),
      systemInfo.cpuP1SN !== currentBuild.cpu_p1_sn ? toDbValue(systemInfo.cpuP1SN) : null,
      toDbValue(currentBuild.cpu_p1_socket_date_code),
      systemInfo.cpuP1SocketDateCode !== currentBuild.cpu_p1_socket_date_code ? toDbValue(systemInfo.cpuP1SocketDateCode) : null,
      toDbValue(currentBuild.m2_pn),
      systemInfo.m2PN !== currentBuild.m2_pn ? toDbValue(systemInfo.m2PN) : null,
      toDbValue(currentBuild.m2_sn),
      systemInfo.m2SN !== currentBuild.m2_sn ? toDbValue(systemInfo.m2SN) : null,
      toDbValue(currentBuild.dimm_pn),
      systemInfo.dimmPN !== currentBuild.dimm_pn ? toDbValue(systemInfo.dimmPN) : null,
      // Store CURRENT testing state as "original" (what's being replaced)
      toDbValue(currentBuild.visual_inspection_status),
      toDbValue(currentBuild.visual_inspection_notes),
      toDbValue(currentBuild.boot_status),
      toDbValue(currentBuild.boot_notes),
      toDbValue(currentBuild.dimms_detected_status),
      toDbValue(currentBuild.dimms_detected_notes),
      toDbValue(currentBuild.lom_working_status),
      toDbValue(currentBuild.lom_working_notes),
      toDbValue(currentBuild.fpy_status),
      toDbValue(currentBuild.problem_description) // Store current problem description to history
    ];

    const [reworkResult] = await connection.execute(reworkHistoryQuery, reworkValues);
    const reworkId = reworkResult.insertId;

    // Save CURRENT failure modes to rework_failures table (what's being replaced)
    if (currentFailureResults.length > 0) {
      for (const failure of currentFailureResults) {
        await connection.execute(
          'INSERT INTO rework_failures (rework_id, failure_mode, failure_category) VALUES (?, ?, ?)',
          [reworkId, failure.failure_mode, failure.failure_category]
        );
      }
    }

    // Save CURRENT photos to rework_photos table (what's being replaced)
    if (currentPhotoResults.length > 0) {
      for (const photo of currentPhotoResults) {
        await connection.execute(
          'INSERT INTO rework_photos (rework_id, photo_type, file_path) VALUES (?, ?, ?)',
          [reworkId, photo.photo_type, photo.file_path]
        );
      }
    }

    // Save DIMM changes to rework history
    const dimmChanges = [];
    for (let i = 0; i < Math.max(currentDimmSNs.length, (systemInfo.dimmSNs || []).length); i++) {
      const currentSN = currentDimmSNs[i] || null;
      const newSN = (systemInfo.dimmSNs && systemInfo.dimmSNs[i]) || null;
      if (currentSN !== newSN) {
        dimmChanges.push([reworkId, i, currentSN, newSN]);
      }
    }

    if (dimmChanges.length > 0) {
      for (const dimmChange of dimmChanges) {
        await connection.execute(
          'INSERT INTO rework_dimm_changes (rework_id, dimm_position, original_dimm_sn, new_dimm_sn) VALUES (?, ?, ?, ?)',
          dimmChange
        );
      }
    }

    // Update the EXISTING build with new values and set problem description from rework
    const updateQuery = `
      UPDATE builds SET
        bmc_mac = ?,
        mb_sn = ?,
        ethernet_mac = ?,
        cpu_p0_sn = ?,
        cpu_p0_socket_date_code = ?,
        cpu_p1_sn = ?,
        cpu_p1_socket_date_code = ?,
        m2_pn = ?,
        m2_sn = ?,
        dimm_pn = ?,
        visual_inspection_status = ?,
        visual_inspection_notes = ?,
        boot_status = ?,
        boot_notes = ?,
        dimms_detected_status = ?,
        dimms_detected_notes = ?,
        lom_working_status = ?,
        lom_working_notes = ?,
        fpy_status = ?,
        problem_description = ?,
        status = CASE 
          WHEN ? = 'Pass' THEN 'Complete'
          ELSE status
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE chassis_sn = ?
    `;

    const updateValues = [
      toDbValue(systemInfo.bmcMac),
      toDbValue(systemInfo.mbSN),
      toDbValue(systemInfo.ethernetMac),
      toDbValue(systemInfo.cpuP0SN),
      toDbValue(systemInfo.cpuP0SocketDateCode),
      toDbValue(systemInfo.cpuP1SN),
      toDbValue(systemInfo.cpuP1SocketDateCode),
      toDbValue(systemInfo.m2PN),
      toDbValue(systemInfo.m2SN),
      toDbValue(systemInfo.dimmPN),
      toDbValue(systemInfo.visualInspection),
      toDbValue(systemInfo.visualInspectionNotes),
      toDbValue(systemInfo.bootStatus),
      toDbValue(systemInfo.bootNotes),
      toDbValue(systemInfo.dimmsDetectedStatus),
      toDbValue(systemInfo.dimmsDetectedNotes),
      toDbValue(systemInfo.lomWorkingStatus),
      toDbValue(systemInfo.lomWorkingNotes),
      toDbValue(fpyStatus),
      toDbValue(systemInfo.problemDescription), // Set problem description from rework
      toDbValue(fpyStatus), // For the CASE statement
      chassisSN
    ];

    await connection.execute(updateQuery, updateValues);

    // Delete old DIMM SNs, build failures, and build photos
    await connection.execute('DELETE FROM dimm_serial_numbers WHERE chassis_sn = ?', [chassisSN]);
    await connection.execute('DELETE FROM build_failures WHERE chassis_sn = ?', [chassisSN]);
    await connection.execute('DELETE FROM build_photos WHERE chassis_sn = ?', [chassisSN]);

    // Insert new DIMM SNs
    if (systemInfo.dimmSNs && systemInfo.dimmSNs.length > 0) {
      const validDimmSNs = systemInfo.dimmSNs.filter(sn => sn && sn.trim() !== '');

      for (const dimmSN of validDimmSNs) {
        await connection.execute(
          'INSERT INTO dimm_serial_numbers (chassis_sn, dimm_sn) VALUES (?, ?)',
          [chassisSN, dimmSN]
        );
      }
    }

    // Handle new rework photos if any
    if (systemInfo.uploadedPhotos && systemInfo.uploadedPhotos.length > 0) {
      // Normalize photo type names to match database enum values
      const normalizePhotoType = (type) => {
        const typeMap = {
          'visualInspection': 'visual_inspection',
          'boot': 'boot',
          'dimmsDetected': 'dimms_detected',
          'lomWorking': 'lom_working'
        };
        return typeMap[type] || type;
      };

      for (const photo of systemInfo.uploadedPhotos) {
        const normalizedPhotoType = normalizePhotoType(photo.type);
        await connection.execute(
          'INSERT INTO build_photos (chassis_sn, photo_type, file_path) VALUES (?, ?, ?)',
          [chassisSN, normalizedPhotoType, photo.path]
        );
      }
    }

    // Commit transaction
    await connection.commit();

    res.json({
      success: true,
      message: 'Rework saved successfully',
      reworkId: reworkId,
      reworkNumber: currentReworkNumber,
      fpyStatus: fpyStatus
    });

  } catch (error) {
    // Rollback transaction on error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Error rolling back transaction:', rollbackError);
      }
    }

    console.error('Error processing rework:', error);
    res.status(500).json({
      error: 'Failed to process rework',
      message: error.message
    });
  } finally {
    // Always release the connection back to the pool
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/builds/:chassisSN/rework-history
 * 
 * Retrieve complete rework history for a build
 * Includes component changes, DIMM changes, original failure information, and photos
 * 
 * @param {string} chassisSN - Chassis serial number
 * @returns {array} - Array of rework history records with parsed changes and photos
 */
app.get('/api/builds/:chassisSN/rework-history', (req, res) => {
  const { chassisSN } = req.params;

  const query = `
    SELECT rh.*, 
           GROUP_CONCAT(DISTINCT CONCAT(rdc.dimm_position, ':', IFNULL(rdc.original_dimm_sn, 'null'), '->', IFNULL(rdc.new_dimm_sn, 'null')) SEPARATOR '|') as dimm_changes,
           GROUP_CONCAT(DISTINCT CONCAT(rf.failure_mode, ':', rf.failure_category) SEPARATOR '|') as original_failures,
           GROUP_CONCAT(DISTINCT CONCAT(rp.photo_type, ':', rp.file_path) SEPARATOR '|') as rework_photos
    FROM rework_history rh
    LEFT JOIN rework_dimm_changes rdc ON rh.id = rdc.rework_id
    LEFT JOIN rework_failures rf ON rh.id = rf.rework_id
    LEFT JOIN rework_photos rp ON rh.id = rp.rework_id
    WHERE rh.chassis_sn = ?
    GROUP BY rh.id
    ORDER BY rh.rework_date DESC
  `;

  db.query(query, [chassisSN], (err, results) => {
    if (err) {
      console.error('Error fetching rework history:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Parse dimm_changes, original_failures, and photos
    results.forEach(row => {
      // Parse DIMM changes
      if (row.dimm_changes) {
        row.dimm_changes = row.dimm_changes.split('|').map(change => {
          const [position, sns] = change.split(':');
          const [original, newSN] = sns.split('->');
          return {
            position: parseInt(position),
            original: original === 'null' ? null : original,
            new: newSN === 'null' ? null : newSN
          };
        });
      } else {
        row.dimm_changes = [];
      }

      // Parse original failures
      if (row.original_failures) {
        row.original_failures = row.original_failures.split('|').map(failure => {
          const [mode, category] = failure.split(':');
          return {
            failure_mode: mode,
            failure_category: category
          };
        });
      } else {
        row.original_failures = [];
      }

      // Parse rework photos
      if (row.rework_photos) {
        row.photos = row.rework_photos.split('|').map(photo => {
          const [type, path] = photo.split(':');
          return {
            photo_type: type,
            file_path: path
          };
        });
      } else {
        row.photos = [];
      }

      // Clean up the temporary field
      delete row.rework_photos;
    });

    res.json(results);
  });
});

// ============================================================================
// MASTER BUILD API ENDPOINTS - CORRECTED
// ============================================================================

/**
 * GET /api/builds
 * 
 * Get all builds with optional master build data
 * UPDATED: Modified to extract Build Engineer and Jira Ticket No from builds table
 * 
 * @returns {array} - Array of builds with master data if exists
 */
app.get('/api/builds', (req, res) => {

  /*
  const query = `
    SELECT 
  b.*,
  pn.project_name AS project_name,
  GROUP_CONCAT(DISTINCT d.dimm_sn ORDER BY d.id SEPARATOR ',') as dimm_sns,
  mb.location as master_location,
  mb.custom_location,
  mb.team_security,
  mb.department,
  mb.build_name,
  mb.changegear_asset_id,
  mb.notes as master_notes,
  mb.sms_order,
  mb.cost_center,
  mb.capitalization,
  DATE_FORMAT(mb.delivery_date, '%Y-%m-%d') as delivery_date,
  mb.master_status,
  mb.created_at as master_created_at,
  mb.updated_at as master_updated_at,
  -- FIXED: Use COUNT(DISTINCT) to get accurate rework count
  CASE 
    WHEN COUNT(DISTINCT rh.id) > 0 THEN 'Yes'
    ELSE 'No'
  END as has_rework,
  COUNT(DISTINCT rh.id) as rework_count,  -- ✅ Fixed: Count distinct rework records
  CASE 
    WHEN mb.chassis_sn IS NOT NULL THEN JSON_OBJECT(
      'location', mb.location,
      'custom_location', mb.custom_location,
      'team_security', mb.team_security,
      'department', mb.department,
      'build_name', mb.build_name,
      'changegear_asset_id', mb.changegear_asset_id,
      'notes', mb.notes,
      'sms_order', mb.sms_order,
      'cost_center', mb.cost_center,
      'capitalization', mb.capitalization,
      'delivery_date', DATE_FORMAT(mb.delivery_date, '%Y-%m-%d'),
      'master_status', mb.master_status,
      -- Build Engineer and Jira Ticket No now come from builds table
      'build_engineer', b.build_engineer,
      'jira_ticket_no', b.jira_ticket_no
    )
    ELSE NULL
  END as master_data
FROM builds b
LEFT JOIN dimm_serial_numbers d ON b.chassis_sn = d.chassis_sn
LEFT JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
LEFT JOIN rework_history rh ON b.chassis_sn = rh.chassis_sn
LEFT JOIN project_name pn ON b.project_name = pn.id 
GROUP BY b.chassis_sn
ORDER BY b.created_at DESC
  `;
*/
  const query = `
SELECT 
  -- Build columns explicitly listed
  b.chassis_sn,
  b.jira_ticket_no,
  b.location,
  b.build_engineer,
  b.is_custom_config,
  CAST(pn.project_name AS CHAR) AS project_name,  -- string from project table
  b.system_pn,
  b.platform_type,
  b.manufacturer,
  b.chassis_type,
  b.bmc_name,
  b.mb_sn,
  b.ethernet_mac,
  b.cpu_socket,
  b.cpu_vendor,
  b.cpu_p0_sn,
  b.cpu_p0_socket_date_code,
  b.cpu_p1_sn,
  b.cpu_p1_socket_date_code,
  b.cpu_program_name,
  b.m2_pn,
  b.m2_sn,
  b.dimm_pn,
  b.dimm_qty,
  b.visual_inspection_status,
  b.visual_inspection_notes,
  b.boot_status,
  b.boot_notes,
  b.dimms_detected_status,
  b.dimms_detected_notes,
  b.lom_working_status,
  b.lom_working_notes,
  b.fpy_status,
  b.can_continue,
  b.status,
  b.created_at,
  b.updated_at,
  b.bios_version,
  b.bmc_version,
  b.scm_fpga_version,
  b.hpm_fpga_version,
  b.problem_description,
  b.bmc_mac,

  -- Joined / aggregated columns
  GROUP_CONCAT(DISTINCT d.dimm_sn ORDER BY d.id SEPARATOR ',') AS dimm_sns,
  mb.location AS master_location,
  mb.custom_location,
  mb.team_security,
  mb.department,
  mb.build_name,
  mb.changegear_asset_id,
  mb.notes AS master_notes,
  mb.sms_order,
  mb.cost_center,
  mb.capitalization,
  DATE_FORMAT(mb.delivery_date, '%Y-%m-%d') AS delivery_date,
  mb.master_status,
  mb.created_at AS master_created_at,
  mb.updated_at AS master_updated_at,

  -- Rework info
  CASE WHEN COUNT(DISTINCT rh.id) > 0 THEN 'Yes' ELSE 'No' END AS has_rework,
  COUNT(DISTINCT rh.id) AS rework_count,

  -- Master data JSON
  CASE 
    WHEN mb.chassis_sn IS NOT NULL THEN JSON_OBJECT(
      'project_name', pn.project_name,
      'location', mb.location,
      'custom_location', mb.custom_location,
      'team_security', mb.team_security,
      'department', mb.department,
      'build_name', mb.build_name,
      'changegear_asset_id', mb.changegear_asset_id,
      'notes', mb.notes,
      'sms_order', mb.sms_order,
      'cost_center', mb.cost_center,
      'capitalization', mb.capitalization,
      'delivery_date', DATE_FORMAT(mb.delivery_date, '%Y-%m-%d'),
      'master_status', mb.master_status,
      'build_engineer', b.build_engineer,
      'jira_ticket_no', b.jira_ticket_no
    )
    ELSE NULL
  END AS master_data

FROM builds b
LEFT JOIN dimm_serial_numbers d ON b.chassis_sn = d.chassis_sn
LEFT JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
LEFT JOIN rework_history rh ON b.chassis_sn = rh.chassis_sn
LEFT JOIN project_name pn ON b.project_name = pn.id
GROUP BY b.chassis_sn
ORDER BY b.created_at DESC;
`;
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching builds:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Parse master_data JSON string if exists and log delivery_date
    results.forEach(row => {
      if (row.master_data && typeof row.master_data === 'string') {
        try {
          row.master_data = JSON.parse(row.master_data);
        } catch (e) {
          row.master_data = null;
        }
      }

      // Debug logging for delivery_date
      if (row.delivery_date) {
        console.log(`Build ${row.chassis_sn} delivery_date:`, row.delivery_date);
      }
    });

    console.log('Returning builds data, count:', results.length);
    res.json(results);
  });
});

/**
 * POST /api/master-builds/:chassisSN
 * 
 * Create or update master build data for a chassis
 * UPDATED: Removed build_engineer and jira_ticket_no from operations
 * 
 * @param {string} chassisSN - Chassis serial number
 * @body {object} - Master build data
 * @returns {object} - Success response
 */
app.post('/api/master-builds/:chassisSN', (req, res) => {
  const { chassisSN } = req.params;
  console.log('Received master build save request for:', chassisSN);
  console.log('Request body:', req.body);

  const {
    location,
    customLocation,
    teamSecurity,
    department,
    // buildEngineer, // REMOVED - now read-only from builds table
    buildName,
    // jiraTicketNo, // REMOVED - now read-only from builds table
    changegearAssetId,
    notes,
    smsOrder,
    costCenter,
    capitalization,
    deliveryDate,
    masterStatus
  } = req.body;

  // First check if build exists
  db.query('SELECT chassis_sn FROM builds WHERE chassis_sn = ?', [chassisSN], (err, results) => {
    if (err) {
      console.error('Error checking build:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      console.error('Build not found for chassis:', chassisSN);
      return res.status(404).json({ error: 'Build not found' });
    }

    console.log('Build exists, proceeding with master data save');

    // Check if master record already exists
    db.query('SELECT * FROM master_builds WHERE chassis_sn = ?', [chassisSN], (err, existingResults) => {
      if (err) {
        console.error('Error checking existing master build:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (existingResults.length > 0) {
        // Update existing record - only update fields that are provided
        const updateFields = [];
        const updateValues = [];

        // Only update fields that are explicitly provided in the request
        if (location !== undefined && location !== '') {
          updateFields.push('location = ?');
          updateValues.push(location);
        }
        if (customLocation !== undefined) {
          updateFields.push('custom_location = ?');
          updateValues.push(customLocation || null);
        }
        if (teamSecurity !== undefined && teamSecurity !== '') {
          updateFields.push('team_security = ?');
          updateValues.push(teamSecurity);
        }
        if (department !== undefined) {
          updateFields.push('department = ?');
          updateValues.push(department || null);
        }
        // REMOVED: buildEngineer field operations
        if (buildName !== undefined) {
          updateFields.push('build_name = ?');
          updateValues.push(buildName || null);
        }
        // REMOVED: jiraTicketNo field operations
        if (changegearAssetId !== undefined) {
          updateFields.push('changegear_asset_id = ?');
          updateValues.push(changegearAssetId || null);
        }
        if (notes !== undefined) {
          updateFields.push('notes = ?');
          updateValues.push(notes || null);
        }
        if (smsOrder !== undefined) {
          updateFields.push('sms_order = ?');
          updateValues.push(smsOrder || null);
        }
        if (costCenter !== undefined) {
          updateFields.push('cost_center = ?');
          updateValues.push(costCenter || null);
        }
        if (capitalization !== undefined) {
          updateFields.push('capitalization = ?');
          updateValues.push(capitalization || null);
        }
        if (deliveryDate !== undefined) {
          updateFields.push('delivery_date = ?');
          updateValues.push(deliveryDate || null);
        }
        if (masterStatus !== undefined && masterStatus !== '') {
          updateFields.push('master_status = ?');
          updateValues.push(masterStatus);
        }

        // Always update timestamp
        updateFields.push('updated_at = CURRENT_TIMESTAMP');

        if (updateFields.length > 1) { // More than just timestamp
          updateValues.push(chassisSN); // Add chassis_sn for WHERE clause

          const updateQuery = `
            UPDATE master_builds 
            SET ${updateFields.join(', ')}
            WHERE chassis_sn = ?
          `;

          console.log('Updating with query:', updateQuery);
          console.log('Update values:', updateValues);

          db.query(updateQuery, updateValues, (err, results) => {
            if (err) {
              console.error('Error updating master build data:', err);
              return res.status(500).json({ error: 'Failed to update master build data: ' + err.message });
            }

            console.log('Master build data updated successfully:', results);
            res.json({
              success: true,
              message: 'Master build data updated successfully',
              chassisSN: chassisSN
            });
          });
        } else {
          res.json({
            success: true,
            message: 'No changes to update',
            chassisSN: chassisSN
          });
        }
      } else {
        // Insert new record - UPDATED: Removed build_engineer and jira_ticket_no
        const insertQuery = `
          INSERT INTO master_builds (
            chassis_sn, location, custom_location, team_security, department,
            build_name, changegear_asset_id, notes, sms_order, cost_center, 
            capitalization, delivery_date, master_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const insertValues = [
          chassisSN,
          location || null,
          customLocation || null,
          teamSecurity || null,
          department || null,
          // buildEngineer removed
          buildName || null,
          // jiraTicketNo removed
          changegearAssetId || null,
          notes || null,
          smsOrder || null,
          costCenter || null,
          capitalization || null,
          deliveryDate || null,
          masterStatus || null
        ];

        console.log('Inserting new master build data');

        db.query(insertQuery, insertValues, (err, results) => {
          if (err) {
            console.error('Error inserting master build data:', err);
            return res.status(500).json({ error: 'Failed to save master build data: ' + err.message });
          }

          console.log('Master build data saved successfully:', results);
          res.json({
            success: true,
            message: 'Master build data saved successfully',
            chassisSN: chassisSN
          });
        });
      }
    });
  });
});

/**
 * GET /api/master-builds/:chassisSN
 * 
 * Get master build data for specific chassis
 * UPDATED: Now includes Build Engineer and Jira Ticket No from builds table
 * 
 * @param {string} chassisSN - Chassis serial number
 * @returns {object} - Master build data with build information
 */
app.get('/api/master-builds/:chassisSN', (req, res) => {
  const { chassisSN } = req.params;

  // Updated query to include Build Engineer and Jira Ticket No from builds table
  const query = `
    SELECT 
      mb.id,
      mb.chassis_sn,
      mb.location,
      mb.custom_location,
      mb.team_security,
      mb.department,
      mb.build_name,
      mb.changegear_asset_id,
      mb.notes,
      mb.sms_order,
      mb.cost_center,
      mb.capitalization,
      DATE_FORMAT(mb.delivery_date, '%Y-%m-%d') as delivery_date,
      mb.master_status,
      mb.created_by,
      mb.created_at,
      mb.updated_at,
      -- Extract Build Engineer and Jira Ticket No from builds table
      b.build_engineer,
      b.jira_ticket_no
    FROM master_builds mb
    LEFT JOIN builds b ON mb.chassis_sn = b.chassis_sn
    WHERE mb.chassis_sn = ?
  `;

  db.query(query, [chassisSN], (err, results) => {
    if (err) {
      console.error('Error fetching master build data:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'Master build data not found' });
    }

    res.json(results[0]);
  });
});

/**
 * PATCH /api/master-builds/:chassisSN
 * 
 * Update specific fields in master build data
 * UPDATED: Removed build_engineer and jira_ticket_no from allowed fields
 * 
 * @param {string} chassisSN - Chassis serial number
 * @body {object} - Fields to update
 * @returns {object} - Success response
 */
app.patch('/api/master-builds/:chassisSN', (req, res) => {
  const { chassisSN } = req.params;
  const updates = req.body;

  // Updated allowed fields - REMOVED build_engineer and jira_ticket_no
  const allowedFields = [
    'location', 'custom_location', 'team_security', 'department',
    'build_name', 'changegear_asset_id', 'notes', 'sms_order',
    'cost_center', 'capitalization', 'delivery_date', 'master_status'
  ];

  const updateFields = [];
  const values = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      updateFields.push(`${field} = ?`);
      values.push(updates[field]);
    }
  }

  if (updateFields.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.push(chassisSN);
  const query = `
    UPDATE master_builds 
    SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
    WHERE chassis_sn = ?
  `;

  db.query(query, values, (err, results) => {
    if (err) {
      console.error('Error updating master build data:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ error: 'Master build data not found' });
    }

    res.json({
      success: true,
      message: 'Master build data updated successfully'
    });
  });
});


app.get('/api/rma', async (req, res) => {
  try {
    const [rows] = await db.promise().execute(`
      SELECT 
        chassis_sn,
        pass_fail,
        notes,
        dimm,
        bmc,
        m2,
        liquid_cooler,
        location,
        rma,
        status
      FROM rma
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching RMA');
  }
});

// ============================================================================
// SEARCH RECORDS API ENDPOINTS
// ============================================================================

/**
 * POST /api/search-builds
 * 
 * Search builds with comprehensive filters
 * Includes all build attributes and master build information
 * 
 * @body {object} - Filter criteria for search
 * @returns {array} - Array of builds matching criteria with all details
 */
app.post('/api/search-builds', (req, res) => {
  const filters = req.body;

  console.log('Search request received with filters:', filters);

  // Build the base query with all joins INCLUDING rework history
  let query = `
    SELECT 
      b.*,
      pn.project_name AS project_name,  
      GROUP_CONCAT(DISTINCT d.dimm_sn ORDER BY d.id SEPARATOR ',') as dimm_sns,
      mb.location as master_location,
      mb.custom_location,
      mb.team_security,
      mb.department,
      mb.build_name,
      mb.changegear_asset_id,
      mb.notes as master_notes,
      mb.sms_order,
      mb.cost_center,
      mb.capitalization,
      mb.delivery_date,
      mb.master_status,
      -- FIXED: Add rework information
      CASE
        WHEN COUNT(DISTINCT rh.id) > 0 THEN 'Yes'
        ELSE 'No'
      END as has_rework,
      COUNT(DISTINCT rh.id) as rework_count
    FROM builds b
    LEFT JOIN dimm_serial_numbers d ON b.chassis_sn = d.chassis_sn
    LEFT JOIN master_builds mb ON b.chassis_sn = mb.chassis_sn
    LEFT JOIN rework_history rh ON b.chassis_sn = rh.chassis_sn
    LEFT JOIN project_name pn ON b.project_name = pn.id 
    WHERE 1=1
  `;

  const params = [];

  // Build Information Filters
  if (filters.dateFrom) {
    query += ' AND DATE(b.created_at) >= ?';
    params.push(filters.dateFrom);
  }

  if (filters.dateTo) {
    query += ' AND DATE(b.created_at) <= ?';
    params.push(filters.dateTo);
  }

  if (filters.location) {
    query += ' AND b.location = ?';
    params.push(filters.location);
  }

  if (filters.isCustomConfig !== '') {
    query += ' AND b.is_custom_config = ?';
    params.push(filters.isCustomConfig);
  }

  if (filters.projectName) {
    query += ' AND pn.project_name LIKE ?';
    params.push(`%${filters.projectName}%`);
  }


  // System P/N filter - Handle both array (multi-select) and string (backward compatibility)
  if (filters.systemPN) {
    if (Array.isArray(filters.systemPN) && filters.systemPN.length > 0) {
      // Multi-select: Use OR logic - match ANY of the selected System P/Ns
      const systemPNConditions = filters.systemPN.map(() => 'b.system_pn LIKE ?').join(' OR ');
      query += ` AND (${systemPNConditions})`;
      filters.systemPN.forEach(pn => params.push(`%${pn}%`));
    } else if (typeof filters.systemPN === 'string' && filters.systemPN.trim() !== '') {
      // Legacy string format for backward compatibility
      query += ' AND b.system_pn LIKE ?';
      params.push(`%${filters.systemPN}%`);
    }
  }

  if (filters.platformType) {
    query += ' AND b.platform_type LIKE ?';
    params.push(`%${filters.platformType}%`);
  }

  if (filters.manufacturer) {
    query += ' AND b.manufacturer LIKE ?';
    params.push(`%${filters.manufacturer}%`);
  }

  // System Information Filters
  if (filters.chassisSN) {
    query += ' AND b.chassis_sn LIKE ?';
    params.push(`%${filters.chassisSN}%`);
  }

  if (filters.chassisType) {
    query += ' AND b.chassis_type LIKE ?';
    params.push(`%${filters.chassisType}%`);
  }

  if (filters.bmcName) {
    query += ' AND b.bmc_name LIKE ?';
    params.push(`%${filters.bmcName}%`);
  }

  if (filters.bmcMac) {
    query += ' AND b.bmc_mac LIKE ?';
    params.push(`%${filters.bmcMac}%`);
  }

  if (filters.mbSN) {
    query += ' AND b.mb_sn LIKE ?';
    params.push(`%${filters.mbSN}%`);
  }

  if (filters.ethernetMac) {
    query += ' AND b.ethernet_mac LIKE ?';
    params.push(`%${filters.ethernetMac}%`);
  }

  if (filters.cpuSocket) {
    query += ' AND b.cpu_socket = ?';
    params.push(filters.cpuSocket);
  }

  if (filters.cpuVendor) {
    query += ' AND b.cpu_vendor = ?';
    params.push(filters.cpuVendor);
  }

  if (filters.cpuProgramName) {
    query += ' AND b.cpu_program_name LIKE ?';
    params.push(`%${filters.cpuProgramName}%`);
  }

  // Component Information Filters
  if (filters.cpuP0SN) {
    query += ' AND b.cpu_p0_sn LIKE ?';
    params.push(`%${filters.cpuP0SN}%`);
  }

  if (filters.cpuP1SN) {
    query += ' AND b.cpu_p1_sn LIKE ?';
    params.push(`%${filters.cpuP1SN}%`);
  }

  if (filters.m2PN) {
    query += ' AND b.m2_pn LIKE ?';
    params.push(`%${filters.m2PN}%`);
  }

  if (filters.m2SN) {
    query += ' AND b.m2_sn LIKE ?';
    params.push(`%${filters.m2SN}%`);
  }

  if (filters.dimmPN) {
    query += ' AND b.dimm_pn LIKE ?';
    params.push(`%${filters.dimmPN}%`);
  }

  if (filters.dimmQty) {
    query += ' AND b.dimm_qty = ?';
    params.push(filters.dimmQty);
  }

  // DIMM S/N search - needs special handling
  if (filters.dimmSN) {
    query += ' AND EXISTS (SELECT 1 FROM dimm_serial_numbers dsn WHERE dsn.chassis_sn = b.chassis_sn AND dsn.dimm_sn LIKE ?)';
    params.push(`%${filters.dimmSN}%`);
  }

  // Testing Filters
  if (filters.visualInspection) {
    query += ' AND b.visual_inspection_status = ?';
    params.push(filters.visualInspection);
  }

  if (filters.bootStatus) {
    query += ' AND b.boot_status = ?';
    params.push(filters.bootStatus);
  }

  if (filters.dimmsDetected) {
    query += ' AND b.dimms_detected_status = ?';
    params.push(filters.dimmsDetected);
  }

  if (filters.lomWorking) {
    query += ' AND b.lom_working_status = ?';
    params.push(filters.lomWorking);
  }

  // BKC Details Filters
  if (filters.biosVersion) {
    query += ' AND b.bios_version LIKE ?';
    params.push(`%${filters.biosVersion}%`);
  }

  if (filters.scmFpga) {
    query += ' AND b.scm_fpga_version LIKE ?';
    params.push(`%${filters.scmFpga}%`);
  }

  if (filters.hpmFpga) {
    query += ' AND b.hpm_fpga_version LIKE ?';
    params.push(`%${filters.hpmFpga}%`);
  }

  if (filters.bmcVersion) {
    query += ' AND b.bmc_version LIKE ?';
    params.push(`%${filters.bmcVersion}%`);
  }

  // Quality Indicators Filters
  if (filters.status) {
    query += ' AND b.status = ?';
    params.push(filters.status);
  }

  if (filters.fpyStatus) {
    query += ' AND b.fpy_status = ?';
    params.push(filters.fpyStatus);
  }

  if (filters.canContinue) {
    query += ' AND b.can_continue = ?';
    params.push(filters.canContinue);
  }

  if (filters.problemDescription) {
    query += ' AND b.problem_description LIKE ?';
    params.push(`%${filters.problemDescription}%`);
  }

  // Failure Mode and Category search - needs special handling
  if (filters.failureMode) {
    query += ' AND EXISTS (SELECT 1 FROM build_failures bf WHERE bf.chassis_sn = b.chassis_sn AND bf.failure_mode LIKE ?)';
    params.push(`%${filters.failureMode}%`);
  }

  if (filters.failureCategory) {
    query += ' AND EXISTS (SELECT 1 FROM build_failures bf WHERE bf.chassis_sn = b.chassis_sn AND bf.failure_category LIKE ?)';
    params.push(`%${filters.failureCategory}%`);
  }

  // Master Build Information Filters
  if (filters.masterLocation) {
    query += ' AND mb.location = ?';
    params.push(filters.masterLocation);
  }

  if (filters.customLocation) {
    query += ' AND mb.custom_location LIKE ?';
    params.push(`%${filters.customLocation}%`);
  }

  if (filters.teamSecurity) {
    query += ' AND mb.team_security = ?';
    params.push(filters.teamSecurity);
  }

  if (filters.department) {
    query += ' AND mb.department = ?';
    params.push(filters.department);
  }

  // Build Engineer/Technician filter - Handle both array (multi-select) and string (backward compatibility)
  if (filters.buildEngineer) {
    if (Array.isArray(filters.buildEngineer) && filters.buildEngineer.length > 0) {
      // Multi-select: Use OR logic - match ANY of the selected Build Technicians
      const buildEngineerConditions = filters.buildEngineer.map(() => 'b.build_engineer LIKE ?').join(' OR ');
      query += ` AND (${buildEngineerConditions})`;
      filters.buildEngineer.forEach(tech => params.push(`%${tech}%`));
    } else if (typeof filters.buildEngineer === 'string' && filters.buildEngineer.trim() !== '') {
      // Legacy string format for backward compatibility
      query += ' AND b.build_engineer LIKE ?';
      params.push(`%${filters.buildEngineer}%`);
    }
  }

  if (filters.buildName) {
    query += ' AND mb.build_name LIKE ?';
    params.push(`%${filters.buildName}%`);
  }

  if (filters.jiraTicketNo) {
    query += ' AND mb.jira_ticket_no LIKE ?';
    params.push(`%${filters.jiraTicketNo}%`);
  }

  if (Array.isArray(filters.changegearAssetId) && filters.changegearAssetId.length > 0) {
    const conditions = filters.changegearAssetId
      .map(() => 'mb.changegear_asset_id = ?')
      .join(' OR ');
  
    query += ` AND (${conditions})`;
    params.push(...filters.changegearAssetId);
  }

  if (filters.masterStatus) {
    query += ' AND mb.master_status = ?';
    params.push(filters.masterStatus);
  }

  if (filters.notes) {
    query += ' AND mb.notes LIKE ?';
    params.push(`%${filters.notes}%`);
  }

  if (filters.smsOrder) {
    query += ' AND mb.sms_order LIKE ?';
    params.push(`%${filters.smsOrder}%`);
  }

  if (filters.costCenter) {
    query += ' AND mb.cost_center LIKE ?';
    params.push(`%${filters.costCenter}%`);
  }

  if (filters.capitalization) {
    query += ' AND mb.capitalization LIKE ?';
    params.push(`%${filters.capitalization}%`);
  }

  if (filters.deliveryDateFrom) {
    query += ' AND DATE(mb.delivery_date) >= ?';
    params.push(filters.deliveryDateFrom);
  }

  if (filters.deliveryDateTo) {
    query += ' AND DATE(mb.delivery_date) <= ?';
    params.push(filters.deliveryDateTo);
  }

  // Group by and order
  query += ' GROUP BY b.chassis_sn ORDER BY b.created_at DESC';

  // Add limit to prevent overwhelming results
  //query += ' LIMIT 1000';

  console.log('Executing search query with', params.length, 'parameters');

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error executing search query:', err);
      return res.status(500).json({ error: 'Database error during search' });
    }

    console.log(`Search returned ${results.length} results`);

    // Process results to parse DIMM SNs and format data
    results.forEach(row => {
      // Parse DIMM SNs into array
      if (row.dimm_sns) {
        row.dimmSNs = row.dimm_sns.split(',').filter(sn => sn && sn.trim());
      } else {
        row.dimmSNs = [];
      }
      delete row.dimm_sns;

      // Ensure rework data is properly formatted
      row.has_rework = row.has_rework || 'No';
      row.rework_count = row.rework_count || 0;
    });

    res.json(results);
  });
});

// GET all unique ChangeGear Asset IDs
app.get('/api/changegear-options', (req, res) => {
  const query = `
    SELECT DISTINCT changegear_asset_id 
    FROM master_builds
    WHERE changegear_asset_id IS NOT NULL
      AND changegear_asset_id != ''
    ORDER BY changegear_asset_id
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching ChangeGear options:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Convert to simple array
    const options = results.map(row => row.changegear_asset_id);

    res.json(options);
  });
});

// ============================================================================
// CUSTOMER ESCALATION API ENDPOINTS
// ============================================================================

/**
 * GET /api/customer-escalations
 * 
 * Retrieve all customer escalations with summary information
 * Includes error count and pending request count for each escalation
 * 
 * @returns {array} - Array of escalation records with counts
 */
app.get('/api/customer-escalations', (req, res) => {
  const { status, search } = req.query;

  let query = `
    SELECT ce.*, 
           COUNT(DISTINCT ee.id) as error_count,
           (SELECT COUNT(*) FROM escalation_timeline WHERE ticket_id = ce.ticket_id AND timeline_type = 'technician_request' AND request_type IS NOT NULL) as pending_requests,
           (SELECT actor_name FROM escalation_timeline et WHERE et.ticket_id = ce.ticket_id AND et.timeline_type = 'technician_update' ORDER BY et.created_at DESC LIMIT 1) as handling_technician
    FROM customer_escalations ce
    LEFT JOIN escalation_errors ee ON ce.ticket_id = ee.ticket_id
    WHERE 1=1
  `;

  const params = [];

  // Add status filter
  if (status && status !== 'all') {
    query += ' AND ce.status = ?';
    params.push(status);
  }

  // Add search filter
  if (search) {
    query += ' AND (ce.ticket_id LIKE ? OR ce.chassis_sn LIKE ? OR ce.customer_name LIKE ?)';
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  query += ' GROUP BY ce.ticket_id ORDER BY ce.created_at DESC';

  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching escalations:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(results);
  });
});

/**
 * GET /api/escalation-stats
 * 
 * Get escalation statistics for dashboard
 * Returns total, open, closed, and reopened counts
 * 
 * @returns {object} - { total, open, closed, reopened }
 */
app.get('/api/escalation-stats', (req, res) => {
  const statsQuery = `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN status = 'Reopened' THEN 1 ELSE 0 END) as reopened
    FROM customer_escalations
  `;

  db.query(statsQuery, (err, results) => {
    if (err) {
      console.error('Error fetching stats:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(results[0]);
  });
});

/**
 * GET /api/escalation-failure-mode-trends
 * 
 * Get monthly failure mode statistics for chart visualization
 * Returns failure mode counts and percentages grouped by month
 * 
 * @returns {object} - Monthly failure mode data structured as { "YYYY-MM": [{ failure_mode, count, percentage }] }
 */
app.get('/api/escalation-failure-mode-trends', (req, res) => {
  const trendsQuery = `
    SELECT 
      DATE_FORMAT(created_date, '%Y-%m') as month,
      current_failure_mode as failure_mode,
      current_failure_category as failure_category,
      COUNT(*) as count
    FROM customer_escalations 
    WHERE current_failure_mode IS NOT NULL 
      AND current_failure_mode != ''
      AND created_date >= DATE_SUB(CURRENT_DATE, INTERVAL 6 MONTH)
    GROUP BY DATE_FORMAT(created_date, '%Y-%m'), current_failure_mode, current_failure_category
    ORDER BY month DESC, count DESC
  `;

  db.query(trendsQuery, (err, results) => {
    if (err) {
      console.error('Error fetching failure mode trends:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Group by month and calculate percentages
    const monthlyData = {};
    const monthTotals = {};

    // First pass: group by month and calculate totals
    results.forEach(row => {
      const month = row.month;
      if (!monthlyData[month]) {
        monthlyData[month] = [];
        monthTotals[month] = 0;
      }

      monthlyData[month].push({
        failure_mode: row.failure_mode,
        failure_category: row.failure_category,
        count: row.count,
        percentage: 0 // Will be calculated in second pass
      });

      monthTotals[month] += row.count;
    });

    // Second pass: calculate percentages
    Object.keys(monthlyData).forEach(month => {
      const total = monthTotals[month];
      monthlyData[month].forEach(item => {
        item.percentage = total > 0 ? parseFloat(((item.count / total) * 100).toFixed(1)) : 0;
      });

      // Sort by count descending
      monthlyData[month].sort((a, b) => b.count - a.count);
    });

    console.log('Generated failure mode trends for months:', Object.keys(monthlyData));
    res.json(monthlyData);
  });
});

/**
 * GET /api/customer-escalations/:ticketId
 * 
 * Get detailed escalation information including errors and timeline
 * Includes all attachments and conversation history
 * 
 * @param {string} ticketId - Customer escalation ticket ID
 * @returns {object} - Complete escalation details with errors and timeline
 */
app.get('/api/customer-escalations/:ticketId', (req, res) => {
  const { ticketId } = req.params;

  // Validate ticket ID format
  if (!validateTicketId(ticketId, 'customer')) {
    return res.status(400).json({ error: 'Invalid ticket ID format' });
  }

  // Get escalation details
  db.query('SELECT * FROM customer_escalations WHERE ticket_id = ?', [ticketId], (err, escalationResults) => {
    if (err) {
      console.error('Error fetching escalation:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (escalationResults.length === 0) {
      return res.status(404).json({ error: 'Escalation not found' });
    }

    const escalation = escalationResults[0];

    // Get errors with attachments
    db.query('SELECT * FROM escalation_errors WHERE ticket_id = ? ORDER BY error_number',
      [ticketId], (err, errorResults) => {
        if (err) {
          console.error('Error fetching errors:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        // Get attachments for each error
        const errorPromises = errorResults.map(error => {
          return new Promise((resolve, reject) => {
            db.query('SELECT * FROM error_attachments WHERE error_id = ?',
              [error.id], (err, attachments) => {
                if (err) {
                  reject(err);
                } else {
                  error.errorLogFiles = attachments.filter(a => a.file_type === 'error_log');
                  error.defectivePhotos = attachments.filter(a => a.file_type === 'defective_photo');
                  resolve(error);
                }
              });
          });
        });

        Promise.all(errorPromises).then(errorsWithAttachments => {
          // Get timeline with enhanced structure
          db.query(`
          SELECT 
            et.*,
            GROUP_CONCAT(
              CONCAT(ta.id, ':', ta.file_type, ':', ta.file_name, ':', ta.file_path, ':', 
                     COALESCE(ta.file_size, 0), ':', COALESCE(ta.mime_type, ''))
              SEPARATOR '||'
            ) as attachments
          FROM escalation_timeline et
          LEFT JOIN timeline_attachments ta ON et.id = ta.timeline_id
          WHERE et.ticket_id = ?
          GROUP BY et.id
          ORDER BY et.created_at ASC
        `, [ticketId], (err, timelineResults) => {
            if (err) {
              console.error('Error fetching timeline:', err);
              return res.status(500).json({ error: 'Database error' });
            }

            // Process timeline data with proper attachment parsing
            const timeline = timelineResults.map(entry => {
              const processedEntry = { ...entry };

              if (entry.attachments) {
                processedEntry.attachments = entry.attachments.split('||').map(attachmentStr => {
                  const [id, file_type, file_name, file_path, file_size, mime_type] = attachmentStr.split(':');
                  return {
                    id: parseInt(id),
                    file_type,
                    file_name,
                    file_path,
                    file_size: parseInt(file_size),
                    mime_type: mime_type || null
                  };
                });
              } else {
                processedEntry.attachments = [];
              }

              return processedEntry;
            });

            // Build hierarchical timeline structure
            const timelineTree = buildTimelineTree(timeline);

            res.json({
              ...escalation,
              errors: errorsWithAttachments,
              timeline: timelineTree
            });
          });
        }).catch(err => {
          console.error('Error processing errors:', err);
          res.status(500).json({ error: 'Database error' });
        });
      });
  });
});

/**
 * PATCH /api/customer-escalations/:ticketId
 * 
 * Update escalation status and technician notes
 * Allows updating status, failure mode/category, and notes
 * 
 * @param {string} ticketId - Ticket ID to update
 * @body {object} - Fields to update (status, current_failure_mode, etc.)
 * @returns {object} - Success response
 */
app.patch('/api/customer-escalations/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const updateData = req.body;

  const allowedFields = ['status', 'current_failure_mode', 'current_failure_category', 'latest_technician_notes'];
  const updates = [];
  const values = [];

  // Get current escalation data for comparison
  const getCurrentData = () => {
    return new Promise((resolve, reject) => {
      db.query('SELECT * FROM customer_escalations WHERE ticket_id = ?', [ticketId], (err, results) => {
        if (err) reject(err);
        else resolve(results[0]);
      });
    });
  };

  try {
    const currentData = await getCurrentData();
    if (!currentData) {
      return res.status(404).json({ error: 'Escalation not found' });
    }

    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(updateData[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(ticketId);
    const query = `UPDATE customer_escalations SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = ?`;

    db.query(query, values, (err, results) => {
      if (err) {
        console.error('Error updating escalation:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (results.affectedRows === 0) {
        return res.status(404).json({ error: 'Escalation not found' });
      }

      // Create timeline entry for technician update
      const timelineData = {
        ticket_id: ticketId,
        timeline_type: 'technician_update',
        actor_type: 'technician',
        actor_name: updateData.technicianName || 'Tech Support',
        failure_mode: updateData.current_failure_mode || null,
        failure_category: updateData.current_failure_category || null,
        technician_notes: updateData.latest_technician_notes || null,
        old_status: currentData.status,
        new_status: updateData.status || currentData.status
      };

      const timelineQuery = `
        INSERT INTO escalation_timeline 
        (ticket_id, timeline_type, actor_type, actor_name, failure_mode, failure_category, technician_notes, old_status, new_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `;

      db.query(timelineQuery, [
        timelineData.ticket_id,
        timelineData.timeline_type,
        timelineData.actor_type,
        timelineData.actor_name,
        timelineData.failure_mode,
        timelineData.failure_category,
        timelineData.technician_notes,
        timelineData.old_status,
        timelineData.new_status
      ], (timelineErr) => {
        if (timelineErr) {
          console.error('Error creating timeline entry:', timelineErr);
          // Don't fail the main update, just log the error
        }

        res.json({ success: true, message: 'Escalation updated successfully' });
      });
    });

  } catch (error) {
    console.error('Error in escalation update:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * POST /api/customer-escalations/:ticketId/request
 * 
 * Send request to customer (technician initiated)
 * Creates timeline entry for customer response tracking
 * 
 * @param {string} ticketId - Ticket ID
 * @body {object} - { requestType, requestMessage, errorNumber, technicianName }
 * @returns {object} - Success response with timeline ID
 */
app.post('/api/customer-escalations/:ticketId/request', async (req, res) => {
  const { ticketId } = req.params;
  const { requestType, requestMessage, errorNumber, technicianName = 'Tech Support' } = req.body;

  if (!validateTicketId(ticketId, 'customer')) {
    return res.status(400).json({ error: 'Invalid ticket ID format' });
  }

  if (!requestType || !requestMessage) {
    return res.status(400).json({ error: 'Request type and message are required' });
  }

  let connection;

  try {
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    const [timelineResult] = await connection.query(
      `INSERT INTO escalation_timeline (
        ticket_id, timeline_type, actor_type, actor_name, 
        request_type, request_message, error_number
      ) VALUES (?, 'technician_request', 'technician', ?, ?, ?, ?)`,
      [ticketId, technicianName, requestType, requestMessage, errorNumber]
    );

    await connection.query(
      `UPDATE customer_escalations 
       SET updated_at = CURRENT_TIMESTAMP 
       WHERE ticket_id = ?`,
      [ticketId]
    );

    await connection.commit();

    res.json({
      message: 'Request sent successfully',
      timelineId: timelineResult.insertId
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error creating technician request:', error);
    res.status(500).json({ error: 'Failed to send request' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * GET /api/amd-part-numbers
 * 
 * Get AMD part numbers for customer portal dropdown
 * Returns part numbers with descriptions for escalation forms
 * 
 * @returns {array} - Array of AMD part numbers with descriptions
 */
app.get('/api/amd-part-numbers', (req, res) => {
  const query = 'SELECT amd_part_number, evt2_sku_description FROM amd_evt2_mapping ORDER BY amd_part_number';

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching AMD part numbers:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(results);
  });
});

/**
 * POST /api/customer-escalations
 * 
 * Submit new customer escalation with files
 * Creates escalation record, error records, and file attachments
 * 
 * @body {FormData} - Escalation data and files
 * @returns {object} - Success response with ticket ID
 */
/**
 * POST /api/customer-escalations
 * 
 * Submit new customer escalation with RACE-CONDITION SAFE ticket ID generation
 * 
 * @body {object} - Escalation data with optional error details
 * @returns {object} - Success response with ticket ID
 */
app.post('/api/customer-escalations', async (req, res) => {
  const {
    customerName,
    jiraTicketNumber,
    problemDescription,
    projectName,
    amdPartNumber,
    evt2SkuDescription,
    chassisSN,
    fwBmcVersion,
    osVersion,
    biosVersion,
    pcbaSN,
    cpuP0SN,
    cpuP1SN,
    errorCount,
    errors,
    alreadyUploadedToJira
  } = req.body;

  console.log('Creating escalation with data:', req.body);

  let connection;

  try {
    // Get connection from pool and start transaction
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    // Generate ticket ID using your existing utility
    const ticketId = await generateTicketIdSafeAlt(connection);
    const createdDate = new Date().toISOString().split('T')[0];

    console.log(`Generated ticket ID: ${ticketId}`);

    // Insert main escalation record
    await connection.query(
      `INSERT INTO customer_escalations (
        ticket_id, customer_name, jira_ticket_number, problem_description, project_name,
        amd_part_number, evt2_sku_description, chassis_sn, fw_bmc_version,
        os_version, bios_version, pcba_sn, cpu_p0_sn, cpu_p1_sn, error_count,
        status, created_date, already_uploaded_to_jira
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?)`,
      [
        ticketId, customerName, jiraTicketNumber || null, problemDescription, projectName,
        amdPartNumber, evt2SkuDescription, chassisSN, fwBmcVersion,
        osVersion, biosVersion, pcbaSN,
        cpuP0SN && cpuP0SN.trim() !== '' ? cpuP0SN : null,
        cpuP1SN && cpuP1SN.trim() !== '' ? cpuP1SN : null,
        errorCount, createdDate,
        alreadyUploadedToJira || false
      ]
    );

    // Only insert error details if not uploaded to Jira
    if (!alreadyUploadedToJira && errors && errors.length > 0) {
      for (let i = 0; i < errors.length; i++) {
        const error = errors[i];

        // Insert error record
        const [errorResult] = await connection.query(
          `INSERT INTO escalation_errors (
            ticket_id, error_number, problem_isolation, error_log_text
          ) VALUES (?, ?, ?, ?)`,
          [ticketId, i + 1, error.problemIsolation, error.errorLogText || null]
        );

        const errorId = errorResult.insertId;

        // Insert error attachments
        if (error.errorLogFiles && error.errorLogFiles.length > 0) {
          for (const file of error.errorLogFiles) {
            await connection.query(
              `INSERT INTO error_attachments (
                error_id, ticket_id, file_type, file_name, file_path, file_size, mime_type
              ) VALUES (?, ?, 'error_log', ?, ?, ?, ?)`,
              [errorId, ticketId, file.name, file.path, file.size || null, file.type || null]
            );
          }
        }

        // Insert defective photos
        if (error.defectivePhotos && error.defectivePhotos.length > 0) {
          for (const photo of error.defectivePhotos) {
            await connection.query(
              `INSERT INTO error_attachments (
                error_id, ticket_id, file_type, file_name, file_path, file_size, mime_type
              ) VALUES (?, ?, 'defective_photo', ?, ?, ?, ?)`,
              [errorId, ticketId, photo.name, photo.path, photo.size || null, photo.type || null]
            );
          }
        }
      }
    }

    // Create initial timeline entry
    const initialMessage = alreadyUploadedToJira
      ? `Escalation submitted - Error details uploaded to Jira`
      : `Escalation submitted with ${errorCount} error(s)`;

    await connection.query(
      `INSERT INTO escalation_timeline (
        ticket_id, timeline_type, actor_type, actor_name, response_text
      ) VALUES (?, 'initial_submission', 'customer', ?, ?)`,
      [ticketId, customerName, initialMessage]
    );

    // Commit the transaction
    await connection.commit();

    console.log(`Successfully created escalation with ticket ID: ${ticketId}`);

    res.status(201).json({
      message: 'Escalation created successfully',
      ticketId,
      createdDate
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error creating escalation:', error);
    res.status(500).json({
      error: 'Failed to create escalation',
      message: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * POST /api/customer-escalations/:ticketId/respond
 * 
 * Submit customer response to technician request
 * Handles file attachments and creates timeline entry
 * 
 * @param {string} ticketId - Ticket ID
 * @body {FormData} - Response text, files, and metadata
 * @returns {object} - Success response with timeline ID
 */
app.post('/api/customer-escalations/:ticketId/respond', escalationUpload.array('files', 10), async (req, res) => {
  const { ticketId } = req.params;
  const {
    parentTimelineId,
    responseText,
    errorNumber,
    customerName = 'Customer'
  } = req.body;

  if (!validateTicketId(ticketId, 'customer')) {
    return res.status(400).json({ error: 'Invalid ticket ID format' });
  }

  let connection;

  try {
    connection = await db.promise().getConnection();
    await connection.beginTransaction();

    const [timelineResult] = await connection.query(
      `INSERT INTO escalation_timeline (
        ticket_id, timeline_type, actor_type, actor_name, 
        response_text, error_number, parent_timeline_id
      ) VALUES (?, 'customer_response', 'customer', ?, ?, ?, ?)`,
      [ticketId, customerName, responseText || '', errorNumber || null, parentTimelineId || null]
    );

    const timelineId = timelineResult.insertId;

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        let fileType = 'additional_document';
        if (file.mimetype.startsWith('image/')) {
          fileType = 'defective_photo';
        } else if (file.originalname.toLowerCase().includes('log') ||
          file.originalname.toLowerCase().includes('error')) {
          fileType = 'error_log';
        }

        await connection.query(
          `INSERT INTO timeline_attachments (
            timeline_id, error_number, file_type, file_name, file_path, file_size, mime_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [timelineId, errorNumber || 1, fileType, file.originalname, file.filename, file.size, file.mimetype]
        );
      }
    }

    await connection.query(
      `UPDATE customer_escalations 
       SET updated_at = CURRENT_TIMESTAMP 
       WHERE ticket_id = ?`,
      [ticketId]
    );

    await connection.commit();

    res.json({
      message: 'Response submitted successfully',
      timelineId
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error submitting customer response:', error);
    res.status(500).json({ error: 'Failed to submit response' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// ============================================================================
// CUSTOMER TICKETS API ENDPOINTS 
// ============================================================================

/**
 * GET /api/customer-escalations/user/:userEmail
 * 
 * Get all tickets opened by a specific user
 * Used in customer portal to show user's own tickets
 * 
 * @param {string} userEmail - User email address
 * @returns {array} - Array of user's tickets
 */
app.get('/api/customer-escalations/user/:userEmail', (req, res) => {
  const { userEmail } = req.params;

  const query = `
    SELECT 
      e.ticket_id,
      e.customer_name,
      e.project_name,
      e.status,
      e.created_date
    FROM customer_escalations e
    LEFT JOIN users u ON (e.customer_name = u.full_name OR e.customer_name = u.first_name)
    WHERE u.email = ? 
    ORDER BY e.created_date DESC
  `;

  db.query(query, [userEmail], (err, results) => {
    if (err) {
      console.error('Error fetching user tickets:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(results);
  });
});

/**
 * GET /api/customer-escalations/cost-center/:costCenter
 * 
 * Get all tickets from a specific cost center
 * Used in customer portal to show cost center tickets
 * 
 * @param {string} costCenter - Cost center number
 * @returns {array} - Array of cost center tickets
 */
app.get('/api/customer-escalations/cost-center/:costCenter', (req, res) => {
  const { costCenter } = req.params;

  const query = `
    SELECT 
      e.ticket_id,
      e.customer_name,
      e.project_name,
      e.status,
      e.created_date,
      u.email as customer_email
    FROM customer_escalations e
    LEFT JOIN users u ON e.customer_name = u.full_name
    WHERE u.cost_center_number = ? 
    ORDER BY e.created_date DESC
  `;

  db.query(query, [costCenter], (err, results) => {
    if (err) {
      console.error('Error fetching cost center tickets:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(results);
  });
});

/**
 * POST /api/upload-escalation-file
 * 
 * Upload single file for escalation
 * Used for customer portal file uploads
 * 
 * @body {File} file - File to upload
 * @returns {object} - File path and name information
 */
app.post('/api/upload-escalation-file', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  res.json({
    filePath: req.file.path,
    fileName: req.file.filename,
    originalName: req.file.originalname
  });
});

/**
 * GET /api/builds/pcba-from-mb/:mbSN
 * 
 * Get PCBA serial number from motherboard serial number
 * Used in customer portal for auto-population
 * 
 * @param {string} mbSN - Motherboard serial number
 * @returns {object} - { pcbaSN: string }
 */
app.get('/api/builds/pcba-from-mb/:mbSN', (req, res) => {
  const { mbSN } = req.params;

  const query = 'SELECT chassis_sn FROM builds WHERE mb_sn = ?';

  db.query(query, [mbSN], (err, results) => {
    if (err) {
      console.error('Error fetching PCBA SN:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'Build not found for this MB SN' });
    }

    res.json({ pcbaSN: results[0].chassis_sn });
  });
});

// ============================================================================
// FILE SERVING ENDPOINTS
// ============================================================================

/**
 * GET /api/timeline-files/:filePath(*)
 * 
 * Serve timeline attachment files
 * Handles escalation timeline file downloads
 * 
 * @param {string} filePath - Relative file path
 */
app.get('/api/timeline-files/:filePath(*)', (req, res) => {
  const filePath = req.params.filePath;
  const fullPath = path.join(__dirname, filePath);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.sendFile(fullPath);
});

/**
 * GET /api/error-files/:filePath(*)
 * 
 * Serve error attachment files
 * Handles escalation error file downloads
 * 
 * @param {string} filePath - Relative file path
 */
app.get('/api/error-files/:filePath(*)', (req, res) => {
  const filePath = req.params.filePath;
  const fullPath = path.join(__dirname, filePath);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.sendFile(fullPath);
});

// Enhanced photo serving with better error handling and logging
app.use('/uploads', (req, res, next) => {
  const filePath = path.join(__dirname, 'uploads', req.path);

  console.log('Photo request:', {
    requestPath: req.path,
    fullPath: filePath,
    exists: fs.existsSync(filePath)
  });

  if (!fs.existsSync(filePath)) {
    console.log('Photo not found:', filePath);
    return res.status(404).json({ error: 'Photo not found' });
  }

  next();
}, express.static(path.join(__dirname, 'uploads')));

// Alternative endpoint for direct photo access with debugging
app.get('/api/photo/:type/:filename', (req, res) => {
  const { type, filename } = req.params;
  const filePath = path.join(__dirname, 'uploads', type, filename);

  console.log('Direct photo access:', {
    type,
    filename,
    fullPath: filePath,
    exists: fs.existsSync(filePath)
  });

  if (!fs.existsSync(filePath)) {
    // Try without type subdirectory
    const alternativePath = path.join(__dirname, 'uploads', filename);
    console.log('Trying alternative path:', alternativePath);

    if (fs.existsSync(alternativePath)) {
      return res.sendFile(alternativePath);
    }

    return res.status(404).json({ error: 'Photo not found' });
  }

  res.sendFile(filePath);
});

// Debug endpoint to list all photos for a build
app.get('/api/debug/photos/:chassisSN', (req, res) => {
  const { chassisSN } = req.params;

  const query = 'SELECT * FROM build_photos WHERE chassis_sn = ?';
  db.query(query, [chassisSN], (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    // Check if files actually exist
    const photosWithStatus = results.map(photo => {
      const fullPath = path.join(__dirname, photo.file_path);
      const exists = fs.existsSync(fullPath);

      return {
        ...photo,
        file_exists: exists,
        full_path: fullPath,
        normalized_path: photo.file_path.replace(/\\/g, '/')
      };
    });

    res.json({
      chassis_sn: chassisSN,
      photos: photosWithStatus,
      upload_directory: path.join(__dirname, 'uploads')
    });
  });
});

// ============================================================================
// ERROR HANDLING & SERVER STARTUP
// ============================================================================

/**
 * Global error handling middleware
 * Catches and logs all unhandled errors
 */
app.use((err, req, res, next) => {
  // Handle common client disconnection errors
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
    console.log('Client disconnected:', {
      url: req.url,
      method: req.method,
      error: err.code
    });
    return; // Don't send response for client disconnections
  }

  console.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });

  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Graceful shutdown handling
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  db.end(() => {
    console.log('Database connection closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  db.end(() => {
    console.log('Database connection closed.');
    process.exit(0);
  });
});

// Health check endpoint with database connectivity test
app.get('/api/health', async (req, res) => {
  try {
    const dbHealthy = await testConnection(db);

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime(),
      database: {
        connected: dbHealthy,
        pool: req.dbInfo || {
          totalConnections: 'N/A',
          freeConnections: 'N/A',
          queuedRequests: 'N/A'
        }
      }
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      database: {
        connected: false
      }
    });
  }
});

// Store database connection in app for middleware access
app.set('db', db);

// Add database connection middleware for critical endpoints
app.use('/api/builds', ensureDbConnection);
app.use('/api/platform-info', ensureDbConnection);
app.use('/api/part-numbers', ensureDbConnection);

// Add database info middleware for monitoring endpoints
app.use('/api/health', addDbInfo);

// Handle pool errors
db.on('error', (err) => {
  console.error('Database pool error:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('Database connection lost, pool will handle reconnection...');
  } else if (err.code === 'PROTOCOL_ENQUEUE_AFTER_QUIT') {
    console.log('Database connection ended, pool will create new connection...');
  } else if (err.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR') {
    console.log('Database fatal error, pool will handle recovery...');
  } else {
    console.error('Unexpected database error:', err);
  }
});

// Wrapper function to use improved database queries with automatic retry
function dbQuery(query, params, callback) {
  executeQueryCallback(db, query, params, callback);
}

// Periodic connection health check with better error handling
setInterval(async () => {
  try {
    const isHealthy = await testConnection(db);
    if (isHealthy) {
      console.log('Database health check passed');
    } else {
      console.error('Database health check failed');
    }
  } catch (error) {
    console.error('Database health check error:', error);
  }
}, 300000); // Check every 5 minutes

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, closing database pool...');
  db.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, closing database pool...');
  db.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

// Add database error handling middleware
app.use(handleDatabaseErrors);

// General error handler (should be last)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV !== 'production';

  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: isDevelopment ? err.message : 'Something went wrong',
    ...(isDevelopment && { stack: err.stack })
  });
});

// ============================================================================
// SERVER START
// ============================================================================

/**
 * Start the Express server
 * Default port 5000 for development, configurable via environment
 */
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 AMD Smart Hand API Server running on ${HOST}:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📁 Upload path: ${process.env.UPLOAD_PATH || './uploads'}`);
  console.log(`🗄️  Database: ${dbConfig.database} at ${dbConfig.host}:${dbConfig.port}`);
  console.log(`⚡ Server started at: ${new Date().toISOString()}`);
});

// ============================================================================
// PROCESS-LEVEL ERROR HANDLING
// ============================================================================

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
    console.log('Uncaught client disconnection:', err.code);
    return;
  }

  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

app.use(bodyParser.json({ limit: '20mb' }));

// Import the email router
const emailRouter = require('./routes/email');

// Mount the router
app.use('/api/email', emailRouter);
app.get('/api/dashboard/weekly-delivery', getWeeklyDeliveryData);

app.get('/api/dashboard/chart/:project/:type/:chartType', async (req, res) => {
  const { project, type, chartType } = req.params;

  // Fetch the actual quality data for this project
  const { data: qualityData } = await axios.get(
    `http://localhost:5000/api/dashboard/quality-data/${encodeURIComponent(project)}`
  );

  let base64;
  if (chartType === 'bar') {
    base64 = await generateBarChartBase64(qualityData, type);
  } else {
    base64 = await generatePieChartBase64(qualityData, type);
  }
  if (!base64) return res.status(404).send('Chart not found');
  const img = Buffer.from(base64, 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': img.length
  });
  res.end(img);
});

app.get('/api/dashboard/location-allocation/chart', async (req, res) => {
  try {
    const {
      projectName,
      platform,
      startDate,
      endDate,
      prbSubcategories,
      vrbSubcategories
    } = req.query;

    if (!projectName || !platform) {
      return res.status(400).send('Missing required parameters');
    }

    // Fetch filtered location allocation data
    const { data: locationData } = await axios.get(
      'http://localhost:5000/api/dashboard/location-allocation',
      {
        params: {
          projectName,
          startDate,
          endDate,
          prbSubcategories,
          vrbSubcategories
        }
      }
    );

    // Generate chart
    const base64 = await generateLocationAllocationChartBase64(
      locationData,
      platform,
      projectName
    );

    if (!base64) {
      return res.status(404).send('Chart not found');
    }

    const img = Buffer.from(base64, 'base64');

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': img.length
    });

    res.end(img);

  } catch (error) {
    console.error(error);
    res.status(500).send('Failed to generate chart');
  }
});

app.get('/api/dashboard/location-allocation/nonstacked-chart', async (req, res) => {
  try {
    const {
      projectName,
      platform,
      startDate,
      endDate,
      prbSubcategories,
      vrbSubcategories
    } = req.query;

    if (!projectName || !platform) {
      return res.status(400).send('Missing required parameters');
    }

    // Fetch filtered location allocation data
    const { data: locationData } = await axios.get(
      'http://localhost:5000/api/dashboard/location-allocation',
      {
        params: {
          projectName,
          startDate,
          endDate,
          prbSubcategories,
          vrbSubcategories
        }
      }
    );

    // Generate NON-STACKED chart
    const base64 = await generateLocationAllocationChartBase64NonStacked(
      locationData,
      platform
    );

    if (!base64) {
      return res.status(404).send('Chart not found');
    }

    const img = Buffer.from(base64, 'base64');

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': img.length
    });

    res.end(img);

  } catch (error) {
    console.error(error);
    res.status(500).send('Failed to generate non-stacked chart');
  }
});
//app.listen(PORT, () => console.log(`Server running on port ${PORT}`));