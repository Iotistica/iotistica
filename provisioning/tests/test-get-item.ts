/**
 * Test reading full item details
 * Run with: npx ts-node tests/test-get-item.ts <item-id>
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { OnePasswordService } from '../src/services/onepassword-service';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function testGetItem() {
  const itemId = process.argv[2];
  
  if (!itemId) {
    console.error('Usage: npx ts-node tests/test-get-item.ts <item-id>');
    console.error('\nRun "npx ts-node tests/test-read-only.ts" to see available item IDs');
    process.exit(1);
  }

  console.log('=====================================');
  console.log('  Get Item Details Test');
  console.log('=====================================\n');

  try {
    const service = new OnePasswordService();
    
    console.log(`⏳ Fetching item: ${itemId}...`);
    const item = await service.getItem(itemId);
    
    console.log('✅ Success!\n');
    console.log(`   Title:    ${item.title}`);
    console.log(`   ID:       ${item.id}`);
    console.log(`   Category: ${item.category}`);
    console.log(`   Vault ID: ${item.vaultId}`);
    
    if (item.tags && item.tags.length > 0) {
      console.log(`   Tags:     ${item.tags.join(', ')}`);
    }
    
    if (item.fields && item.fields.length > 0) {
      console.log(`\n   Fields (${item.fields.length}):`);
      item.fields.forEach(field => {
        const value = field.fieldType === 'Concealed' 
          ? '********' 
          : field.value.substring(0, 50) + (field.value.length > 50 ? '...' : '');
        console.log(`     - ${field.title}: ${value}`);
      });
    }
    
    console.log('\n✅ Can retrieve full item details with field values!\n');

  } catch (error: any) {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  }
}

testGetItem();
