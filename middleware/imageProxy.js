/**
 * Enhanced Image Proxy Route with Advanced Error Handling
 * 
 * This module provides a robust image proxy that handles:
 * - Client disconnections (EPIPE errors)
 * - Network timeouts
 * - Proper caching
 * - Stream-based file serving
 * - Connection monitoring
 * - Graceful error recovery
 */

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const util = require('util');

// Suppress EPIPE errors globally for this module
process.on('uncaughtException', (error) => {
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNABORTED') {
    console.log('Client disconnected (global handler):', error.code);
    return; // Don't crash the process
  }
  throw error; // Re-throw other errors
});

/**
 * Create enhanced image proxy route with better error handling
 * 
 * @param {string} uploadsDir - Base uploads directory
 * @returns {function} - Express route handler
 */
const createImageProxyRoute = (uploadsDir) => {
  return async (req, res) => {
    // Wrap everything in a try-catch to handle any unhandled errors
    try {
      await handleImageProxyRequest(req, res, uploadsDir);
    } catch (error) {
      // Final safety net for any unhandled errors
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNABORTED') {
        console.log('Client disconnected (final catch):', {
          error: error.code,
          message: 'Client cancelled request - handled by final safety net'
        });
        return; // Don't send response, client is gone
      } else {
        console.error('Final safety net caught error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    }
  };
};

/**
 * Handle image proxy request with comprehensive error handling
 * 
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {string} uploadsDir - Base uploads directory
 */
const handleImageProxyRequest = async (req, res, uploadsDir) => {
    const { path: imagePath } = req.query;
    
    // Set permissive CORS headers first
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Cache-Control');
    
    if (!imagePath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }
    
    // Early check for client disconnection
    if (req.aborted) {
      console.log('Client already disconnected, skipping image proxy');
      return;
    }
    
    // Security: normalize and validate the path
    const normalizedPath = imagePath.replace(/^[\/\\]+/, '').replace(/\\/g, '/');
    
    // Prevent directory traversal
    if (normalizedPath.includes('..') || normalizedPath.includes('~')) {
      return res.status(403).json({ error: 'Invalid path' });
    }
    
    // Handle paths that may already include 'uploads/'
    const cleanPath = normalizedPath.startsWith('uploads/') 
      ? normalizedPath.substring(8) // Remove 'uploads/' prefix
      : normalizedPath;
    
    // Construct full file path
    const fullPath = path.join(uploadsDir, cleanPath);
    
    // Log request details (only in development)
    if (process.env.NODE_ENV === 'development') {
      console.log('Image proxy request:', {
        requestedPath: imagePath,
        normalizedPath,
        cleanPath,
        fullPath,
        exists: fs.existsSync(fullPath)
      });
    }
    
    try {
      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        console.log('Image not found via proxy:', fullPath);
        return res.status(404).json({ error: 'Image not found' });
      }
      
      // Get file stats
      const stats = fs.statSync(fullPath);
      
      // Check if it's actually a file
      if (!stats.isFile()) {
        return res.status(404).json({ error: 'Invalid file' });
      }
      
      // Set appropriate cache headers
      const maxAge = 3600; // 1 hour
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      res.setHeader('ETag', `"${stats.mtime.getTime()}-${stats.size}"`);
      
      // Handle If-None-Match for 304 responses
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch === `"${stats.mtime.getTime()}-${stats.size}"`) {
        return res.status(304).end();
      }
      
      // Determine content type
      const ext = path.extname(fullPath).toLowerCase();
      const contentTypeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
      };
      
      const contentType = contentTypeMap[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stats.size);
      
      // Handle HEAD requests
      if (req.method === 'HEAD') {
        return res.end();
      }
      
      // Monitor client connection
      let clientConnected = true;
      let streamAborted = false;
      let disconnectLogged = false;
      
      const handleDisconnect = (reason = 'unknown') => {
        if (!disconnectLogged) {
          clientConnected = false;
          streamAborted = true;
          disconnectLogged = true;
          // Only log in development or if needed for debugging
          if (process.env.NODE_ENV === 'development') {
            console.log(`Client disconnected during image proxy (${reason}):`, cleanPath);
          }
        }
      };
      
      req.on('close', () => handleDisconnect('close'));
      req.on('error', () => handleDisconnect('error'));
      req.on('aborted', () => handleDisconnect('aborted'));
      
      // Also monitor response connection
      res.on('close', () => handleDisconnect('response_close'));
      res.on('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
          handleDisconnect('response_error');
        } else {
          console.error('Response error during image proxy:', err);
        }
      });
      
      // Create file stream
      const fileStream = fs.createReadStream(fullPath);
      
      // Handle stream errors
      fileStream.on('error', (err) => {
        if (!streamAborted) {
          console.error('File stream error:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Error reading file' });
          }
        }
      });
      
      // Handle successful stream end
      fileStream.on('end', () => {
        if (!streamAborted) {
          console.log('Image proxy stream completed:', cleanPath);
        }
      });
      
      // Create a custom transform stream to handle client disconnection
      const monitorStream = new stream.Transform({
        transform(chunk, encoding, callback) {
          if (clientConnected && !streamAborted) {
            this.push(chunk);
          }
          callback();
        }
      });
      
      // Pipe file to response with enhanced error handling
      const pipeline = util.promisify(stream.pipeline);
      
      try {
        await pipeline(fileStream, monitorStream, res);
      } catch (err) {
        // Handle pipeline errors - these are expected for client disconnections
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          // Only log if not already logged by disconnect handler
          if (!disconnectLogged) {
            console.log('Client disconnected during pipeline:', {
              file: cleanPath,
              error: err.code,
              message: 'This is normal when clients cancel requests'
            });
          }
        } else {
          // Only log unexpected errors
          console.error('Unexpected pipeline error during image proxy:', err);
        }
      }
      
    } catch (error) {
      // Handle different types of errors appropriately
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNABORTED') {
        // Client disconnection errors - these are normal and expected
        console.log('Client disconnected during image proxy:', {
          file: cleanPath || 'unknown',
          error: error.code,
          message: 'Client cancelled request - this is normal behavior'
        });
        return; // Don't send response, client is gone
      } else if (error.code === 'ENOENT') {
        console.log('Image not found via proxy:', fullPath);
        if (!res.headersSent) {
          return res.status(404).json({ error: 'Image not found' });
        }
      } else if (error.code === 'EACCES') {
        console.log('Access denied for image proxy:', fullPath);
        if (!res.headersSent) {
          return res.status(403).json({ error: 'Access denied' });
        }
      } else {
        // Unexpected errors
        console.error('Unexpected image proxy error:', {
          error: error.message,
          code: error.code,
          file: cleanPath || 'unknown',
          stack: error.stack
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    }
};

/**
 * Create OPTIONS handler for image proxy
 * 
 * @returns {function} - Express route handler
 */
const createImageProxyOptionsHandler = () => {
  return (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
    res.status(200).end();
  };
};

module.exports = {
  createImageProxyRoute,
  createImageProxyOptionsHandler
};
