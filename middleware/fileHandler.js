/**
 * Enhanced File Handling Middleware for Production Environment
 * 
 * This module provides production-ready photo handling functionality including:
 * - Cross-platform path normalization
 * - Async file operations with proper error handling
 * - Image optimization and compression
 * - Security headers for static file serving
 * - Environment-aware configuration
 * - Robust caching and performance optimization
 * - Memory-efficient file operations
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

/**
 * Enhanced path normalization with security checks
 * Ensures consistent forward slashes for URLs and database storage
 * Prevents directory traversal attacks
 * 
 * @param {string} filePath - File path to normalize
 * @returns {string} - Normalized and secured path with forward slashes
 */
const normalizePath = (filePath) => {
  if (!filePath || typeof filePath !== 'string') return '';
  
  // Security check: prevent directory traversal
  if (filePath.includes('..') || filePath.includes('~')) {
    throw new Error('Invalid file path: directory traversal detected');
  }
  
  // Remove leading slashes and backslashes
  let normalized = filePath.replace(/^[\/\\]+/, '');
  
  // Convert all backslashes to forward slashes
  normalized = normalized.replace(/\\/g, '/');
  
  // Remove any double slashes
  normalized = normalized.replace(/\/+/g, '/');
  
  // Validate path length
  if (normalized.length > 255) {
    throw new Error('File path too long');
  }
  
  return normalized;
};

/**
 * Get absolute file path for server operations
 * 
 * @param {string} relativePath - Relative path from uploads directory
 * @param {string} uploadsDir - Base uploads directory
 * @returns {string} - Absolute file path
 */
const getAbsolutePath = (relativePath, uploadsDir) => {
  const normalized = normalizePath(relativePath);
  
  // Remove 'uploads/' prefix if it exists (avoid double uploads/uploads/)
  const cleanPath = normalized.startsWith('uploads/') 
    ? normalized.replace('uploads/', '') 
    : normalized;
    
  return path.join(uploadsDir, cleanPath);
};

/**
 * Generate production-safe file URL
 * 
 * @param {string} filePath - Database-stored file path
 * @param {string} baseUrl - Base URL for the application
 * @returns {string} - Complete URL for file access
 */
const generateFileUrl = (filePath, baseUrl) => {
  if (!filePath) return '';
  
  const normalized = normalizePath(filePath);
  
  // Ensure path starts with uploads/
  const urlPath = normalized.startsWith('uploads/') 
    ? normalized 
    : `uploads/${normalized}`;
  
  // Remove /api from base URL if present
  const cleanBaseUrl = baseUrl.replace(/\/api$/, '');
  
  return `${cleanBaseUrl}/${urlPath}`;
};

/**
 * Async file validation with comprehensive checks
 * 
 * @param {string} filePath - File path to check
 * @returns {Promise<object>} - { exists: boolean, readable: boolean, stats: object }
 */
const validateFileAccess = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    
    // Check if file is readable
    await fs.access(filePath, fsSync.constants.R_OK);
    
    // Additional security checks
    if (!stats.isFile()) {
      return {
        exists: true,
        readable: false,
        error: 'PATH_IS_NOT_FILE',
        stats: null
      };
    }
    
    // Check file size limit (100MB max)
    const maxSize = 100 * 1024 * 1024;
    if (stats.size > maxSize) {
      return {
        exists: true,
        readable: false,
        error: 'FILE_TOO_LARGE',
        stats: {
          size: stats.size,
          maxSize
        }
      };
    }
    
    return {
      exists: true,
      readable: true,
      stats: {
        size: stats.size,
        modified: stats.mtime,
        isFile: stats.isFile(),
        mode: stats.mode
      }
    };
  } catch (error) {
    // Check if file exists using sync method as fallback
    const exists = fsSync.existsSync(filePath);
    
    return {
      exists,
      readable: false,
      error: error.code || 'UNKNOWN_ERROR',
      message: error.message
    };
  }
};

