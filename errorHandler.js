/**
 * Enhanced Backend Error Handler
 * 
 * Provides consistent, structured error responses that work with 
 * the frontend error handling system.
 */

/**
 * Standardized error response structure
 */
class APIError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Database error codes mapping
 */
const DB_ERROR_CODES = {
  'ER_DUP_ENTRY': 'DUPLICATE_ENTRY',
  'ER_NO_REFERENCED_ROW_2': 'INVALID_REFERENCE',
  'ER_DATA_TOO_LONG': 'DATA_TOO_LONG',
  'ER_TRUNCATED_WRONG_VALUE': 'INVALID_DATA_FORMAT',
  'ER_BAD_NULL_ERROR': 'REQUIRED_FIELD_MISSING',
  'ECONNREFUSED': 'DATABASE_CONNECTION_FAILED',
  'PROTOCOL_CONNECTION_LOST': 'DATABASE_CONNECTION_LOST'
};

/**
 * Create standardized error responses
 */
const createErrorResponse = (error, context = '') => {
  console.error(`[${context}] Error:`, error);

  // Handle MySQL/Database errors
  if (error.code && DB_ERROR_CODES[error.code]) {
    const errorCode = DB_ERROR_CODES[error.code];
    
    switch (errorCode) {
      case 'DUPLICATE_ENTRY':
        return {
          statusCode: 409,
          error: 'Duplicate data detected',
          message: 'This record already exists in the system. Please use unique values.',
          code: 'DUPLICATE_ENTRY',
          technical: error.message
        };
        
      case 'INVALID_REFERENCE':
        return {
          statusCode: 400,
          error: 'Invalid reference',
          message: 'Referenced record does not exist. Please verify your data.',
          code: 'INVALID_REFERENCE',
          technical: error.message
        };
        
      case 'DATA_TOO_LONG':
        return {
          statusCode: 400,
          error: 'Data too long',
          message: 'One or more fields contain too much data. Please shorten your input.',
          code: 'DATA_TOO_LONG',
          technical: error.message
        };
        
      case 'INVALID_DATA_FORMAT':
        return {
          statusCode: 400,
          error: 'Invalid data format',
          message: 'Data format is invalid. Please check your input.',
          code: 'INVALID_DATA_FORMAT',
          technical: error.message
        };
        
      case 'REQUIRED_FIELD_MISSING':
        return {
          statusCode: 400,
          error: 'Required field missing',
          message: 'Required fields are missing. Please fill all required fields.',
          code: 'REQUIRED_FIELD_MISSING',
          technical: error.message
        };
        
      case 'DATABASE_CONNECTION_FAILED':
      case 'DATABASE_CONNECTION_LOST':
        return {
          statusCode: 503,
          error: 'Database unavailable',
          message: 'Database is temporarily unavailable. Please try again later.',
          code: 'DATABASE_UNAVAILABLE',
          technical: error.message
        };
    }
  }

  // Handle custom API errors
  if (error instanceof APIError) {
    return {
      statusCode: error.statusCode,
      error: error.code,
      message: error.message,
      code: error.code,
      technical: error.details || error.stack
    };
  }

  // Handle validation errors
  if (error.name === 'ValidationError') {
    return {
      statusCode: 400,
      error: 'Validation failed',
      message: 'Input validation failed. Please check your data.',
      code: 'VALIDATION_ERROR',
      technical: error.message
    };
  }

  // Default server error
  return {
    statusCode: 500,
    error: 'Internal server error',
    message: 'An unexpected error occurred. Please try again or contact support.',
    code: 'INTERNAL_ERROR',
    technical: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
  };
};

/**
 * Send error response with consistent structure
 */
const sendErrorResponse = (res, error, context = '') => {
  const errorResponse = createErrorResponse(error, context);
  
  // Log error details for debugging
  console.error(`[API Error - ${context}]`, {
    statusCode: errorResponse.statusCode,
    code: errorResponse.code,
    message: errorResponse.message,
    technical: errorResponse.technical,
    timestamp: new Date().toISOString()
  });

  // Send response (exclude technical details in production)
  const clientResponse = {
    error: errorResponse.error,
    message: errorResponse.message,
    code: errorResponse.code,
    timestamp: new Date().toISOString()
  };

  // Include technical details only in development
  if (process.env.NODE_ENV === 'development') {
    clientResponse.technical = errorResponse.technical;
  }

  res.status(errorResponse.statusCode).json(clientResponse);
};

/**
 * Async route wrapper that catches errors
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Global error handling middleware
 */
const errorHandler = (err, req, res, next) => {
  sendErrorResponse(res, err, `${req.method} ${req.path}`);
};

/**
 * Validation helper functions
 */
const validateRequired = (fields, data) => {
  const missing = [];
  fields.forEach(field => {
    if (!data[field] || data[field].toString().trim() === '') {
      missing.push(field);
    }
  });
  
  if (missing.length > 0) {
    throw new APIError(
      `Required fields missing: ${missing.join(', ')}`,
      400,
      'REQUIRED_FIELDS_MISSING',
      { missingFields: missing }
    );
  }
};

const validateSerialNumber = (serialNumber, type) => {
  if (!serialNumber) return;
  switch (type) {
    // Removed M.2 S/N validation for starting with S as per requirements
    case 'MAC':
      if (!serialNumber.match(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/)) {
        throw new APIError(
          'MAC address format is invalid',
          400,
          'INVALID_MAC_FORMAT',
          { macAddress: serialNumber, expectedFormat: 'XX:XX:XX:XX:XX:XX' }
        );
      }
      break;
  }
};

/**
 * Business logic error creators
 */
const createBusinessError = {
  buildNotFound: (chassisSN) => new APIError(
    `Build not found with chassis S/N: ${chassisSN}`,
    404,
    'BUILD_NOT_FOUND',
    { chassisSN }
  ),
  
  platformNotFound: (systemPN) => new APIError(
    `Platform not found for system P/N: ${systemPN}`,
    404,
    'PLATFORM_NOT_FOUND',
    { systemPN }
  ),
  
  invalidBuildStatus: (currentStatus, requiredStatus) => new APIError(
    `Build status is ${currentStatus}, but ${requiredStatus} is required for this operation`,
    400,
    'INVALID_BUILD_STATUS',
    { currentStatus, requiredStatus }
  ),
  
  reworkNotAllowed: (chassisSN, reason) => new APIError(
    `Rework not allowed for build ${chassisSN}: ${reason}`,
    403,
    'REWORK_NOT_ALLOWED',
    { chassisSN, reason }
  ),
  
  fileTooLarge: (fileSize, maxSize) => new APIError(
    `File size ${fileSize}MB exceeds maximum allowed size of ${maxSize}MB`,
    413,
    'FILE_TOO_LARGE',
    { fileSize, maxSize }
  ),
  
  invalidFileType: (fileType, allowedTypes) => new APIError(
    `File type ${fileType} is not allowed. Allowed types: ${allowedTypes.join(', ')}`,
    415,
    'INVALID_FILE_TYPE',
    { fileType, allowedTypes }
  )
};

module.exports = {
  APIError,
  createErrorResponse,
  sendErrorResponse,
  asyncHandler,
  errorHandler,
  validateRequired,
  validateSerialNumber,
  createBusinessError
};
