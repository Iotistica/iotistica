/**
 * Test Argo CD Connection and Status
 * Run with: npx ts-node tests/test-argocd-connection.ts
 * 
 * Tests:
 * 1. Connection to Argo CD API
 * 2. Authentication with token
 * 3. List all applications
 * 4. Get specific application status
 * 5. Check application health and sync status
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import axios, { AxiosInstance } from 'axios';
import https from 'https';

// Load environment variables from .env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

interface ArgoApplication {
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp?: string;
  };
  spec: {
    destination: {
      namespace: string;
      server: string;
    };
    source: {
      repoURL: string;
      path: string;
    };
  };
  status: {
    sync: {
      status: 'Synced' | 'OutOfSync' | 'Unknown';
      revision?: string;
    };
    health: {
      status: 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown';
      message?: string;
    };
    operationState?: {
      phase: 'Running' | 'Succeeded' | 'Failed' | 'Error' | 'Terminating';
      message?: string;
      finishedAt?: string;
    };
  };
}

async function testArgoCDConnection() {
  console.log('================================================================================');
  console.log('  Argo CD Connection Test');
  console.log('================================================================================\n');

  // Read configuration from .env
  const baseUrl = process.env.ARGOCD_BASE_URL;
  const token = process.env.ARGOCD_TOKEN;
  const skipCheck = process.env.SKIP_ARGOCD_STATUS_CHECK === 'true';

  if (!baseUrl) {
    console.error('❌ Error: ARGOCD_BASE_URL not found in .env');
    process.exit(1);
  }

  if (!token) {
    console.error('❌ Error: ARGOCD_TOKEN not found in .env');
    process.exit(1);
  }

  if (skipCheck) {
    console.log('⚠️  Warning: SKIP_ARGOCD_STATUS_CHECK is true - but testing anyway\n');
  }

  console.log('📋 Configuration:');
  console.log(`   Base URL: ${baseUrl}`);
  console.log(`   Token:    ${token.substring(0, 20)}...${token.substring(token.length - 10)}`);
  console.log(`   Node ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log('');

  // Create Axios client (same config as ArgoStatusService)
  const client: AxiosInstance = axios.create({
    baseURL: baseUrl.replace(/\/$/, ''),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // Allow self-signed certificates for dev/test environments
    httpsAgent: process.env.NODE_ENV === 'production' 
      ? undefined 
      : new https.Agent({ rejectUnauthorized: false }),
  });

  try {
    // Test 1: Basic Connection Test
    console.log('================================================================================');
    console.log('Test 1: Basic Connection & Authentication');
    console.log('================================================================================\n');
    
    console.log('⏳ Testing connection to Argo CD API...');
    const versionResponse = await client.get('/api/version');
    console.log('✅ Connection successful!\n');
    
    console.log('📊 Argo CD Version Info:');
    console.log(`   Version:     ${versionResponse.data.Version || 'N/A'}`);
    console.log(`   Build Date:  ${versionResponse.data.BuildDate || 'N/A'}`);
    console.log(`   Git Commit:  ${versionResponse.data.GitCommit?.substring(0, 8) || 'N/A'}`);
    console.log('');

    // Test 2: List Applications
    console.log('================================================================================');
    console.log('Test 2: List All Applications');
    console.log('================================================================================\n');
    
    console.log('⏳ Fetching applications from Argo CD...');
    const appsResponse = await client.get<{ items: ArgoApplication[] }>('/api/v1/applications');
    const applications = appsResponse.data.items || [];
    console.log(`✅ Found ${applications.length} application(s)\n`);
    
    if (applications.length === 0) {
      console.log('ℹ️  No applications deployed yet');
    } else {
      console.log('📋 Applications List:');
      applications.forEach((app, index) => {
        const syncIcon = app.status.sync.status === 'Synced' ? '✅' : '⚠️';
        const healthIcon = app.status.health.status === 'Healthy' ? '💚' : 
                          app.status.health.status === 'Progressing' ? '🔄' : '❌';
        
        console.log(`\n   ${index + 1}. ${app.metadata.name}`);
        console.log(`      Namespace:  ${app.spec.destination.namespace}`);
        console.log(`      Sync:       ${syncIcon} ${app.status.sync.status}`);
        console.log(`      Health:     ${healthIcon} ${app.status.health.status}`);
        if (app.status.health.message) {
          console.log(`      Message:    ${app.status.health.message}`);
        }
        if (app.status.operationState) {
          console.log(`      Operation:  ${app.status.operationState.phase}`);
        }
      });
    }
    console.log('');

    // Test 3: Get Specific Application (if exists)
    if (applications.length > 0) {
      console.log('================================================================================');
      console.log('Test 3: Get Specific Application Details');
      console.log('================================================================================\n');
      
      const firstApp = applications[0];
      const appName = firstApp.metadata.name;
      
      console.log(`⏳ Fetching details for: ${appName}...`);
      const appResponse = await client.get<ArgoApplication>(`/api/v1/applications/${appName}`);
      const app = appResponse.data;
      console.log('✅ Application details retrieved\n');
      
      console.log('📊 Detailed Information:');
      console.log(`   Name:           ${app.metadata.name}`);
      console.log(`   Namespace:      ${app.metadata.namespace}`);
      console.log(`   Target NS:      ${app.spec.destination.namespace}`);
      console.log(`   Server:         ${app.spec.destination.server}`);
      console.log(`   Repo URL:       ${app.spec.source.repoURL}`);
      console.log(`   Path:           ${app.spec.source.path}`);
      console.log(`   Sync Status:    ${app.status.sync.status}`);
      console.log(`   Health Status:  ${app.status.health.status}`);
      
      if (app.status.sync.revision) {
        console.log(`   Revision:       ${app.status.sync.revision.substring(0, 8)}`);
      }
      
      if (app.status.operationState) {
        console.log(`   Operation:      ${app.status.operationState.phase}`);
        if (app.status.operationState.message) {
          console.log(`   Msg:            ${app.status.operationState.message}`);
        }
      }
      console.log('');
      
      // Check if ready
      const isSynced = app.status.sync.status === 'Synced';
      const isHealthy = app.status.health.status === 'Healthy';
      const isReady = isSynced && isHealthy;
      
      console.log('🎯 Readiness Check:');
      console.log(`   Synced:   ${isSynced ? '✅ Yes' : '❌ No'}`);
      console.log(`   Healthy:  ${isHealthy ? '✅ Yes' : '❌ No'}`);
      console.log(`   Ready:    ${isReady ? '✅ Yes' : '❌ No'}`);
      console.log('');
    }

    // Test 4: Test with a specific client ID (if provided)
    const testClientId = process.argv[2]; // Pass client ID as argument
    if (testClientId) {
      console.log('================================================================================');
      console.log('Test 4: Test Specific Client Application');
      console.log('================================================================================\n');
      
      const appName = `client-${testClientId}`;
      console.log(`⏳ Looking for application: ${appName}...`);
      
      try {
        const appResponse = await client.get<ArgoApplication>(`/api/v1/applications/${appName}`);
        const app = appResponse.data;
        console.log('✅ Application found!\n');
        
        console.log('📊 Application Status:');
        console.log(`   Name:         ${app.metadata.name}`);
        console.log(`   Namespace:    ${app.spec.destination.namespace}`);
        console.log(`   Sync:         ${app.status.sync.status}`);
        console.log(`   Health:       ${app.status.health.status}`);
        
        const isSynced = app.status.sync.status === 'Synced';
        const isHealthy = app.status.health.status === 'Healthy';
        const isReady = isSynced && isHealthy;
        
        console.log(`   Ready:        ${isReady ? '✅ Yes' : '❌ No (Synced: ${isSynced}, Healthy: ${isHealthy})'}`);
        console.log('');
      } catch (error: any) {
        if (error.response?.status === 404) {
          console.log('❌ Application not found in Argo CD');
          console.log(`   Expected name: ${appName}`);
          console.log('   This is normal if the application has not been deployed yet');
        } else {
          throw error;
        }
        console.log('');
      }
    }

    // Success summary
    console.log('================================================================================');
    console.log('✅ ALL TESTS PASSED');
    console.log('================================================================================\n');
    console.log('Connection Test Results:');
    console.log('  ✅ Argo CD API is accessible');
    console.log('  ✅ Authentication token is valid');
    console.log('  ✅ HTTPS agent configured correctly');
    console.log(`  ✅ Found ${applications.length} deployed application(s)`);
    console.log('');
    console.log('Usage Tips:');
    console.log('  • Test specific client: npx ts-node tests/test-argocd-connection.ts <client-id>');
    console.log('  • Example: npx ts-node tests/test-argocd-connection.ts a9c0fb7554e2');
    console.log('');

  } catch (error: any) {
    console.log('\n');
    console.log('================================================================================');
    console.log('❌ TEST FAILED');
    console.log('================================================================================\n');
    
    if (error.code === 'ENOTFOUND') {
      console.error('❌ Connection Error: DNS resolution failed');
      console.error(`   Cannot resolve hostname: ${baseUrl}`);
      console.error('   Check your ARGOCD_BASE_URL in .env');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('❌ Connection Error: Connection refused');
      console.error(`   Cannot connect to: ${baseUrl}`);
      console.error('   Is Argo CD running and accessible?');
    } else if (error.response?.status === 401) {
      console.error('❌ Authentication Error: Invalid token');
      console.error('   Your ARGOCD_TOKEN may be expired or invalid');
      console.error('   Generate a new token from Argo CD UI:');
      console.error('   Settings → Accounts → Generate New Token');
    } else if (error.response?.status === 403) {
      console.error('❌ Authorization Error: Insufficient permissions');
      console.error('   Your token does not have permission to access this resource');
    } else {
      console.error('❌ Unexpected Error:');
      console.error(`   Message: ${error.message}`);
      if (error.response) {
        console.error(`   Status:  ${error.response.status}`);
        console.error(`   Data:    ${JSON.stringify(error.response.data, null, 2)}`);
      }
      if (error.stack) {
        console.error('\n📋 Stack Trace:');
        console.error(error.stack);
      }
    }
    
    console.log('');
    process.exit(1);
  }
}

// Run the test
testArgoCDConnection().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
