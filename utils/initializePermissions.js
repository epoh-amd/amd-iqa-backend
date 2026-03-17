/**
 * Initialize Category-Based Permissions in Database
 * 
 * This script sets up the permissions system to work with our Cat1-Cat4 categories
 * while maintaining compatibility with the existing database schema
 */

const { executeQueryCallback } = require('./database');

/**
 * Initialize the permissions system
 */
async function initializePermissions(db) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log('🔄 Initializing category-based permissions...');

      // Define the 8 permissions matching the actual sidebar functionality
      const permissions = [
        { name: 'dashboard', resource: 'dashboard', description: 'Dashboard access' },
        { name: 'search', resource: 'search', description: 'Search records access' },
        { name: 'clf', resource: 'clf', description: 'Customer escalation (CLF) access' },
        { name: 'start_build', resource: 'builds', description: 'Start build process' },
        { name: 'continue_build', resource: 'builds', description: 'Continue build process' },
        { name: 'allocation', resource: 'builds', description: 'Build allocation/master build access' },
        { name: 'customer_portal', resource: 'customer', description: 'Customer portal access' },
        { name: 'user_management', resource: 'admin', description: 'User management access' }
      ];

      // First, check if permissions already exist
      for (const perm of permissions) {
        const existing = await executeQuery(db, 
          'SELECT permission_id FROM permissions WHERE permission_name = ?', 
          [perm.name]
        );

        if (existing.length === 0) {
          // Insert the permission
          await executeQuery(db,
            `INSERT INTO permissions (permission_name, resource_type, access_level, description, is_system_permission)
             VALUES (?, ?, 'full', ?, 1)`,
            [perm.name, perm.resource, perm.description]
          );
          console.log(`✅ Created permission: ${perm.name}`);
        } else {
          console.log(`⏭️  Permission already exists: ${perm.name}`);
        }
      }

      // Set up role-based permissions for our categories
      // Note: We map categories to the existing role system in the database
      const rolePermissions = [
        // Cat1 (viewer) - Dashboard, Search, CLF
        { role: 'viewer', permissions: ['dashboard', 'search', 'clf'] },
        // Cat2 (user) - Search, CLF, Start Build, Continue
        { role: 'user', permissions: ['search', 'clf', 'start_build', 'continue_build'] },
        // Cat3 (manager) - Dashboard, Search, CLF, Start Build, Continue, Allocation
        { role: 'manager', permissions: ['dashboard', 'search', 'clf', 'start_build', 'continue_build', 'allocation'] },
        // Cat4 (admin) - Everything including User Management
        { role: 'admin', permissions: ['dashboard', 'search', 'clf', 'start_build', 'continue_build', 'allocation', 'user_management'] },
        // Customer - Only Customer Portal
        { role: 'customer', permissions: ['customer_portal'] }
      ];

      for (const rolePerm of rolePermissions) {
        for (const permName of rolePerm.permissions) {
          // Get permission ID
          const permResult = await executeQuery(db,
            'SELECT permission_id FROM permissions WHERE permission_name = ?',
            [permName]
          );

          if (permResult.length > 0) {
            const permissionId = permResult[0].permission_id;

            // Check if role permission already exists
            const existing = await executeQuery(db,
              'SELECT role_permission_id FROM role_permissions WHERE role = ? AND permission_id = ?',
              [rolePerm.role, permissionId]
            );

            if (existing.length === 0) {
              // Insert role permission
              await executeQuery(db,
                'INSERT INTO role_permissions (role, permission_id) VALUES (?, ?)',
                [rolePerm.role, permissionId]
              );
              console.log(`✅ Assigned ${permName} to role ${rolePerm.role}`);
            } else {
              console.log(`⏭️  Role permission already exists: ${rolePerm.role} -> ${permName}`);
            }
          }
        }
      }

      console.log('✅ Permission initialization completed successfully!');
      resolve();

    } catch (error) {
      console.error('❌ Error initializing permissions:', error);
      reject(error);
    }
  });
}

/**
 * Helper function to execute database queries
 */
function executeQuery(db, query, params = []) {
  return new Promise((resolve, reject) => {
    executeQueryCallback(db, query, params, (err, results) => {
      if (err) {
        reject(err);
      } else {
        resolve(results);
      }
    });
  });
}

module.exports = { initializePermissions };
