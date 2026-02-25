/**
 * Simple Read-Only Test for 1Password SDK
 * Run with: npx ts-node tests/test-read-only.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { OnePasswordService } from '../src/services/onepassword-service';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function testReadOnly() {
  console.log('=====================================');
  console.log('  1Password Read-Only Test');
  console.log('=====================================\n');

  try {
    // Initialize service
    console.log('🔧 Initializing 1Password service...');
    const service = new OnePasswordService();
    console.log('✅ Service initialized\n');

    // Test 1: List items
    console.log('⏳ Listing items in vault...');
    const items = await service.listItems();
    console.log(`✅ Success! Found ${items.length} items\n`);

    // Show first 5 items
    console.log('📊 Sample items (first 5):\n');
    items.slice(0, 5).forEach((item, index) => {
      console.log(`   [${index + 1}] ${item.title}`);
      console.log(`       ID:       ${item.id}`);
      console.log(`       Category: ${item.category}`);
      if (item.tags && item.tags.length > 0) {
        console.log(`       Tags:     ${item.tags.join(', ')}`);
      }
      console.log('');
    });

    if (items.length > 5) {
      console.log(`   ... and ${items.length - 5} more items\n`);
    }

    console.log('=====================================');
    console.log('✅ 1Password SDK is working!');
    console.log('=====================================\n');
    console.log('💡 Your service can read from 1Password.');
    console.log('   To enable write operations, grant "Create and edit items"');
    console.log('   permission to your service account in 1Password settings.\n');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.originalError) {
      console.error('   Original error:', error.originalError.message);
    }
    process.exit(1);
  }
}

// Run
testReadOnly();
