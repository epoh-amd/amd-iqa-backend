/**
 * Profile Management Routes
 * 
 * Handles user profile operations including:
 * - Profile viewing and editing
 * - User management (admin only)
 * - Permission management
 * - Access control
 * - Okta OIDC Authentication
 */

const express = require('express');
const passport = require('passport');
const { body, validationResult } = require('express-validator');
const { executeQueryCallback } = require('../utils/database');
const { exec } = require('child_process');
const {
  ensureAuthenticated,
  requirePermission,
  requireRole,
  generateJWT,
  apiAuth
} = require('../middleware/auth');

// ============================================================================
// ACTIVE DIRECTORY HELPER FUNCTIONS
// ============================================================================

/**
 * Extract location from OU in Distinguished Name
 */
function getLocationFromOU(dn) {
  if (!dn) return null;

  const ouMatches = dn.match(/OU=([^,]+)/g);

  if (ouMatches && ouMatches.length >= 2) {
    // Get the second OU (location like Austin, Penang)
    return ouMatches[1].replace('OU=', '');
  }

  // Fallback to first OU if only one exists
  return ouMatches && ouMatches.length > 0 ? ouMatches[0].replace('OU=', '') : null;
}

/**
 * Search Active Directory using ldapsearch command with email
 * Only for first-time user login to populate missing fields
 */
function searchADForUserByEmail(email) {
  return new Promise((resolve, reject) => {
    // Try multiple search filters
    const searchFilters = [
      `(userPrincipalName=${email})`,
      `(mail=${email})`,
      `(proxyAddresses=SMTP:${email})`,
      `(proxyAddresses=smtp:${email})`
    ];

    let currentFilterIndex = 0;

    function tryNextFilter() {
      if (currentFilterIndex >= searchFilters.length) {
        return resolve(null); // All filters exhausted
      }

      const currentFilter = searchFilters[currentFilterIndex];
      console.log(`   AD Search attempt ${currentFilterIndex + 1}/${searchFilters.length}: ${currentFilter}`);

      const ldapCommand = `ldapsearch -x -h ${process.env.LDAP_HOST} -p ${process.env.LDAP_PORT} -D "${process.env.LDAP_USER}" -w "${process.env.LDAP_PASSWORD}" -b "${process.env.LDAP_BASE_DN}" -s sub "${currentFilter}" sAMAccountName mail userPrincipalName physicalDeliveryOfficeName departmentNumber department employeeID displayName givenName sn`;

      exec(ldapCommand, { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          console.log(`   AD search method ${currentFilterIndex + 1} failed: ${error.message}`);
          currentFilterIndex++;
          return tryNextFilter();
        }

        // Parse LDAP output
        const lines = stdout.split('\n');
        let dn = null;
        let sAMAccountName = null;
        let mail = null;
        let userPrincipalName = null;
        let employeeID = null;
        let departmentNumber = null;
        let department = null;
        let displayName = null;
        let givenName = null;
        let sn = null;

        for (const line of lines) {
          if (line.startsWith('dn: ')) {
            dn = line.substring(4);
          } else if (line.startsWith('sAMAccountName: ')) {
            sAMAccountName = line.substring(16);
          } else if (line.startsWith('mail: ')) {
            mail = line.substring(6);
          } else if (line.startsWith('userPrincipalName: ')) {
            userPrincipalName = line.substring(19);
          } else if (line.startsWith('employeeID: ')) {
            employeeID = line.substring(12);
          } else if (line.startsWith('departmentNumber: ')) {
            departmentNumber = line.substring(18);
          } else if (line.startsWith('department: ')) {
            department = line.substring(12);
          } else if (line.startsWith('displayName: ')) {
            displayName = line.substring(13);
          } else if (line.startsWith('givenName: ')) {
            givenName = line.substring(11);
          } else if (line.startsWith('sn: ')) {
            sn = line.substring(4);
          }
        }

        if (!dn) {
          console.log(`   AD search method ${currentFilterIndex + 1} found no results`);
          currentFilterIndex++;
          return tryNextFilter();
        }

        console.log(`   Found user in AD via method ${currentFilterIndex + 1}: ${sAMAccountName}`);

        const userData = {
          sAMAccountName: sAMAccountName,
          email: mail || userPrincipalName,
          employee_number: employeeID,
          cost_center_number: departmentNumber,
          department: department,
          location:  getLocationFromOU(dn),
          display_name: displayName,
          first_name: givenName,
          last_name: sn
        };

        resolve(userData);
      });
    }

    // Start with the first filter
    tryNextFilter();
  });
}

// ============================================================================
// USER MANAGEMENT FUNCTIONS
// ============================================================================

