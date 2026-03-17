/**
 * Database Connection Middleware
 * 
 * Provides middleware functions for monitoring database health
 * and handling connection issues in Express routes
 */

const { testConnection } = require('../utils/database');

/**
 * Middleware to check database connection before processing requests
 * Use this for critical endpoints that require database access
 */
function ensureDbConnection(req, res, next) {
  // Skip database check for health endpoint to avoid circular dependency
  if (req.path === '/api/health') {
    return next();
  }
  
  // Quick connection test
  testConnection(req.app.get('db'))
    .then(isHealthy => {
      if (!isHealthy) {
        console.error('Database connection failed in middleware');
        return res.status(503).json({
          error: 'Database temporarily unavailable',
          message: 'Please try again in a few moments'
        });
      }
      next();
    })
    .catch(error => {
      console.error('Database middleware error:', error);
      res.status(503).json({
        error: 'Database connection error',
        message: 'Service temporarily unavailable'
      });
    });
}

/**
 * Middleware to add database connection info to request object
 * Useful for endpoints that need connection statistics
 */
function addDbInfo(req, res, next) {
  const db = req.app.get('db');
  
  if (db && db.pool) {
    req.dbInfo = {
      totalConnections: db.pool._allConnections ? db.pool._allConnections.length : 0,
      freeConnections: db.pool._freeConnections ? db.pool._freeConnections.length : 0,
      queuedRequests: db.pool._connectionQueue ? db.pool._connectionQueue.length : 0
    };
  }
  
  next();
}

/**
 * Error handler middleware for database-related errors
 * Should be used after route handlers to catch database errors
 */
function handleDatabaseErrors(err, req, res, next) {
  // Check if it's a database connection error
  if (err.code === 'PROTOCOL_CONNECTION_LOST' || 
      err.code === 'ECONNRESET' || 
      err.code === 'ENOTFOUND' ||
      err.message.includes('Connection lost')) {
    
    console.error('Database connection error in route:', err);
    
    return res.status(503).json({
      error: 'Database connection lost',
      message: 'Please try again in a few moments',
      code: err.code
    });
  }
  
  // Check if it's a database timeout error
  if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
    console.error('Database timeout error:', err);
    
    return res.status(504).json({
      error: 'Database timeout',
      message: 'Request took too long to process',
      code: err.code
    });
  }
  
  // Pass non-database errors to next handler
  next(err);
}

module.exports = {
  ensureDbConnection,
  addDbInfo,
  handleDatabaseErrors
};
