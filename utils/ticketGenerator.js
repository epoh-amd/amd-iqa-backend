//backend/utils/ticketGenerator.js

/**
 * Ticket ID Generation Utilities
 * Handles customer escalation ticket ID generation with proper sequencing
 */

/**
 * DEPRECATED: Generate next ticket ID for customer escalations (has race condition)
 * Use generateTicketIdSafe instead
 */
async function generateTicketId(connection) {
  console.warn('generateTicketId is deprecated due to race conditions. Use generateTicketIdSafe instead.');
  try {
    const [rows] = await connection.query(
      'SELECT ticket_id FROM customer_escalations ORDER BY ticket_id DESC LIMIT 1'
    );
    
    let nextNumber = 1;
    if (rows.length > 0) {
      const lastId = rows[0].ticket_id;
      const lastNumber = parseInt(lastId.split('-')[1]);
      if (!isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }
    
    return `C-${String(nextNumber).padStart(5, '0')}`;
  } catch (error) {
    console.error('Error generating ticket ID:', error);
    throw error;
  }
}

/**
 * NEW: Race-condition safe ticket ID generation using SELECT FOR UPDATE
 * This prevents duplicate ticket IDs even under high concurrency
 * FIXED: Now properly handles existing ticket IDs in database
 * 
 * @param {Object} connection - Database connection (transaction will be handled internally)
 * @returns {Promise<string>} - Next ticket ID in format C-XXXXX
 * @throws {Error} - Database or parsing errors
 */
async function generateTicketIdSafe(connection) {
  try {
    // Start transaction
    await connection.query('START TRANSACTION');
    
    // FIXED: Lock the last ticket record to prevent race conditions
    // Order by ticket_id DESC to get the highest numbered ticket
    const [rows] = await connection.query(`
      SELECT ticket_id 
      FROM customer_escalations 
      WHERE ticket_id REGEXP '^C-[0-9]+$'
      ORDER BY CAST(SUBSTRING(ticket_id, 3) AS UNSIGNED) DESC
      LIMIT 1 
      FOR UPDATE
    `);
    
    let nextNumber = 1;
    if (rows.length > 0) {
      const lastId = rows[0].ticket_id;
      console.log(`Last ticket ID found: ${lastId}`);
      
      // Extract number from ticket ID (e.g., "C-00013" -> 13)
      const match = lastId.match(/^C-(\d+)$/);
      if (match) {
        const lastNumber = parseInt(match[1], 10);
        nextNumber = lastNumber + 1;
        console.log(`Next number will be: ${nextNumber}`);
      }
    } else {
      console.log('No existing tickets found, starting from 1');
    }
    
    const ticketId = `C-${String(nextNumber).padStart(5, '0')}`;
    console.log(`Generated ticket ID: ${ticketId}`);
    
    // Don't commit here - let the calling function handle the transaction
    return ticketId;
    
  } catch (error) {
    await connection.query('ROLLBACK');
    console.error('Error generating safe ticket ID:', error);
    throw error;
  }
}

/**
 * Alternative method using MAX() function - more efficient
 * This gets the maximum sequence number directly
 */
async function generateTicketIdSafeAlt(connection) {
  try {
    await connection.query('START TRANSACTION');
    
    // Get the maximum sequence number directly
    const [rows] = await connection.query(`
      SELECT 
        COALESCE(
          MAX(CAST(SUBSTRING(ticket_id, 3) AS UNSIGNED)), 
          0
        ) + 1 as next_sequence
      FROM customer_escalations 
      WHERE ticket_id REGEXP '^C-[0-9]+$'
      FOR UPDATE
    `);
    
    const nextNumber = rows[0].next_sequence;
    const ticketId = `C-${String(nextNumber).padStart(5, '0')}`;
    
    console.log(`Generated ticket ID (alt method): ${ticketId}`);
    return ticketId;
    
  } catch (error) {
    await connection.query('ROLLBACK');
    console.error('Error generating safe ticket ID (alt):', error);
    throw error;
  }
}

/**
 * Debug function to check current state of tickets
 */
async function debugTicketState(connection) {
  try {
    const [allTickets] = await connection.query(`
      SELECT ticket_id, 
             CAST(SUBSTRING(ticket_id, 3) AS UNSIGNED) as sequence_num
      FROM customer_escalations 
      WHERE ticket_id REGEXP '^C-[0-9]+$'
      ORDER BY sequence_num DESC
      LIMIT 5
    `);
    
    console.log('Current tickets in database:');
    allTickets.forEach(ticket => {
      console.log(`- ${ticket.ticket_id} (sequence: ${ticket.sequence_num})`);
    });
    
    const [maxTicket] = await connection.query(`
      SELECT ticket_id,
             COALESCE(MAX(CAST(SUBSTRING(ticket_id, 3) AS UNSIGNED)), 0) as max_sequence
      FROM customer_escalations 
      WHERE ticket_id REGEXP '^C-[0-9]+$'
    `);
    
    console.log(`Max sequence number: ${maxTicket[0].max_sequence}`);
    console.log(`Next ticket should be: C-${String(maxTicket[0].max_sequence + 1).padStart(5, '0')}`);
    
  } catch (error) {
    console.error('Error debugging ticket state:', error);
  }
}

/**
 * Alternative implementation using database sequence/auto-increment
 * This approach is more atomic and handles concurrency better
 * 
 * @param {Object} connection - Database connection
 * @returns {Promise<string>} - Next ticket ID
 */
async function generateTicketIdWithSequence(connection) {
  try {
    // Option 1: Use a dedicated sequence table (recommended for high concurrency)
    const [result] = await connection.query(
      'INSERT INTO ticket_sequences (ticket_type) VALUES (?)',
      ['customer_escalation']
    );
    
    const sequenceNumber = result.insertId;
    return `C-${String(sequenceNumber).padStart(5, '0')}`;
  } catch (error) {
    console.error('Error generating ticket ID with sequence:', error);
    throw error;
  }
}

/**
 * Generate RMA ticket ID (if needed for future)
 * Format: RMA-00001, RMA-00002, etc.
 * 
 * @param {Object} connection - Database connection
 * @returns {Promise<string>} - Next RMA ticket ID
 */
async function generateRMATicketId(connection) {
  try {
    await connection.query('START TRANSACTION');
    
    const [rows] = await connection.query(`
      SELECT rma_id 
      FROM rma_tickets 
      ORDER BY rma_id DESC 
      LIMIT 1 
      FOR UPDATE
    `);
    
    let nextNumber = 1;
    if (rows.length > 0) {
      const lastId = rows[0].rma_id;
      const match = lastId.match(/^RMA-(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1], 10) + 1;
      }
    }
    
    const rmaId = `RMA-${String(nextNumber).padStart(5, '0')}`;
    await connection.query('COMMIT');
    return rmaId;
    
  } catch (error) {
    await connection.query('ROLLBACK');
    console.error('Error generating RMA ticket ID:', error);
    throw error;
  }
}