// Helper function to add/update user in database
const createOrUpdateUser = async (user) => {
  try {
    
    // First check if user exists in database
    const existingUser = await executeQuery(
      'SELECT user_id, email, role, status FROM users WHERE email = ?',
      [user.email]
    );

    // Check if this user should be system admin (hardcoded in auth.js)
    const adminEmailsFromEnv = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',').map(email => email.trim().toLowerCase()) : [];
    const hardcodedAdminEmails = [
      'lwinaing@amd.com',
      'LwinMoe.Naing@amd.com', 
      'akoaybee@amd.com',
      'Amanda.KoayBeeWah@amd.com',
      'tzesngee@amd.com',
      'TzeShik.Ngee@amd.com',
      'ErnQi.Poh@amd.com',
       'epoh@amd.com'
    ];
    const allAdminEmails = [...adminEmailsFromEnv, ...hardcodedAdminEmails.map(email => email.toLowerCase())];
    const isHardcodedSystemAdmin = allAdminEmails.includes(user.email.toLowerCase());
    

    const userData = {
      okta_user_id: user.okta_user_id,
      email: user.email,
      full_name: user.full_name,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      department: user.department || null,
      location: user.location || null,
      employee_number: user.employee_number || null,
      cost_center_number: user.cost_center_number || null,
      status: 'active',
      last_login: new Date(),
      profile_data: JSON.stringify(user.raw_profile || {})
    };

    if (existingUser.length > 0) {
      // EXISTING USER LOGIC
      
      let finalRole;
      
      if (isHardcodedSystemAdmin) {
        // Force system admin role for hardcoded admins
        finalRole = 'admin';
      } else {
        // For non-system-admin users: PRESERVE their existing database role
        // Never reset an assigned role back to unassigned
        finalRole = existingUser[0].role; // Keep whatever role they have in DB (could be null)
      }

      // For existing users, ONLY update Okta-related fields and login tracking
      // PRESERVE all user-entered database fields (location, cost_center, etc.)
      await executeQuery(
        `UPDATE users SET 
         okta_user_id = ?, 
         role = ?, 
         status = 'active',
         last_login = ?,
         login_count = login_count + 1,
         profile_data = ?,
         updated_at = CURRENT_TIMESTAMP
         WHERE email = ?`,
        [
          userData.okta_user_id, 
          finalRole, 
          userData.last_login, 
          userData.profile_data, 
          userData.email
        ]
      );
      
      
      // Return updated user with permissions
      const updatedUser = await getUserWithPermissions(userData.email);
      return updatedUser;
      
    } else {
      // NEW USER LOGIC
      
      let initialRole;
      
      if (isHardcodedSystemAdmin) {
        // New hardcoded system admin gets admin role
        initialRole = 'admin';
      } else {
        // New regular users get NULL role (unassigned) - admin must assign role
        initialRole = null;
      }

      // FOR NEW USERS ONLY: Try to extract additional details from Active Directory
      console.log(`New user detected: ${user.email}. Attempting AD extraction...`);
      try {
        const adData = await searchADForUserByEmail(user.email);

        if (adData) {
          console.log(`AD data found for ${user.email}:`, {
            employee_number: adData.employee_number || 'N/A',
            cost_center_number: adData.cost_center_number || 'N/A',
            department: adData.department || 'N/A',
            location: adData.location || 'N/A'
          });

          // Merge AD data with Okta data (AD takes precedence for these fields)
          if (adData.employee_number) userData.employee_number = adData.employee_number;
          if (adData.cost_center_number) userData.cost_center_number = adData.cost_center_number;
          if (adData.department) userData.department = adData.department;
          if (adData.location) userData.location = adData.location;

          // Optionally enhance name fields if AD has better data
          if (adData.first_name && !userData.first_name) userData.first_name = adData.first_name;
          if (adData.last_name && !userData.last_name) userData.last_name = adData.last_name;
        } else {
          console.log(`No AD data found for ${user.email}, proceeding with Okta data only`);
        }
      } catch (adError) {
        console.log(`AD extraction failed for ${user.email}:`, adError.message);
        console.log('Proceeding with Okta data only');
      }

      // Create new user with combined Okta + AD data
      const result = await executeQuery(
        `INSERT INTO users (
          okta_user_id, email, full_name, first_name, last_name, 
          department, location, employee_number, cost_center_number,
          role, status, last_login, login_count, profile_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?)`,
        [
          userData.okta_user_id, userData.email, userData.full_name,
          userData.first_name, userData.last_name, userData.department,
          userData.location, userData.employee_number, userData.cost_center_number,
          initialRole, userData.last_login, userData.profile_data
        ]
      );
      
      
      // Return new user with permissions  
      const newUser = await getUserWithPermissions(userData.email);
      return newUser;
    }
  } catch (error) {
    console.error('Error creating/updating user:', error);
    throw error;
  }
};


// Helper function to get user with permissions from database
const getUserWithPermissions = async (email) => {
  try {
    const users = await executeQuery(
      `SELECT u.*
       FROM users u WHERE u.email = ? AND u.status = 'active'`,
      [email]
    );

    if (users.length === 0) {
      return null;
    }

    const user = users[0];
    
    // Map database role directly to category - NO AUTO ASSIGNMENT
    let actualCategory;
    
    if (user.role === 'admin') {
      actualCategory = 'cat4';
    } else if (user.role === 'manager') {
      actualCategory = 'cat3';
    } else if (user.role === 'user') {
      actualCategory = 'cat2';
    } else if (user.role === 'viewer') {
      actualCategory = 'cat1';
    } else if (user.role === 'customer') {
      actualCategory = 'customer';
    } else {
      // NULL or any other value = unassigned
      actualCategory = 'unassigned';
    }
    
    // Get permissions for the category
    const categoryPermissions = getCategoryPermissions(actualCategory);
    
    const result = {
      user_id: user.user_id,
      okta_user_id: user.okta_user_id,
      email: user.email,
      full_name: user.full_name,
      first_name: user.first_name,
      last_name: user.last_name,
      department: user.department,
      location: user.location,
      employee_number: user.employee_number,
      cost_center_number: user.cost_center_number,
      role: actualCategory, // Map to category for consistency with frontend
      category: actualCategory,
      permissions: categoryPermissions,
      status: user.status,
      last_login: user.last_login,
      created_at: user.created_at,
      updated_at: user.updated_at
    };
    
    return result;
  } catch (error) {
    console.error('Error getting user with permissions:', error);
    throw error;
  }
};

