/**
 * Database Utility Functions
 * 
 * Provides helper functions for database operations with automatic
 * retry logic and connection recovery
 */

const mysql = require('mysql2');

/**
 * Execute a database query with automatic retry on connection failures
 * Enhanced for high concurrency (100-200 users)
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {string} query - SQL query string
 * @param {Array} params - Query parameters
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise} - Query results
 */
async function executeQuery(pool, query, params = [], maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      
      // Check if pool has promise() method, otherwise create promisified version
      const promisePool = pool.promise ? pool.promise() : pool;
      const [results] = await promisePool.query(query, params);
      
      // Log slow queries in production (>1000ms)
      const executionTime = Date.now() - startTime;
      if (executionTime > 1000) {
        console.warn(`Slow query detected (${executionTime}ms):`, query.substring(0, 100));
      }
      
      return results;
    } catch (error) {
      lastError = error;
      
      // Check if it's a connection-related error
      if (isConnectionError(error)) {
        console.warn(`Database connection error on attempt ${attempt}:`, error.message);
        
        if (attempt < maxRetries) {
          // Wait before retry with jitter to prevent thundering herd
          const baseDelay = Math.pow(2, attempt) * 1000;
          const jitter = Math.random() * 1000;
          const delay = baseDelay + jitter;
          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      // Log database errors for monitoring
      console.error('Database query error:', {
        query: query.substring(0, 100),
        error: error.message,
        code: error.code,
        attempt
      });
      
      // If not a connection error or max retries reached, throw the error
      throw error;
    }
  }
  
  throw lastError;
}

/**
 * Execute a database query with callback (for compatibility with existing code)
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {string} query - SQL query string
 * @param {Array} params - Query parameters
 * @param {Function} callback - Callback function (err, results)
 */
function executeQueryCallback(pool, query, params, callback) {
  // Handle case where params is actually the callback
  if (typeof params === 'function') {
    callback = params;
    params = [];
  }
  
  executeQuery(pool, query, params)
    .then(results => callback(null, results))
    .catch(error => callback(error));
}

/**
 * Check if an error is connection-related and should trigger a retry
 * 
 * @param {Error} error - The error to check
 * @returns {boolean} - True if it's a connection error
 */
function isConnectionError(error) {
  const connectionErrorCodes = [
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_QUIT',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'ECONNRESET',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ER_SERVER_GONE_ERROR',
    'ER_SERVER_LOST'
  ];
  
  return connectionErrorCodes.includes(error.code) || 
         error.message.includes('Connection lost') ||
         error.message.includes('server has gone away');
}

/**
 * Create a transaction wrapper with automatic retry
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {Function} transactionFn - Function that performs transaction operations
 * @returns {Promise} - Transaction results
 */
async function executeTransaction(pool, transactionFn) {
  const connection = await pool.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const result = await transactionFn(connection);
    
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Test database connection health
 * 
 * @param {Object} pool - MySQL connection pool
 * @returns {Promise<boolean>} - True if connection is healthy
 */
async function testConnection(pool) {
  try {
    await executeQuery(pool, 'SELECT 1');
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}

/**
 * Set the global database pool for use across the application
 * 
 * @param {Object} pool - MySQL connection pool
 */
function setGlobalPool(pool) {
  global.db = pool;
  console.log('✅ Global database pool configured');
}

/**
 * Get the global database pool
 * 
 * @returns {Object} - MySQL connection pool
 */
function getGlobalPool() {
  return global.db;
}

module.exports = {
  executeQuery,
  executeQueryCallback,
  executeTransaction,
  testConnection,
  setGlobalPool,
  getGlobalPool,
  isConnectionError
};