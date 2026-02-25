/**
 * List 1Password Vaults to Get Vault IDs
 * Run with: npx ts-node tests/list-vaults.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClient } from '@1password/sdk';

// Load environment variables from .env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function listVaults() {
  console.log('=====================================');
  console.log('  1Password Vaults List');
  console.log('=====================================\n');

  const token = process.env.ONEPASSWORD_CONNECT_TOKEN;

  if (!token) {
    console.error('❌ Error: ONEPASSWORD_CONNECT_TOKEN not found in .env');
    process.exit(1);
  }

  console.log(`   Token: ${token.substring(0, 20)}...`);
  console.log('');

  try {
    console.log('🔧 Initializing 1Password client...');
    const client = await createClient({
      auth: token,
      integrationName: 'Iotistic Vault Lister',
      integrationVersion: '1.0.0',
    });
    console.log('✅ Client initialized successfully\n');

    console.log('⏳ Fetching vaults...');
    const vaults = await client.vaults.list();
    console.log(`✅ Success! Found ${vaults.length} vault(s)\n`);

    if (vaults.length === 0) {
      console.log('   No vaults found');
      console.log('   Create a vault in your 1Password account first\n');
    } else {
      console.log('📊 Available vaults:\n');
      vaults.forEach((vault, index) => {
        console.log(`   [${index + 1}] ${vault.title}`);
        console.log(`       ID:          ${vault.id}`);
        console.log(`       Description: ${vault.description || '(none)'}`);
        console.log(`       Type:        ${vault.vaultType}`);
        console.log('');
      });
      
      console.log('💡 Update your .env file with the correct vault ID:');
      console.log(`   ONEPASSWORD_VAULT_ID=${vaults[0].id}\n`);
    }

  } catch (error: any) {
    console.error('\n❌ Failed to list vaults:', error.message);
    if (error.stack) {
      console.error('\n   Stack trace:', error.stack);
    }
    console.error('\n💡 Troubleshooting tips:');
    console.error('   1. Verify your service account token is valid');
    console.error('   2. Check that the token has permission to access vaults');
    console.error('   3. Ensure your 1Password account has at least one vault');
    process.exit(1);
  }
}

// Run
listVaults();