// Helper function to get all users from database
const getAllUsers = async () => {
  try {
    const users = await executeQuery(
      `SELECT u.*
       FROM users u WHERE u.status IN ('active', 'pending') 
       ORDER BY u.created_at DESC`
    );

    return users.map(user => {
      // Map database role directly to category - NO AUTO ASSIGNMENT
      let actualCategory;
      
      if (user.role === 'admin') {
        actualCategory = 'cat4';
      } else if (user.role === 'manager') {
        actualCategory = 'cat3';
      } else if (user.role === 'user') {
        actualCategory = 'cat2';
      } else if (user.role === 'viewer') {
        actualCategory = 'cat1';
      } else if (user.role === 'customer') {
        actualCategory = 'customer';
      } else {
        // NULL or any other value = unassigned
        actualCategory = 'unassigned';
      }

      return {
        user_id: user.user_id,
        okta_user_id: user.okta_user_id,
        email: user.email,
        full_name: user.full_name,
        first_name: user.first_name,
        last_name: user.last_name,
        department: user.department,
        location: user.location,
        employee_number: user.employee_number,
        cost_center_number: user.cost_center_number,
        role: actualCategory,
        category: actualCategory,
        permissions: getCategoryPermissions(actualCategory),
        status: user.status,
        last_login: user.last_login,
        created_at: user.created_at,
        updated_at: user.updated_at
      };
    });
  } catch (error) {
    console.error('Error getting all users:', error);
    throw error;
  }
};

// Helper function to map category to database role
const categoryToRole = (category) => {
  switch (category) {
    case 'cat4': return 'admin';
    case 'cat3': return 'manager';
    case 'cat2': return 'user';
    case 'cat1': return 'viewer';
    case 'customer': return 'customer';
    case 'unassigned': return null;
    default: return null; // Unassigned users get no role
  }
};

// Helper function to get permissions for a category
const getCategoryPermissions = (category) => {
  switch (category) {
    case 'cat1':
      return ['dashboard', 'search', 'clf'];
    case 'cat2':
      return ['search', 'clf', 'start_build', 'continue_build'];
    case 'cat3':
      return ['dashboard', 'search', 'clf', 'start_build', 'continue_build', 'allocation'];
    case 'cat4':
      return ['dashboard', 'search', 'clf', 'start_build', 'continue_build', 'allocation', 'user_management'];
    case 'customer':
      return ['customer_portal'];
    default:
      return []; // Unassigned users get no permissions
  }
};

const router = express.Router();

// Database helper function
function executeQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    const db = global.db;
    if (!db) {
      return reject(new Error('Database connection not available'));
    }
    executeQueryCallback(db, query, params, (err, results) => {
      if (err) {
        reject(err);
      } else {
        resolve(results);
      }
    });
  });
}

// ============================================================================
// DEBUG AND CONFIGURATION ROUTES
// ============================================================================

/**
 * GET /debug/okta-config
 * Debug route to check Okta configuration
 */
router.get('/debug/okta-config', (req, res) => {
  const config = {
    issuer: process.env.OKTA_ISSUER,
    clientId: process.env.OKTA_CLIENT_ID,
    callbackUrl: process.env.OKTA_CALLBACK_URL,
    frontendUrl: process.env.FRONTEND_URL,
    nodeEnv: process.env.NODE_ENV,
    // Don't expose the client secret
    hasClientSecret: !!process.env.OKTA_CLIENT_SECRET,
    authUrl: `${process.env.OKTA_ISSUER}/v1/authorize`,
    tokenUrl: `${process.env.OKTA_ISSUER}/v1/token`,
    userInfoUrl: `${process.env.OKTA_ISSUER}/v1/userinfo`,
    
    // Test URLs
    testUrls: {
      simpleLogin: `http://localhost:5000/api/profile/auth/okta`,
      directAuth: `${process.env.OKTA_ISSUER}/v1/authorize?response_type=code&client_id=${process.env.OKTA_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.OKTA_CALLBACK_URL)}&scope=openid%20profile%20email&state=test`,
      wellKnown: `${process.env.OKTA_ISSUER}/.well-known/openid_configuration`
    }
  };
  
  res.json(config);
});

/**
 * GET /debug/test-okta
 * Simple test route for Okta SSO
 */
