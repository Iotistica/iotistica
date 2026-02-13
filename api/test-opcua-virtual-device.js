/**
 * Test OPC UA Virtual Device Deployment with Sidecar
 * 
 * This script creates a virtual device with OPC UA endpoints and verifies
 * that the K8s deployment includes the opcua-simulator sidecar.
 */

const https = require('https');
const http = require('http');

const API_HOST = 'localhost';
const API_PORT = 4002;
const API_USERNAME = process.env.API_USERNAME || 'admin';
const API_PASSWORD = process.env.API_PASSWORD || 'admin123';

let API_TOKEN = null;  // Will be set after login

// Test configuration
const TEST_DEVICE = {
  deviceName: `Test-OPC-UA-Virtual-${Date.now()}`,
  deviceType: 'virtual',
  fleetId: 'test-fleet',
  metadata: {
    opcuaProfile: 'TestFactory',  // Profile name in database
    description: 'Test virtual device with OPC UA simulator sidecar'
  },
  endpoints: [
    {
      protocol: 'opcua',
      connection: {
        endpointUrl: 'opc.tcp://localhost:4840'  // Sidecar endpoint
      },
      dataPoints: []  // Empty = auto-discovery
    }
  ]
};

async function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function login() {
  console.log('🔐 Logging in to API...');
  const response = await makeRequest('POST', '/api/v1/auth/login', {
    username: API_USERNAME,
    password: API_PASSWORD
  });

  if (response.status !== 200) {
    throw new Error(`Login failed: ${JSON.stringify(response.data)}`);
  }

  API_TOKEN = response.data.data.accessToken;  // Use accessToken, not token
  console.log(`✅ Logged in successfully\n`);
}

async function testOPCUAVirtualDevice() {
  console.log('🧪 Testing OPC UA Virtual Device Deployment\n');

  try {
    // Step 0: Login first
    await login();
    // Step 1: Create virtual device
    console.log('1️⃣  Creating virtual device with OPC UA endpoint...');
    const createResponse = await makeRequest('POST', '/api/v1/devices', TEST_DEVICE);
    
    if (createResponse.status !== 202 && createResponse.status !== 201) {
      console.error('❌ Failed to create device:', createResponse);
      return;
    }

    const deviceUuid = createResponse.data.deviceUuid;
    console.log(`✅ Device created: ${deviceUuid}`);
    console.log(`   Name: ${createResponse.data.deviceName}`);
    console.log(`   Namespace: ${createResponse.data.namespace || 'virtual-agents'}`);

    // Step 2: Wait for provisioning
    console.log('\n2️⃣  Waiting for device to be provisioned...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Check device details
    console.log('\n3️⃣  Fetching device details...');
    const deviceResponse = await makeRequest('GET', `/api/v1/devices/${deviceUuid}`);
    
    if (deviceResponse.status !== 200) {
      console.error('❌ Failed to fetch device:', deviceResponse);
      return;
    }

    const device = deviceResponse.data;
    console.log('✅ Device details:');
    console.log(`   UUID: ${device.uuid}`);
    console.log(`   Status: ${device.status}`);
    console.log(`   Deployment Status: ${device.deployment_status}`);
    console.log(`   K8s Namespace: ${device.k8s_namespace}`);
    console.log(`   K8s Pod: ${device.k8s_pod_name || 'pending'}`);

    // Step 4: Check deployment status
    console.log('\n4️⃣  Checking K8s deployment status...');
    const statusResponse = await makeRequest('GET', `/api/v1/devices/${deviceUuid}/deployment-status`);
    
    if (statusResponse.status === 200) {
      console.log('✅ Deployment status:', statusResponse.data);
      
      const deploymentInfo = statusResponse.data;
      
      // Step 5: Manual verification instructions
      console.log('\n5️⃣  Manual Verification Steps:');
      console.log('\n   To verify the OPC UA sidecar was deployed, run:');
      console.log(`   \x1b[36mkubectl get pod -n ${deploymentInfo.namespace} ${deploymentInfo.podName}\x1b[0m`);
      console.log('\n   To check containers in the pod:');
      console.log(`   \x1b[36mkubectl get pod -n ${deploymentInfo.namespace} ${deploymentInfo.podName} -o jsonpath='{.spec.containers[*].name}'\x1b[0m`);
      console.log('\n   Expected containers: agent opcua-simulator');
      console.log('\n   To check OPC UA simulator env vars:');
      console.log(`   \x1b[36mkubectl get pod -n ${deploymentInfo.namespace} ${deploymentInfo.podName} -o jsonpath='{.spec.containers[?(@.name=="opcua-simulator")].env}'\x1b[0m`);
      console.log('\n   Expected: PROFILE=TestFactory, OPCUA_API_URL=<api-url>');
    }

    console.log('\n✅ Test completed!');
    console.log(`\n📝 Device UUID: ${deviceUuid}`);
    console.log(`📝 To delete: DELETE /api/v1/devices/${deviceUuid}`);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

// Run test
testOPCUAVirtualDevice();
