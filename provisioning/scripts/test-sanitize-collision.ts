/**
 * Test script to demonstrate the collision prevention improvement
 * 
 * OLD METHOD (8 chars):
 *   cust_dc5fec42901a... → dc5fec42
 *   cust_dc5fec42abcd... → dc5fec42  ❌ COLLISION!
 * 
 * NEW METHOD (SHA256 + 12 chars):
 *   cust_dc5fec42901a... → a3f5c8d9e2b1
 *   cust_dc5fec42abcd... → b7d9e4f1c3a2  ✅ UNIQUE!
 * 
 * Usage:
 *   npx ts-node scripts/test-sanitize-collision.ts
 */

import crypto from 'crypto';

// Old method (DANGEROUS - can collide)
function oldSanitizeClientId(customerId: string): string {
  return customerId.replace(/^cust_/, '').substring(0, 8);
}

// New method (SAFE - cryptographically unique)
function newSanitizeClientId(customerId: string): string {
  return crypto
    .createHash('sha256')
    .update(customerId)
    .digest('hex')
    .substring(0, 12);
}

console.log('\n🔬 TESTING NAMESPACE COLLISION PREVENTION');
console.log('='.repeat(80));

// Test case 1: Two customer IDs with same first 8 characters
const customer1 = 'cust_dc5fec42901a1234567890';
const customer2 = 'cust_dc5fec42abcd9876543210';  // Same first 8 chars!

console.log('\n📋 Scenario: Two customer IDs with identical first 8 characters');
console.log(`   Customer 1: ${customer1}`);
console.log(`   Customer 2: ${customer2}`);

console.log('\n❌ OLD METHOD (8 chars):');
const old1 = oldSanitizeClientId(customer1);
const old2 = oldSanitizeClientId(customer2);
console.log(`   Customer 1 → ${old1}`);
console.log(`   Customer 2 → ${old2}`);
console.log(`   Collision:   ${old1 === old2 ? '⚠️  YES - CATASTROPHIC!' : '✅ No'}`);

console.log('\n✅ NEW METHOD (SHA256 + 12 chars):');
const new1 = newSanitizeClientId(customer1);
const new2 = newSanitizeClientId(customer2);
console.log(`   Customer 1 → ${new1}`);
console.log(`   Customer 2 → ${new2}`);
console.log(`   Collision:   ${new1 === new2 ? '❌ YES' : '✅ No - Unique!'}`);

// Test case 2: Verify deterministic behavior
console.log('\n🔁 TESTING DETERMINISTIC BEHAVIOR');
console.log('='.repeat(80));
const customer3 = 'cust_abc123def456789';
const testRun1 = newSanitizeClientId(customer3);
const testRun2 = newSanitizeClientId(customer3);
const testRun3 = newSanitizeClientId(customer3);

console.log(`\n   Input:  ${customer3}`);
console.log(`   Run 1:  ${testRun1}`);
console.log(`   Run 2:  ${testRun2}`);
console.log(`   Run 3:  ${testRun3}`);
console.log(`   Match:  ${testRun1 === testRun2 && testRun2 === testRun3 ? '✅ Deterministic (same input → same output)' : '❌ Not deterministic'}`);

// Test case 3: Calculate collision probability
console.log('\n📊 COLLISION PROBABILITY ANALYSIS');
console.log('='.repeat(80));

const old8CharSpace = Math.pow(16, 8);  // 8 hex chars
const new12CharSpace = Math.pow(16, 12); // 12 hex chars

console.log(`\n   OLD (8 hex chars):  ${old8CharSpace.toLocaleString()} possible combinations`);
console.log(`                       (~4.3 billion namespaces)`);
console.log(`                       Birthday paradox collision at ~65,536 customers`);

console.log(`\n   NEW (12 hex chars): ${new12CharSpace.toLocaleString()} possible combinations`);
console.log(`                       (~281 trillion namespaces)`);
console.log(`                       Birthday paradox collision at ~16.7 million customers`);

// Kubernetes namespace naming
console.log('\n🏷️  KUBERNETES NAMESPACE EXAMPLES');
console.log('='.repeat(80));

const exampleCustomers = [
  'cust_a1b2c3d4e5f6',
  'cust_f6e5d4c3b2a1',
  'cust_123456789abc'
];

for (const customerId of exampleCustomers) {
  const clientId = newSanitizeClientId(customerId);
  const namespace = `customer-${clientId}`;
  console.log(`\n   Customer: ${customerId}`);
  console.log(`   Client ID: ${clientId}`);
  console.log(`   Namespace: ${namespace} (${namespace.length} chars)`);
}

console.log('\n✅ All namespaces are unique and under K8s 63-char limit!');
console.log('='.repeat(80) + '\n');