router.get('/debug/test-okta', (req, res) => {
  const testUrl = `${process.env.OKTA_ISSUER}/v1/authorize?response_type=code&client_id=${process.env.OKTA_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.OKTA_CALLBACK_URL)}&scope=openid%20profile%20email&state=simple-test`;
  
  res.send(`
    <html>
      <body>
        <h2>Okta SSO Test</h2>
        <p><strong>Current Configuration:</strong></p>
        <ul>
          <li>Issuer: ${process.env.OKTA_ISSUER}</li>
          <li>Client ID: ${process.env.OKTA_CLIENT_ID}</li>
          <li>Callback URL: ${process.env.OKTA_CALLBACK_URL}</li>
        </ul>
        <p><strong>Test URLs:</strong></p>
        <ol>
          <li><a href="/api/profile/auth/okta">Use Passport Strategy (Recommended)</a></li>
          <li><a href="${testUrl}">Direct Okta URL (For Testing)</a></li>
        </ol>
        <p><strong>Direct URL (copy to test manually):</strong></p>
        <pre style="background: #f5f5f5; padding: 10px; word-break: break-all;">${testUrl}</pre>
      </body>
    </html>
  `);
});

/**
 * GET /debug/simple-okta-test
 * Very simple Okta test without passport
 */
router.get('/debug/simple-okta-test', (req, res) => {
  const issuer = process.env.OKTA_ISSUER;
  const clientId = process.env.OKTA_CLIENT_ID;
  const callbackUrl = process.env.OKTA_CALLBACK_URL;
  
  // Create a very basic Okta authorization URL
  const baseUrl = `${issuer}/v1/authorize`;
  const params = new URLSearchParams({
    'response_type': 'code',
    'client_id': clientId,
    'redirect_uri': callbackUrl,
    'scope': 'openid',
    'state': 'simple-test-' + Date.now()
  });
  
  const authUrl = `${baseUrl}?${params.toString()}`;
  
  res.send(`
    <html>
      <head><title>Okta Simple Test</title></head>
      <body>
        <h2>🔍 Okta Configuration Debug</h2>
        
        <h3>Current Environment Variables:</h3>
        <ul>
          <li><strong>OKTA_ISSUER:</strong> ${issuer}</li>
          <li><strong>OKTA_CLIENT_ID:</strong> ${clientId}</li>
          <li><strong>OKTA_CALLBACK_URL:</strong> ${callbackUrl}</li>
        </ul>
        
        <h3>Test Steps:</h3>
        <ol>
          <li><strong>Step 1:</strong> <a href="${authUrl}" target="_blank">Test Basic Okta Auth (openid only)</a></li>
          <li><strong>Step 2:</strong> <a href="/api/profile/auth/okta" target="_blank">Test via Passport Strategy</a></li>
        </ol>
        
        <h3>Manual Test URL:</h3>
        <p>Copy this URL and paste it in a new browser tab:</p>
        <textarea style="width: 100%; height: 60px; font-family: monospace; font-size: 12px;">${authUrl}</textarea>
        
        <h3>Troubleshooting:</h3>
        <ul>
          <li>If you get 400 Bad Request: Check if the Client ID exists in Okta</li>
          <li>If you get redirect_uri mismatch: Add the callback URL to your Okta app</li>
          <li>If you get "App not found": The Client ID might be wrong</li>
          <li>If you get CORS errors: This is normal for direct browser access</li>
        </ul>
        
        <h3>What to check in Okta Admin Console:</h3>
        <ol>
          <li>Go to <a href="https://amdsso.okta.com/admin/dashboard" target="_blank">https://amdsso.okta.com/admin/dashboard</a></li>
          <li>Navigate to Applications > Applications</li>
          <li>Look for application with Client ID: <code>${clientId}</code></li>
          <li>Verify it's Active and has the correct redirect URI: <code>${callbackUrl}</code></li>
        </ol>
      </body>
    </html>
  `);
});

/**
 * GET /debug/test-profile-data
 * Test what profile data we get from Okta without database operations
 */
router.get('/debug/test-profile-data', (req, res) => {
  res.send(`
    <html>
      <head><title>Profile Data Test</title></head>
      <body>
        <h2>🔍 Test Okta Profile Data</h2>
        <p>This will show you what profile data Okta returns without trying to save to database.</p>
        
        <h3>Steps:</h3>
        <ol>
          <li><a href="/api/profile/auth/okta">Click here to authenticate with Okta</a></li>
          <li>You'll be redirected back after authentication</li>
          <li>Check the server console for profile data output</li>
        </ol>
        
        <h3>What to look for in server console:</h3>
        <ul>
          <li><strong>=== Okta Callback Received ===</strong></li>
          <li><strong>Profile data:</strong> (JSON object with your profile info)</li>
          <li><strong>Extracted user info:</strong> (processed data)</li>
        </ul>
      </body>
    </html>
  `);
});

// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================

/**
 * GET /auth/okta
 * Initiate Okta OIDC authentication
 */
router.get('/auth/okta', (req, res, next) => {
  console.log('=== Okta Auth Initiation ===');
  console.log('OKTA_ISSUER:', process.env.OKTA_ISSUER);
  console.log('OKTA_CLIENT_ID:', process.env.OKTA_CLIENT_ID);
  console.log('OKTA_CALLBACK_URL:', process.env.OKTA_CALLBACK_URL);
  
  passport.authenticate('okta', (err, user, info) => {
    if (err) {
      console.error('Passport auth error:', err);
      return res.status(500).json({ error: 'Authentication initialization failed', details: err.message });
    }
    
    // This shouldn't happen in the auth initiation, but just in case
    if (!user && info) {
      console.error('Auth info:', info);
      return res.status(400).json({ error: 'Authentication failed', details: info });
    }
    
    // Continue with normal passport flow
    next();
  })(req, res, next);
}, passport.authenticate('okta'));