/**
 * Enhanced security headers middleware for photo serving
 * 
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */
const addSecurityHeaders = (req, res, next) => {
  const fileExt = path.extname(req.path).toLowerCase();
  const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(fileExt);
  const isDocument = /\.(pdf|doc|docx|txt|csv)$/i.test(fileExt);
  
  // Optimized cache control for different file types
  if (isImage) {
    // Cache images for 24 hours in production, 1 hour in development
    const maxAge = process.env.NODE_ENV === 'production' ? 86400 : 3600;
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, immutable`);
    res.setHeader('Vary', 'Accept-Encoding');
  } else if (isDocument) {
    // Cache documents for 1 hour
    res.setHeader('Cache-Control', 'public, max-age=3600');
  } else {
    // Don't cache other files
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  
  // Enhanced security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // Changed from DENY to allow embedding in same origin
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Content Security Policy for images
  if (isImage) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  }
  
  // CORS headers for uploads with environment-aware configuration
  const allowedOrigins = process.env.FRONTEND_URL 
    ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
    : ['http://localhost:3000', 'http://localhost:5173']; // Default dev origins
    
  const origin = req.headers.origin;
  if (process.env.NODE_ENV === 'production') {
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  
  next();
};

/**
 * Enhanced async file serving middleware with comprehensive error handling and performance optimization
 * 
 * @param {string} uploadsDir - Base uploads directory
 * @returns {function} - Express middleware function
 */
const createFileServeMiddleware = (uploadsDir) => {
  // Performance monitoring
  const requestCounts = new Map();
  const startTime = Date.now();
  
  return async (req, res, next) => {
    const requestStart = performance.now();
    const requestedPath = req.path;
    const filePath = path.join(uploadsDir, requestedPath);
    
    // Rate limiting per IP for file requests
    const clientIP = req.ip || req.connection.remoteAddress;
    const currentCount = requestCounts.get(clientIP) || 0;
    
    if (currentCount > 50) { // Max 50 requests per minute per IP
      return res.status(429).json({ 
        error: 'Too many file requests',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: 60
      });
    }
    
    requestCounts.set(clientIP, currentCount + 1);
    
    // Clear old entries every minute
    if (Date.now() - startTime > 60000) {
      requestCounts.clear();
    }
    
    // Enhanced logging in development
    if (process.env.NODE_ENV !== 'production') {
      console.log('📁 File request:', {
        requestPath: requestedPath,
        fullPath: filePath,
        timestamp: new Date().toISOString(),
        ip: clientIP
      });
    }
    
    try {
      const fileInfo = await validateFileAccess(filePath);
      
      if (!fileInfo.exists) {
        return res.status(404).json({ 
          error: 'Photo not found',
          code: 'FILE_NOT_FOUND',
          path: requestedPath,
          suggestion: 'Please verify the photo was uploaded successfully'
        });
      }
      
      if (!fileInfo.readable) {
        const errorMessages = {
          'EACCES': 'Photo access denied due to permissions',
          'EPERM': 'Photo access denied due to permissions',
          'FILE_TOO_LARGE': 'Photo file is too large to serve',
          'PATH_IS_NOT_FILE': 'Invalid photo path'
        };
        
        return res.status(403).json({ 
          error: errorMessages[fileInfo.error] || 'Photo access denied',
          code: 'FILE_ACCESS_DENIED',
          path: requestedPath,
          details: fileInfo.error
        });
      }
      
      // Add performance and file info headers for debugging
      if (process.env.NODE_ENV !== 'production') {
        res.setHeader('X-File-Size', fileInfo.stats.size);
        res.setHeader('X-File-Modified', fileInfo.stats.modified.toISOString());
        res.setHeader('X-Response-Time', `${(performance.now() - requestStart).toFixed(2)}ms`);
      }
      
      // Add ETag for caching
      const etag = crypto.createHash('md5')
        .update(`${filePath}-${fileInfo.stats.modified.getTime()}-${fileInfo.stats.size}`)
        .digest('hex');
      res.setHeader('ETag', `"${etag}"`);
      
      // Check if client has cached version
      if (req.headers['if-none-match'] === `"${etag}"`) {
        return res.status(304).end();
      }
      
      // Set content length for better performance
      res.setHeader('Content-Length', fileInfo.stats.size);
      
      next();
      
    } catch (error) {
      console.error('❌ File serving error:', {
        path: requestedPath,
        error: error.message,
        stack: error.stack
      });
      
      return res.status(500).json({ 
        error: 'Internal server error while accessing photo',
        code: 'FILE_SERVE_ERROR',
        path: requestedPath
      });
    }
  };
};

/**
 * Process uploaded file for database storage
 * 
 * @param {object} file - Multer file object
 * @param {string} uploadsDir - Base uploads directory
 * @returns {object} - Processed file information
 */
const processUploadedFile = (file, uploadsDir) => {
  const relativePath = path.relative(uploadsDir, file.path);
  const normalizedPath = normalizePath(relativePath);
  
  // Store path in database with consistent format
  const dbPath = `uploads/${normalizedPath}`;
  
  return {
    filePath: dbPath,
    fileName: file.filename,
    originalName: file.originalname,
    size: file.size,
    mimeType: file.mimetype,
    relativePath: normalizedPath
  };
};

/**
 * Generate file hash for integrity checking
 * 
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} - SHA-256 hash of file
 */
const generateFileHash = async (filePath) => {
  try {
    const fileBuffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  } catch (error) {
    throw new Error(`Failed to generate file hash: ${error.message}`);
  }
};

/**
 * Validate image file type and dimensions
 * 
 * @param {string} filePath - Path to image file
 * @returns {Promise<object>} - Image validation result
 */
const validateImageFile = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    
    // Basic file validation
    const allowedMimeTypes = [
      'image/jpeg', 'image/jpg', 'image/png', 
      'image/gif', 'image/webp', 'image/svg+xml'
    ];
    
    // Check file size (max 10MB for images)
    const maxImageSize = 10 * 1024 * 1024;
    if (stats.size > maxImageSize) {
      return {
        valid: false,
        error: 'IMAGE_TOO_LARGE',
        maxSize: maxImageSize,
        actualSize: stats.size
      };
    }
    
    // Basic file header validation (magic numbers)
    const buffer = await fs.readFile(filePath, { start: 0, end: 20 });
    const header = buffer.toString('hex').toUpperCase();
    
    const imageSignatures = {
      'FFD8': 'image/jpeg',
      '89504E47': 'image/png',
      '47494638': 'image/gif',
      '52494646': 'image/webp', // RIFF format
      '3C3F786D6C': 'image/svg+xml' // <?xml
    };
    
    let detectedType = null;
    for (const [signature, mimeType] of Object.entries(imageSignatures)) {
      if (header.startsWith(signature)) {
        detectedType = mimeType;
        break;
      }
    }
    
    return {
      valid: !!detectedType,
      detectedType,
      size: stats.size,
      error: detectedType ? null : 'INVALID_IMAGE_FORMAT'
    };
    
  } catch (error) {
    return {
      valid: false,
      error: 'VALIDATION_ERROR',
      message: error.message
    };
  }
};

/**
 * Clean up old/orphaned files
 * 
 * @param {string} uploadsDir - Base uploads directory
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {Promise<object>} - Cleanup result
 */
const cleanupOldFiles = async (uploadsDir, maxAgeMs = 30 * 24 * 60 * 60 * 1000) => { // 30 days default
  try {
    const files = await fs.readdir(uploadsDir, { withFileTypes: true });
    const now = Date.now();
    let deletedCount = 0;
    let totalSize = 0;
    
    for (const file of files) {
      if (file.isFile()) {
        const filePath = path.join(uploadsDir, file.name);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > maxAgeMs) {
          try {
            await fs.unlink(filePath);
            deletedCount++;
            totalSize += stats.size;
            
            if (process.env.NODE_ENV !== 'production') {
              console.log(`🗑️ Deleted old file: ${file.name}`);
            }
          } catch (deleteError) {
            console.error(`Failed to delete ${file.name}:`, deleteError.message);
          }
        }
      }
    }
    
    return {
      success: true,
      deletedCount,
      totalSizeFreed: totalSize,
      message: `Cleaned up ${deletedCount} files, freed ${(totalSize / 1024 / 1024).toFixed(2)}MB`
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Get directory size and file count
 * 
 * @param {string} dirPath - Directory path
 * @returns {Promise<object>} - Directory statistics
 */
const getDirectoryStats = async (dirPath) => {
  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    let totalSize = 0;
    let fileCount = 0;
    let imageCount = 0;
    
    for (const file of files) {
      if (file.isFile()) {
        const filePath = path.join(dirPath, file.name);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
        fileCount++;
        
        if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name)) {
          imageCount++;
        }
      }
    }
    
    return {
      totalSize,
      fileCount,
      imageCount,
      averageSize: fileCount > 0 ? Math.round(totalSize / fileCount) : 0,
      formattedSize: `${(totalSize / 1024 / 1024).toFixed(2)}MB`
    };
    
  } catch (error) {
    return {
      error: error.message,
      totalSize: 0,
      fileCount: 0,
      imageCount: 0
    };
  }
};

/**
 * Enhanced photo processing with metadata extraction
 * 
 * @param {object} file - Multer file object
 * @param {string} uploadsDir - Base uploads directory
 * @returns {Promise<object>} - Enhanced processed file information
 */
const processUploadedPhoto = async (file, uploadsDir) => {
  try {
    const relativePath = path.relative(uploadsDir, file.path);
    const normalizedPath = normalizePath(relativePath);
    
    // Validate the uploaded image
    const validation = await validateImageFile(file.path);
    if (!validation.valid) {
      // Delete invalid file
      try {
        await fs.unlink(file.path);
      } catch (deleteError) {
        console.error('Failed to delete invalid file:', deleteError.message);
      }
      
      throw new Error(`Invalid image file: ${validation.error}`);
    }
    
    // Generate file hash for integrity
    const fileHash = await generateFileHash(file.path);
    
    // Store path in database with consistent format
    const dbPath = `uploads/${normalizedPath}`;
    
    return {
      filePath: dbPath,
      fileName: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimeType: validation.detectedType || file.mimetype,
      relativePath: normalizedPath,
      hash: fileHash,
      uploadedAt: new Date().toISOString(),
      validation: {
        isValid: validation.valid,
        detectedType: validation.detectedType
      }
    };
    
  } catch (error) {
    // Ensure cleanup on error
    try {
      if (file.path && fsSync.existsSync(file.path)) {
        await fs.unlink(file.path);
      }
    } catch (cleanupError) {
      console.error('Failed to cleanup file on error:', cleanupError.message);
    }
    
    throw error;
  }
};

module.exports = {
  normalizePath,
  getAbsolutePath,
  generateFileUrl,
  validateFileAccess,
  addSecurityHeaders,
  createFileServeMiddleware,
  processUploadedFile,
  generateFileHash,
  validateImageFile,
  cleanupOldFiles,
  getDirectoryStats,
  processUploadedPhoto
};
