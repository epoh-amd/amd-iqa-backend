/**
 * Authentication Middleware for Okta OIDC Integration
 * 
 * This middleware handles:
 * - Okta OIDC authentication setup
 * - User session management
 * - Profile data extraction and storage
 * - Access control validation
 */

const passport = require('passport');
const OpenIDConnectStrategy = require('passport-openidconnect').Strategy;
const jwt = require('jsonwebtoken');

// Okta OIDC Strategy Configuration
const setupOktaAuth = () => {
  console.log('Setting up Okta authentication...');
  console.log('OKTA_ISSUER:', process.env.OKTA_ISSUER);
  console.log('OKTA_CLIENT_ID:', process.env.OKTA_CLIENT_ID ? 'Set' : 'Not set');
  console.log('OKTA_CALLBACK_URL:', process.env.OKTA_CALLBACK_URL);

  passport.use('okta', new OpenIDConnectStrategy({
    issuer: process.env.OKTA_ISSUER,
    authorizationURL: `${process.env.OKTA_ISSUER}/v1/authorize`,
    tokenURL: `${process.env.OKTA_ISSUER}/v1/token`,
    userInfoURL: `${process.env.OKTA_ISSUER}/v1/userinfo`,
    clientID: process.env.OKTA_CLIENT_ID,
    clientSecret: process.env.OKTA_CLIENT_SECRET,
    callbackURL: process.env.OKTA_CALLBACK_URL,
    scope: 'openid profile email',
    skipUserProfile: false,
    // Add some additional configuration for troubleshooting
    passReqToCallback: false,
    // Disable SSL verification for local development (remove in production)
    ...(process.env.NODE_ENV === 'development' && {
      customHeaders: {
        'User-Agent': 'AMD-IQA-System/1.0'
      }
    })
  }, async (...args) => {
    console.log('=== Okta Callback Received ===');
    console.log('Total arguments:', args.length);
    
    // Debug all arguments
    args.forEach((arg, index) => {
      console.log(`Arg ${index}:`, typeof arg, Array.isArray(arg) ? 'array' : '', arg?.constructor?.name);
    });
    
    // Find the callback function (should be a function type)
    const callbackIndex = args.findIndex(arg => typeof arg === 'function');
    const profileIndex = args.findIndex(arg => arg && typeof arg === 'object' && arg.id);
    
    console.log('Callback function at index:', callbackIndex);
    console.log('Profile object at index:', profileIndex);
    
    if (callbackIndex === -1) {
      console.error('No callback function found in arguments!');
      return;
    }
    
    if (profileIndex === -1) {
      console.error('No profile object found in arguments!');
      return;
    }
    
    const done = args[callbackIndex];
    const profile = args[profileIndex];
    
    console.log('=== DETAILED PROFILE DEBUG ===');
    console.log('Full profile object:', JSON.stringify(profile, null, 2));
    console.log('Profile.id:', profile.id);
    console.log('Profile.emails:', profile.emails);
    console.log('Profile.username:', profile.username);
    console.log('Profile.email:', profile.email);
    console.log('Profile.displayName:', profile.displayName);
    console.log('Profile.name:', profile.name);
    console.log('Profile._json:', profile._json);
    
    // Try multiple ways to extract email
    let userEmail = null;
    
    // Method 1: Check emails array
    if (profile.emails && Array.isArray(profile.emails) && profile.emails.length > 0) {
      userEmail = profile.emails[0].value;
      console.log('Email from emails array:', userEmail);
    }
    
    // Method 2: Direct email property
    if (!userEmail && profile.email) {
      userEmail = profile.email;
      console.log('Email from direct property:', userEmail);
    }
    
    // Method 3: From _json property (common in Okta)
    if (!userEmail && profile._json && profile._json.email) {
      userEmail = profile._json.email;
      console.log('Email from _json:', userEmail);
    }
    
    // Method 4: Username as fallback
    if (!userEmail && profile.username) {
      userEmail = profile.username;
      console.log('Email from username:', userEmail);
    }
    
    // Method 5: Default fallback
    if (!userEmail) {
      userEmail = 'user@amd.com';
      console.log('Using default email fallback');
    }
    
    console.log('Final extracted email:', userEmail);
    
    // Extract display name with better fallbacks
    let displayName = null;
    
    if (profile.displayName) {
      displayName = profile.displayName;
    } else if (profile._json && profile._json.name) {
      displayName = profile._json.name;
    } else if (profile.name && profile.name.formatted) {
      displayName = profile.name.formatted;
    } else if (profile.name && (profile.name.givenName || profile.name.familyName)) {
      displayName = `${profile.name.givenName || ''} ${profile.name.familyName || ''}`.trim();
    } else if (profile._json && (profile._json.given_name || profile._json.family_name)) {
      displayName = `${profile._json.given_name || ''} ${profile._json.family_name || ''}`.trim();
    } else {
      displayName = userEmail.split('@')[0]; // Use email prefix as last resort
    }
    
    console.log('Extracted display name:', displayName);
    
    // Extract additional profile fields from Okta
    let firstName = null;
    let lastName = null;
    let department = null;
    let location = null;
    let employeeNumber = null;
    let costCenter = null;
    
    // Extract first name
    if (profile._json && profile._json.given_name) {
      firstName = profile._json.given_name;
    } else if (profile.name && profile.name.givenName) {
      firstName = profile.name.givenName;
    } else if (profile._json && profile._json.first_name) {
      firstName = profile._json.first_name;
    }
    
    // Extract last name
    if (profile._json && profile._json.family_name) {
      lastName = profile._json.family_name;
    } else if (profile.name && profile.name.familyName) {
      lastName = profile.name.familyName;
    } else if (profile._json && profile._json.last_name) {
      lastName = profile._json.last_name;
    }
    
    // Extract department
    if (profile._json && profile._json.department) {
      department = profile._json.department;
    } else if (profile._json && profile._json.dept) {
      department = profile._json.dept;
    }
    
    // Extract location/office
    if (profile._json && profile._json.location) {
      location = profile._json.location;
    } else if (profile._json && profile._json.office_location) {
      location = profile._json.office_location;
    } else if (profile._json && profile._json.office) {
      location = profile._json.office;
    }
    
    // Extract employee number
    if (profile._json && profile._json.employee_number) {
      employeeNumber = profile._json.employee_number;
    } else if (profile._json && profile._json.employeeNumber) {
      employeeNumber = profile._json.employeeNumber;
    } else if (profile._json && profile._json.emp_id) {
      employeeNumber = profile._json.emp_id;
    }
    
    // Extract cost center
    if (profile._json && profile._json.cost_center) {
      costCenter = profile._json.cost_center;
    } else if (profile._json && profile._json.costCenter) {
      costCenter = profile._json.costCenter;
    } else if (profile._json && profile._json.cost_center_number) {
      costCenter = profile._json.cost_center_number;
    }
    
    console.log('Extracted additional profile data:', {
      firstName,
      lastName, 
      department,
      location,
      employeeNumber,
      costCenter
    });
    
    // Check if this user should be a system admin (Cat 4)
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
    const isSystemAdmin = allAdminEmails.includes(userEmail.toLowerCase());
    
    console.log('System admin emails configured:', allAdminEmails);
    console.log('User email:', userEmail.toLowerCase());
    console.log('Is system admin:', isSystemAdmin);
    
    // Define permissions for each category
    const getPermissionsForCategory = (category) => {
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
    
    // Only assign system admin role automatically - all others remain unassigned until admin assigns them
    // For existing users, the role assignment will be preserved in the database
    // Note: The actual role will be determined by createOrUpdateUser based on database lookup
    const userCategory = isSystemAdmin ? 'cat4' : 'unassigned';
    
    // Map category to database role - only for system admins, everyone else gets NULL (unassigned)
    // For existing users, this will be overridden by the database lookup in createOrUpdateUser
    const dbRole = isSystemAdmin ? 'admin' : null;
    
    // Create user object with category-based permissions for session
    const user = {
      okta_user_id: profile.id,
      email: userEmail,
      full_name: displayName,
      first_name: firstName,
      last_name: lastName,
      department: department,
      location: location,
      employee_number: employeeNumber,
      cost_center_number: costCenter,
      role: dbRole, // Database role (admin, manager, user, viewer, null)
      category: userCategory, // Category for frontend (cat1, cat2, cat3, cat4, unassigned)
      permissions: getPermissionsForCategory(userCategory),
      raw_profile: profile._json // Store full profile for debugging/future use
    };

    console.log('User authenticated:', user.email, 'Category:', user.category, 'Permissions:', user.permissions);
    return done(null, user);
  }));

  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user, done) => {
    done(null, user);
  });
};