/**
 * GET /auth/okta/callback
 * Okta callback route after successful authentication
 */
router.get('/auth/okta/callback', 
  passport.authenticate('okta', { 
    failureRedirect: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=auth_failed` 
  }),
  (req, res) => {
    try {
      console.log('=== Auth Callback Success ===');
      console.log('User object:', req.user);
      
      // Add/update user in database instead of mock
      createOrUpdateUser(req.user)
        .then(savedUser => {
          console.log('User saved to database:', savedUser.email);
          
          // Generate JWT token for the frontend using saved user data
          const token = generateJWT(savedUser);
          
          // Redirect to frontend with token
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          res.redirect(`${frontendUrl}/auth/callback?token=${token}&user=${encodeURIComponent(JSON.stringify({
            user_id: savedUser.user_id,
            okta_user_id: savedUser.okta_user_id,
            email: savedUser.email,
            full_name: savedUser.full_name,
            first_name: savedUser.first_name,
            last_name: savedUser.last_name,
            department: savedUser.department,
            location: savedUser.location,
            employee_number: savedUser.employee_number,
            cost_center_number: savedUser.cost_center_number,
            role: savedUser.role,
            category: savedUser.category,
            permissions: savedUser.permissions,
            status: savedUser.status,
            last_login: savedUser.last_login,
            created_at: savedUser.created_at,
            updated_at: savedUser.updated_at
          }))}`);
        })
        .catch(error => {
          console.error('Error saving user to database:', error);
          res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=db_save_failed`);
        });
    } catch (error) {
      console.error('Error in auth callback:', error);
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=callback_failed`);
    }
  }
);

/**
 * POST /auth/logout
 * Logout user and destroy session
 */
router.post('/auth/logout', (req, res) => {
  const sessionId = req.sessionID;
  const userId = req.user?.user_id;

  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    
    req.session.destroy(async (err) => {
      if (err) {
        console.error('Session destroy error:', err);
        return res.status(500).json({ error: 'Session cleanup failed' });
      }

      // Update session status in database
      if (sessionId && userId) {
        try {
          await executeQuery(
            'UPDATE user_sessions SET status = "revoked" WHERE session_id = ? AND user_id = ?',
            [sessionId, userId]
          );
        } catch (dbError) {
          console.error('Error updating session status:', dbError);
        }
      }

      res.clearCookie('connect.sid');
      res.json({ 
        success: true, 
        message: 'Logged out successfully',
        oktaLogoutUrl: `${process.env.OKTA_ISSUER}/v1/logout?post_logout_redirect_uri=${encodeURIComponent(process.env.FRONTEND_URL || 'http://localhost:3000')}`
      });
    });
  });
});

/**
 * GET /auth/status
 * Check authentication status with fresh database data
 */
router.get('/auth/status', async (req, res) => {
  if (req.isAuthenticated()) {
    try {
      // Get fresh user data from database
      const user = await getUserWithPermissions(req.user.email);
      
      if (user) {
        res.json({
          authenticated: true,
          user: {
            user_id: user.user_id,
            okta_user_id: user.okta_user_id,
            email: user.email,
            full_name: user.full_name,
            first_name: user.first_name,
            last_name: user.last_name,
            department: user.department,
            location: user.location,
            employee_number: user.employee_number,
            cost_center_number: user.cost_center_number,
            role: user.role,
            category: user.category,
            permissions: user.permissions,
            status: user.status,
            last_login: user.last_login,
            created_at: user.created_at,
            updated_at: user.updated_at
          }
        });
      } else {
        // User exists in session but not in database - recreate
        const savedUser = await createOrUpdateUser(req.user);
        res.json({
          authenticated: true,
          user: {
            user_id: savedUser.user_id,
            okta_user_id: savedUser.okta_user_id,
            email: savedUser.email,
            full_name: savedUser.full_name,
            first_name: savedUser.first_name,
            last_name: savedUser.last_name,
            department: savedUser.department,
            location: savedUser.location,
            employee_number: savedUser.employee_number,
            cost_center_number: savedUser.cost_center_number,
            role: savedUser.role,
            category: savedUser.category,
            permissions: savedUser.permissions,
            status: savedUser.status,
            last_login: savedUser.last_login,
            created_at: savedUser.created_at,
            updated_at: savedUser.updated_at
          }
        });
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
      res.json({ authenticated: false });
    }
  } else {
    res.json({ authenticated: false });
  }
});

// ============================================================================
// PROFILE ROUTES
// ============================================================================

/**
 * GET /api/profile
 * Get current user's profile information
 */
router.get('/', apiAuth, async (req, res) => {
  try {
    const userEmail = req.user.email;
    
    
    // Get fresh user data with permissions using the helper function
    const user = await getUserWithPermissions(userEmail);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }


    res.json({
      success: true,
      data: user
    });

  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/profile
 * Update current user's profile information (limited fields)
 */
router.put('/', 
  apiAuth,
  [
    body('full_name').optional().isLength({ min: 1, max: 255 }).trim(),
    body('first_name').optional().isLength({ min: 1, max: 100 }).trim(),
    body('last_name').optional().isLength({ min: 1, max: 100 }).trim(),
    body('department').optional().isLength({ max: 100 }).trim(),
    body('location').optional().isLength({ max: 100 }).trim()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: errors.array() 
        });
      }

      const userId = req.user.user_id;
      const { full_name, first_name, last_name, department, location } = req.body;

      // Update only allowed fields
      const updateFields = [];
      const updateValues = [];

      if (full_name !== undefined) {
        updateFields.push('full_name = ?');
        updateValues.push(full_name);
      }
      if (first_name !== undefined) {
        updateFields.push('first_name = ?');
        updateValues.push(first_name);
      }
      if (last_name !== undefined) {
        updateFields.push('last_name = ?');
        updateValues.push(last_name);
      }
      if (department !== undefined) {
        updateFields.push('department = ?');
        updateValues.push(department);
      }
      if (location !== undefined) {
        updateFields.push('location = ?');
        updateValues.push(location);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      updateFields.push('updated_at = NOW()');
      updateValues.push(userId);

      await executeQuery(
        `UPDATE users SET ${updateFields.join(', ')} WHERE user_id = ?`,
        updateValues
      );

      res.json({
        success: true,
        message: 'Profile updated successfully'
      });

    } catch (error) {
      console.error('Error updating profile:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// USER MANAGEMENT ROUTES (Admin Only)
// ============================================================================

/**
 * GET /api/profile/admin/users
 * Get list of all users (admin only) - Admin-namespaced route
 */
router.get('/admin/users', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    // Get all users from database
    let allUsers = await getAllUsers();
    

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      allUsers = allUsers.filter(user => 
        user.full_name.toLowerCase().includes(searchLower) ||
        user.email.toLowerCase().includes(searchLower)
      );
    }

    // Apply pagination
    const total = allUsers.length;
    const users = allUsers.slice(offset, offset + limit);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile/users
 * Get list of all users (admin only)
 */
router.get('/users', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let whereClause = '';
    let queryParams = [];

    if (search) {
      whereClause = `WHERE (full_name LIKE ? OR email LIKE ? OR department LIKE ? OR location LIKE ?)`;
      const searchTerm = `%${search}%`;
      queryParams = [searchTerm, searchTerm, searchTerm, searchTerm];
    }

    // Get users with pagination
    const users = await executeQuery(
      `SELECT 
        user_id, okta_user_id, email, full_name, first_name, last_name,
        department, location, employee_number, cost_center_number,
        role, status, created_at, updated_at, last_login
      FROM users 
      ${whereClause}
      ORDER BY full_name ASC
      LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    );

    // Get total count
    const countResult = await executeQuery(
      `SELECT COUNT(*) as total FROM users ${whereClause}`,
      queryParams
    );

    const total = countResult[0].total;

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile/users/:userId
 * Get specific user details (admin only)
 */
