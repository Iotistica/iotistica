/**
 * Generate RSA Key Pair for License Signing
 * Run this once during setup: npm run generate-keys
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

async function generateKeys() {
  const keysDir = path.resolve(__dirname, '../../keys');

  // Create keys directory
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
    console.log('✅ Created keys/ directory');
  }

  const privateKeyPath = path.join(keysDir, 'private-key.pem');
  const publicKeyPath = path.join(keysDir, 'public-key.pem');

  // Check if keys already exist
  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    console.log('⚠️  Keys already exist!');
    console.log('   Private key: keys/private-key.pem');
    console.log('   Public key: keys/public-key.pem');
    console.log('');
    console.log('To regenerate, delete the keys/ directory and run this again.');
    return;
  }

  try {
    console.log('🔑 Generating RSA-2048 key pair...');

    // Generate private key
    await execAsync(
      `openssl genrsa -out "${privateKeyPath}" 2048`
    );
    console.log('✅ Private key generated: keys/private-key.pem');

    // Generate public key from private key
    await execAsync(
      `openssl rsa -in "${privateKeyPath}" -pubout -out "${publicKeyPath}"`
    );
    console.log('✅ Public key generated: keys/public-key.pem');

    // Set proper permissions (Unix/Mac only)
    if (process.platform !== 'win32') {
      fs.chmodSync(privateKeyPath, 0o600); // Owner read/write only
      fs.chmodSync(publicKeyPath, 0o644);  // Owner read/write, others read
      console.log('✅ Permissions set (private: 600, public: 644)');
    }

    console.log('');
    console.log('🎉 Key generation complete!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Add to .env:');
    console.log('   LICENSE_PRIVATE_KEY_PATH=./keys/private-key.pem');
    console.log('   LICENSE_PUBLIC_KEY_PATH=./keys/public-key.pem');
    console.log('');
    console.log('2. Distribute PUBLIC key to customer instances');
    console.log('   (They will use it to verify licenses)');
    console.log('');
    console.log('⚠️  NEVER share the private key!');
  } catch (error) {
    console.error('❌ Failed to generate keys:', error);
    console.log('');
    console.log('Make sure OpenSSL is installed:');
    console.log('  Mac: brew install openssl');
    console.log('  Ubuntu: sudo apt install openssl');
    console.log('  Windows: Install Git for Windows (includes OpenSSL)');
    process.exit(1);
  }
}

generateKeys();