// Middleware to ensure user is authenticated
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  
  // For API requests, return JSON error
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ 
      error: 'Authentication required',
      redirectTo: '/auth/okta'
    });
  }
  
  // For web requests, redirect to login
  res.redirect('/auth/okta');
};

// Middleware to check specific permissions
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = req.user;
    
    // Cat4 users (system admins) have access to everything
    if (user.role === 'cat4' || user.category === 'cat4' || user.role === 'admin') {
      return next();
    }

    // Check if user has the specific permission
    const hasPermission = user.permissions && user.permissions.includes(permission);

    console.log('has permission:', hasPermission);

    if (!hasPermission) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: permission,
        userRole: user.role,
        userCategory: user.category,
        userPermissions: user.permissions || []
      });
    }

    next();
  };
};

// Middleware to check role-based access
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = req.user;
    const userRole = user.role;
    const userCategory = user.category;
    const allowedRoles = Array.isArray(roles) ? roles : [roles];

    console.log('user role2:', userRole);

    // Check if user has required role (can be category like 'cat4' or db role like 'admin')
    const hasRole = allowedRoles.some(role => 
      userRole === role || userCategory === role || 
      (role === 'admin' && userCategory === 'cat4') ||
      (role === 'cat4' && userRole === 'admin')
    );

    if (!hasRole) {
      return res.status(403).json({ 
        error: 'Insufficient role privileges',
        required: allowedRoles,
        current: { role: userRole, category: userCategory }
      });
    }

    next();
  };
};

// Generate JWT token for frontend authentication
const generateJWT = (user) => {
  const payload = {
    user_id: user.user_id,
    okta_user_id: user.okta_user_id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    category: user.category || user.role,
    permissions: user.permissions || []
  };

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });
};

// Verify JWT token
const verifyJWT = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
};

// API Authentication middleware for JWT tokens
const apiAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyJWT(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
};

// Helper function to check if user has specific permission
const hasPermission = (user, permission) => {

  console.log("user role2 in has permission:", user.role);

  if (!user) return false;
  
  // Cat4 users (system admins) have access to everything
  if (user.role === 'cat4') return true;

  
  
  // Check if user has the specific permission
  return user.permissions && user.permissions.includes(permission);
};

// Helper function to get user's category permissions
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

module.exports = {
  setupOktaAuth,
  ensureAuthenticated,
  requirePermission,
  requireRole,
  generateJWT,
  verifyJWT,
  apiAuth,
  hasPermission,
  getCategoryPermissions
};