/**
 * Validate ticket ID format
 * 
 * @param {string} ticketId - Ticket ID to validate
 * @param {string} type - Expected type ('customer', 'rma')
 * @returns {boolean} - Whether ticket ID is valid
 */
function validateTicketId(ticketId, type = 'customer') {
  if (!ticketId || typeof ticketId !== 'string') {
    return false;
  }
  
  const patterns = {
    customer: /^C-\d{5}$/,
    rma: /^RMA-\d{5}$/
  };
  
  return patterns[type] ? patterns[type].test(ticketId) : false;
}

/**
 * Extract sequence number from ticket ID
 * 
 * @param {string} ticketId - Ticket ID (e.g., 'C-00123')
 * @returns {number|null} - Sequence number or null if invalid
 */
function extractSequenceNumber(ticketId) {
  if (!ticketId || typeof ticketId !== 'string') {
    return null;
  }
  
  const match = ticketId.match(/^[A-Z]+-(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Get next ticket ID without database transaction (less safe for concurrency)
 * Use this only for low-traffic applications
 * 
 * @param {Object} db - Database pool
 * @returns {Promise<string>} - Next ticket ID
 */
async function getNextTicketIdSimple(db) {
  try {
    const [rows] = await db.promise().query(
      'SELECT ticket_id FROM customer_escalations ORDER BY ticket_id DESC LIMIT 1'
    );
    
    let nextNumber = 1;
    if (rows.length > 0) {
      const lastId = rows[0].ticket_id;
      const lastNumber = parseInt(lastId.split('-')[1]);
      if (!isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }
    
    return `C-${String(nextNumber).padStart(5, '0')}`;
  } catch (error) {
    console.error('Error getting next ticket ID:', error);
    throw error;
  }
}

module.exports = {
  generateTicketId,
  generateTicketIdSafe,
  generateTicketIdSafeAlt,
  debugTicketState,
  generateTicketIdWithSequence,
  generateRMATicketId,
  validateTicketId,
  extractSequenceNumber,
  getNextTicketIdSimple
};