/**
 * Reset Admin Password Script
 * 
 * Resets the admin user password to a new value
 * Usage: node reset-admin-password.js [new-password]
 */

const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const SALT_ROUNDS = 10;
const DEFAULT_PASSWORD = 'admin123';

async function resetAdminPassword() {
  const newPassword = process.argv[2] || DEFAULT_PASSWORD;
  
  console.log('🔐 Resetting admin password...');
  console.log(`   New password: ${newPassword}`);
  console.log('');

  // Database connection
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'iotistic',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres'
  });

  try {
    // Generate password hash
    console.log('⏳ Generating password hash...');
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    console.log('✅ Password hash generated');
    console.log('');

    // Update database
    console.log('⏳ Updating database...');
    const result = await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE username = $2 RETURNING id, username, email, role',
      [passwordHash, 'admin']
    );

    if (result.rowCount === 0) {
      console.error('❌ Error: Admin user not found in database');
      console.log('');
      console.log('Creating admin user...');
      
      // Create admin user if it doesn't exist
      const createResult = await pool.query(
        `INSERT INTO users (username, email, password_hash, role, full_name, is_active, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, username, email, role`,
        ['admin', 'admin@iotistic.com', passwordHash, 'admin', 'Administrator', true, true]
      );
      
      console.log('✅ Admin user created:');
      console.log(createResult.rows[0]);
    } else {
      console.log('✅ Password updated successfully!');
      console.log('');
      console.log('User details:');
      console.log(result.rows[0]);
    }
    
    console.log('');
    console.log('🎉 Done! You can now login with:');
    console.log(`   Username: admin`);
    console.log(`   Password: ${newPassword}`);
    console.log('');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

resetAdminPassword();
