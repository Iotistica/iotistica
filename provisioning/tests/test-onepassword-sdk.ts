/**
 * Test 1Password SDK Integration
 * Run with: npx ts-node tests/test-onepassword-sdk.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { OnePasswordService } from '../src/services/onepassword-service';

// Load environment variables from .env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function testOnePasswordSDK() {
  console.log('=====================================');
  console.log('  1Password SDK Test');
  console.log('=====================================\n');

  const token = process.env.ONEPASSWORD_CONNECT_TOKEN;
  const vaultId = process.env.ONEPASSWORD_VAULT_ID;

  if (!token) {
    console.error('❌ Error: ONEPASSWORD_CONNECT_TOKEN not found in .env');
    process.exit(1);
  }

  if (!vaultId) {
    console.error('❌ Error: ONEPASSWORD_VAULT_ID not found in .env');
    process.exit(1);
  }

  console.log('📋 Configuration:');
  console.log(`   Vault ID: ${vaultId}`);
  console.log(`   Token:    ${token.substring(0, 20)}...`);
  console.log('');

  try {
    // Initialize service
    console.log('🔧 Initializing 1Password service...');
    const service = new OnePasswordService();
    console.log('✅ Service initialized successfully\n');

    // Test 1: List items
    console.log('=====================================');
    console.log('Test 1: List Items in Vault');
    console.log('=====================================\n');
    
    console.log('⏳ Fetching items from vault...');
    const items = await service.listItems();
    console.log(`✅ Success! Found ${items.length} item(s)\n`);

    if (items.length > 0) {
      console.log('📊 Items in vault:');
      items.forEach((item, index) => {
        console.log(`\n   [${index + 1}] ${item.title}`);
        console.log(`       ID:       ${item.id}`);
        console.log(`       Category: ${item.category}`);
        if (item.tags && item.tags.length > 0) {
          console.log(`       Tags:     ${item.tags.join(', ')}`);
        }
      });
      console.log('');
    } else {
      console.log('   No items found in vault (this is normal for a new vault)\n');
    }

    // Test 2: Create test secret (optional)
    console.log('=====================================');
    console.log('Test 2: Create Test Secret');
    console.log('=====================================\n');

    const testNamespace = 'test-' + Date.now();
    const testCredentials = {
      host: 'test-db.example.com',
      port: 5432,
      username: 'testuser',
      password: 'testpassword123',
      database: 'testdb',
    };

    console.log(`⏳ Creating test secret: sql-credentials-${testNamespace}`);
    const itemId = await service.createSecretItem(testNamespace, testCredentials);
    console.log(`✅ Secret created successfully!`);
    console.log(`   Item ID: ${itemId}\n`);

    // Test 3: Get the item back
    console.log('=====================================');
    console.log('Test 3: Retrieve Created Secret');
    console.log('=====================================\n');

    console.log(`⏳ Fetching item ${itemId}...`);
    const retrievedItem = await service.getItem(itemId);
    console.log(`✅ Item retrieved successfully!`);
    console.log(`   Title:    ${retrievedItem.title}`);
    console.log(`   Category: ${retrievedItem.category}\n`);

    // Test 4: Delete test secret
    console.log('=====================================');
    console.log('Test 4: Delete Test Secret');
    console.log('=====================================\n');

    console.log(`⏳ Deleting item ${itemId}...`);
    await service.deleteItem(itemId);
    console.log(`✅ Item deleted successfully!\n`);

    console.log('=====================================');
    console.log('✅ All tests completed successfully!');
    console.log('=====================================\n');

    console.log('💡 Your 1Password SDK integration is working!');
    console.log('   The provisioning service is ready to manage secrets.\n');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.originalError) {
      console.error('   Original error:', error.originalError);
    }
    console.error('\n💡 Troubleshooting tips:');
    console.error('   1. Verify your service account token is valid');
    console.error('   2. Check that the vault ID exists and is accessible');
    console.error('   3. Ensure the token has permissions to read/write to the vault');
    process.exit(1);
  }
}

// Run tests
testOnePasswordSDK();