router.get('/users/:userId', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user details
    const userResult = await executeQuery(
      `SELECT 
        user_id, okta_user_id, email, full_name, first_name, last_name,
        department, location, employee_number, cost_center_number,
        role, status, created_at, updated_at, last_login
      FROM users WHERE user_id = ?`,
      [userId]
    );

    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult[0];

    // Get user permissions
    const permissions = await executeQuery(
      `SELECT 
        up.user_permission_id, up.granted_at, up.expires_at, up.status as permission_status,
        p.permission_id, p.permission_name, p.resource_type, p.access_level, p.description,
        granted_by_user.full_name as granted_by_name
      FROM user_permissions up
      JOIN permissions p ON up.permission_id = p.permission_id
      LEFT JOIN users granted_by_user ON up.granted_by = granted_by_user.user_id
      WHERE up.user_id = ?
      ORDER BY p.resource_type, p.permission_name`,
      [userId]
    );

    user.permissions = permissions;

    res.json({
      success: true,
      data: user
    });

  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile/admin/roles
 * Get list of all available categories (admin only)
 */
router.get('/admin/roles', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    // Return the 4 categories with their permissions
    const categories = [
      {
        id: 'cat1',
        name: 'Category 1',
        description: 'Dashboard, Search, CLF access',
        permissions: ['dashboard', 'search', 'clf']
      },
      {
        id: 'cat2',
        name: 'Category 2',
        description: 'Search, CLF, Start Build, Continue Build access',
        permissions: ['search', 'clf', 'start_build', 'continue_build']
      },
      {
        id: 'cat3',
        name: 'Category 3',
        description: 'Dashboard, Search, CLF, Start Build, Continue Build, Allocation access',
        permissions: ['dashboard', 'search', 'clf', 'start_build', 'continue_build', 'allocation']
      },
      {
        id: 'cat4',
        name: 'Category 4 (System Admin)',
        description: 'Full system access including User Management',
        permissions: ['dashboard', 'search', 'clf', 'start_build', 'continue_build', 'allocation', 'user_management']
      },
      {
        id: 'customer',
        name: 'Customer',
        description: 'Customer portal access only',
        permissions: ['customer_portal']
      },
      {
        id: 'unassigned',
        name: 'Unassigned',
        description: 'No access - awaiting role assignment',
        permissions: []
      }
    ];

    res.json({
      success: true,
      data: { roles: categories }
    });

  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/profile/admin/users/:userId
 * Update user details (admin only)
 */
router.put('/admin/users/:userId', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const { userId } = req.params;
    const { first_name, last_name, department, location, employee_number, cost_center_number } = req.body;

    console.log(`📝 Admin updating user details for userId: ${userId}`);

    // Build dynamic update query
    const updateFields = [];
    const updateValues = [];

    if (first_name !== undefined) {
      updateFields.push('first_name = ?');
      updateValues.push(first_name);
    }
    if (last_name !== undefined) {
      updateFields.push('last_name = ?');  
      updateValues.push(last_name);
    }
    if (department !== undefined) {
      updateFields.push('department = ?');
      updateValues.push(department);
    }
    if (location !== undefined) {
      updateFields.push('location = ?');
      updateValues.push(location);
    }
    if (employee_number !== undefined) {
      updateFields.push('employee_number = ?');
      updateValues.push(employee_number);
    }
    if (cost_center_number !== undefined) {
      updateFields.push('cost_center_number = ?');
      updateValues.push(cost_center_number);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(userId);

    await executeQuery(
      `UPDATE users SET ${updateFields.join(', ')} WHERE user_id = ?`,
      updateValues
    );

    console.log(`✅ Admin updated user ${userId} details successfully`);

    res.json({
      success: true,
      message: 'User details updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating user details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/profile/admin/users/:userId/role
 * Update user category (admin only)
 */
router.put('/admin/users/:userId/role', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'Category is required' });
    }

    // Validate category
    const validCategories = ['cat1', 'cat2', 'cat3', 'cat4', 'customer', 'unassigned'];
    if (!validCategories.includes(role)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    // Convert category to database role
    const dbRole = categoryToRole(role);

    // Get user email first for cache invalidation
    const userInfo = await executeQuery('SELECT email FROM users WHERE user_id = ?', [userId]);
    if (userInfo.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update user in database (userId is numeric ID)
    const result = await executeQuery(
      'UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = "active"',
      [dbRole, userId]
    );

    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get updated user with permissions (by numeric user_id)
    const userRows = await executeQuery('SELECT email FROM users WHERE user_id = ?', [userId]);
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ error: 'User not found after update' });
    }
    const updatedUser = await getUserWithPermissions(userRows[0].email);
    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found after update' });
    }

    console.log(`✅ Admin ${req.user.email} assigned category ${role} to user ${userId}`);
    console.log(`✅ User ${userId} now has permissions:`, getCategoryPermissions(role));

    res.json({
      success: true,
      message: `User category updated to ${role} successfully`,
      data: {
        user: {
          email: updatedUser.email,
          full_name: updatedUser.full_name,
          category: updatedUser.category,
          permissions: updatedUser.permissions,
          updated_at: updatedUser.updated_at
        }
      }
    });

  } catch (error) {
    console.error('Error updating user category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/profile/admin/users/:userId/status
 * Update user status (admin only)
 */
router.put('/admin/users/:userId/status', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    // Validate status
    const validStatuses = ['active', 'inactive', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Update user status in database
    await executeQuery(
      'UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [status, userId]
    );

    res.json({
      success: true,
      message: 'User status updated successfully'
    });

  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// ACCESS CONTROL VALIDATION
// ============================================================================

/**
 * POST /api/profile/validate-access
 * Validate user access to specific resource
 */
router.post('/validate-access',
  apiAuth,
  [
    body('resource').isLength({ min: 1, max: 100 }).trim(),
    body('action').isLength({ min: 1, max: 100 }).trim()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          error: 'Validation failed', 
          details: errors.array() 
        });
      }

      const { resource, action } = req.body;
      const userId = req.user.user_id;
      const userRole = req.user.role;

      // Admin users have access to everything
      if (userRole === 'admin') {
        return res.json({
          success: true,
          access: true,
          reason: 'Admin privileges'
        });
      }

      // Check specific permissions
      const permissions = await executeQuery(
        `SELECT p.access_level
        FROM user_permissions up
        JOIN permissions p ON up.permission_id = p.permission_id
        WHERE up.user_id = ? AND p.resource_type = ? AND up.status = 'active'
        AND (up.expires_at IS NULL OR up.expires_at > NOW())`,
        [userId, resource]
      );

      const hasAccess = permissions.some(p => 
        p.access_level === 'full' || 
        p.access_level === action ||
        (action === 'read' && ['write', 'admin', 'full'].includes(p.access_level))
      );

      // Log access attempt
      await executeQuery(
        `INSERT INTO access_logs (user_id, action, resource, success, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          userId, 
          action, 
          resource, 
          hasAccess,
          req.ip,
          req.get('User-Agent') || null
        ]
      );

      res.json({
        success: true,
        access: hasAccess,
        reason: hasAccess ? 'Permission granted' : 'Insufficient permissions'
      });

    } catch (error) {
      console.error('Error validating access:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// SYSTEM ADMINISTRATION ROUTES (Admin Only)
// ============================================================================

/**
 * GET /api/profile/system/settings
 * Get system settings and configuration
 */
router.get('/system/settings', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const settings = await executeQuery(`
      SELECT setting_key, setting_value, setting_type, description, is_public
      FROM system_settings
      ORDER BY setting_key ASC
    `);

    const formattedSettings = {};
    settings.forEach(setting => {
      let value = setting.setting_value;
      
      // Parse value based on type
      switch (setting.setting_type) {
        case 'number':
          value = parseInt(value);
          break;
        case 'boolean':
          value = value === 'true';
          break;
        case 'json':
          try {
            value = JSON.parse(value);
          } catch (e) {
            value = setting.setting_value;
          }
          break;
      }

      formattedSettings[setting.setting_key] = {
        value,
        type: setting.setting_type,
        description: setting.description,
        isPublic: setting.is_public
      };
    });

    res.json({
      success: true,
      settings: formattedSettings
    });
  } catch (error) {
    console.error('Error fetching system settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/profile/system/settings
 * Update system settings
 */
router.put('/system/settings', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const { settings } = req.body;
    const userId = req.user.user_id;
    const updates = [];

    for (const [key, value] of Object.entries(settings)) {
      // Validate setting exists
      const existingSetting = await executeQuery(
        'SELECT setting_key, setting_type FROM system_settings WHERE setting_key = ?',
        [key]
      );

      if (existingSetting.length === 0) {
        continue; // Skip non-existent settings
      }

      const settingType = existingSetting[0].setting_type;
      let formattedValue = value;

      // Format value based on type
      switch (settingType) {
        case 'json':
          formattedValue = JSON.stringify(value);
          break;
        case 'boolean':
          formattedValue = value ? 'true' : 'false';
          break;
        default:
          formattedValue = String(value);
      }

      await executeQuery(
        'UPDATE system_settings SET setting_value = ?, updated_by = ?, updated_at = NOW() WHERE setting_key = ?',
        [formattedValue, userId, key]
      );

      updates.push(key);
    }

    // Log the settings update
    await executeQuery(
      `INSERT INTO access_logs (user_id, action, resource, success, additional_data)
      VALUES (?, ?, ?, ?, ?)`,
      [
        userId,
        'system_settings_updated',
        'system_settings',
        true,
        JSON.stringify({ updated_settings: updates })
      ]
    );

    res.json({
      success: true,
      message: `Updated ${updates.length} settings`,
      updated: updates
    });

  } catch (error) {
    console.error('Error updating system settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile/system/audit
 * Get system audit logs (admin only)
 */
router.get('/system/audit', apiAuth, requireRole(['cat4']), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const userId = req.query.userId;
    const action = req.query.action;
    const resource = req.query.resource;

    let whereClause = '';
    let queryParams = [];

    const conditions = [];

    if (startDate) {
      conditions.push('al.created_at >= ?');
      queryParams.push(startDate);
    }

    if (endDate) {
      conditions.push('al.created_at <= ?');
      queryParams.push(endDate);
    }

    if (userId) {
      conditions.push('al.user_id = ?');
      queryParams.push(userId);
    }

    if (action) {
      conditions.push('al.action LIKE ?');
      queryParams.push(`%${action}%`);
    }

    if (resource) {
      conditions.push('al.resource = ?');
      queryParams.push(resource);
    }

    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    // Get audit logs
    const logs = await executeQuery(`
      SELECT 
        al.*,
        u.full_name,
        u.email,
        u.role
      FROM access_logs al
      LEFT JOIN users u ON al.user_id = u.user_id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    // Get total count
    const countResult = await executeQuery(`
      SELECT COUNT(*) as total
      FROM access_logs al
      ${whereClause}
    `, queryParams);

    const total = countResult[0].total;

    res.json({
      success: true,
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// HEALTH CHECK AND TESTING ROUTES
// ============================================================================

/**
 * GET /health
 * Health check endpoint for testing database connectivity
 */
router.get('/health', async (req, res) => {
  try {
    // Test database connection
    await executeQuery('SELECT 1 as test');
    
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /session/test
 * Test session functionality
 */
router.get('/session/test', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  res.json({
    authenticated: true,
    sessionId: req.sessionID,
    user: req.user?.email || 'Unknown'
  });
});

/**
 * GET /permissions
 * Get list of all available permissions (for admin UI)
 */
router.get('/permissions', apiAuth, async (req, res) => {
  try {
    const permissions = await executeQuery('SELECT permission_name, description FROM permissions ORDER BY permission_name');
    res.json({ 
      success: true,
      permissions 
    });
  } catch (error) {
    console.error('Error fetching permissions:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

/**
 * GET /permissions/list
 * Get list of all available permissions (public endpoint for testing)
 */
router.get('/permissions/list', async (req, res) => {
  try {
    const permissions = await executeQuery('SELECT permission_name, description FROM permissions ORDER BY permission_name');
    res.json({ permissions });
  } catch (error) {
    console.error('Error fetching permissions list:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

// ============================================================================
// TEST ENDPOINTS (NO AUTH) - FOR DEBUGGING
// ============================================================================



module.exports = router;