/**
 * Test OPC UA simulator NodeID format
 * Verifies nodes are created with string-based IDs: ns=2;s=Production/Sensor_1
 */

const opcua = require('node-opcua-client');

async function testNodeIdFormat() {
  console.log('Testing OPC UA simulator NodeID format...\n');
  
  const client = opcua.OPCUAClient.create({
    endpoint_must_exist: false,
  });
  
  try {
    // Connect to simulator (assuming it's running on localhost:4841)
    const endpointUrl = 'opc.tcp://localhost:4841';
    console.log(`Connecting to ${endpointUrl}...`);
    
    await client.connect(endpointUrl);
    console.log('✓ Connected\n');
    
    const session = await client.createSession();
    console.log('✓ Session created\n');
    
    // Test 1: Read ServerInfo metadata
    console.log('--- Test 1: Reading ServerInfo metadata ---');
    try {
      const profileName = await session.read({
        nodeId: 'ns=2;s=ServerInfo.ProfileName'
      });
      console.log(`Profile: ${profileName.value.value}`);
      
      const sensorCount = await session.read({
        nodeId: 'ns=2;s=ServerInfo.SensorCount'
      });
      console.log(`Total sensors: ${sensorCount.value.value}`);
    } catch (err) {
      console.error('✗ Failed to read metadata:', err.message);
    }
    
    // Test 2: Try to read sensor nodes with expected string-based NodeIDs
    console.log('\n--- Test 2: Reading sensor nodes ---');
    const testNodeIds = [
      'ns=2;s=Temperature/Sensor1',
      'ns=2;s=Temperature/Sensor2',
      'ns=2;s=Pressure/Sensor1',
      'ns=2;s=Flow/Sensor1',
      'ns=2;s=Level/Tank1'
    ];
    
    for (const nodeId of testNodeIds) {
      try {
        const result = await session.read({
          nodeId: nodeId,
          attributeId: opcua.AttributeIds.Value
        });
        
        if (result.statusCode.value === 0) {
          console.log(`✓ ${nodeId} = ${result.value.value}`);
        } else {
          console.log(`✗ ${nodeId} - Status: ${result.statusCode.description}`);
        }
      } catch (err) {
        console.log(`✗ ${nodeId} - Error: ${err.message}`);
      }
    }
    
    // Test 3: Browse the tree to see actual NodeIDs
    console.log('\n--- Test 3: Browsing node tree ---');
    try {
      const browseResult = await session.browse('ns=2;i=1'); // ObjectsFolder
      console.log(`Found ${browseResult.references.length} objects`);
      
      for (const ref of browseResult.references.slice(0, 5)) {
        console.log(`  - ${ref.browseName.name}: ${ref.nodeId.toString()}`);
      }
    } catch (err) {
      console.error('✗ Failed to browse:', err.message);
    }
    
    await session.close();
    console.log('\n✓ Session closed');
    
  } catch (err) {
    console.error('\n✗ Error:', err.message);
  } finally {
    await client.disconnect();
    console.log('✓ Disconnected');
  }
}

testNodeIdFormat().catch(console.error);
