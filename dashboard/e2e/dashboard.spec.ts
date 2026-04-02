import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execSync } from 'child_process';
import { ensureAuthenticatedDashboard, getE2EAuth, selectAgentFromSidebar } from './helpers/auth';
import { createPageDiagnosticsCollector } from './helpers/diagnostics';

const diagnosticsByPage = new WeakMap<object, ReturnType<typeof createPageDiagnosticsCollector>>();

async function attachPageScreenshot(page: Page, testInfo: TestInfo, fileName: string, attachmentName: string) {
  const screenshotPath = testInfo.outputPath(fileName);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(attachmentName, {
    path: screenshotPath,
    contentType: 'image/png',
  });
}

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    diagnosticsByPage.set(page, createPageDiagnosticsCollector(page));
    await ensureAuthenticatedDashboard(page, testInfo);
  });

  test.afterEach(async ({ page }, testInfo) => {
    const diagnostics = diagnosticsByPage.get(page);
    if (diagnostics) {
      await diagnostics.attach(testInfo);
      diagnosticsByPage.delete(page);
    }
  });

  test('should display main navigation after login', async ({ page }) => {
    await expect(page.getByTestId('dashboard-app')).toBeVisible();
    await expect(page.getByTestId('global-nav-home')).toBeVisible();
    await expect(page.getByTestId('global-nav-fleets')).toBeVisible();
    await expect(page.getByTestId('global-nav-dashboard')).toBeVisible();
  });

  test('should show an agent in the left sidebar', async ({ page }, testInfo) => {
    const { expectedAgentName, expectedAgentUuid } = getE2EAuth();
    const selectedAgentUuid = await selectAgentFromSidebar(page, expectedAgentUuid, expectedAgentName);

    if (selectedAgentUuid) {
      await expect(page.getByTestId(`agent-row-selected-${selectedAgentUuid}`)).toBeVisible();
    }

    await expect(page.getByTestId('agent-sidebar')).toBeVisible();
    await attachPageScreenshot(page, testInfo, 'home-sidebar-state.png', 'home-sidebar-state');
  });

  test('should capture the fleets page state', async ({ page }, testInfo) => {
    await page.getByTestId('global-nav-fleets').click();
    await expect(page.getByTestId('fleets-page')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('fleets-page-title')).toContainText('Fleet Management');

    await page.waitForFunction(
      () => {
        return !document.querySelector('[data-testid="fleets-loading-state"]');
      },
      undefined,
      { timeout: 30000 }
    );

    await page.waitForFunction(
      () => {
        return (
          !!document.querySelector('[data-testid="fleets-table"]') ||
          !!document.querySelector('[data-testid="fleets-empty-state"]') ||
          !!document.querySelector('[data-testid="fleets-filtered-empty-state"]')
        );
      },
      undefined,
      { timeout: 30000 }
    );

    await attachPageScreenshot(page, testInfo, 'fleets-page-state.png', 'fleets-page-state');
  });

  test('should show system metrics for the selected agent', async ({ page }, testInfo) => {
    const { expectedAgentName, expectedAgentUuid } = getE2EAuth();
    await selectAgentFromSidebar(page, expectedAgentUuid, expectedAgentName);

    await page.getByTestId('agent-view-metrics').click();
    await expect(page.getByTestId('system-metrics')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('system-metrics-cards')).toBeVisible();
    await expect(page.getByTestId('metric-card-cpu-usage')).toBeVisible();
    await expect(page.getByTestId('metric-card-memory')).toBeVisible();
    await expect(page.getByTestId('metric-card-disk-usage')).toBeVisible();
    await expect(page.getByTestId('metric-card-network')).toBeVisible();
    await expect(page.getByTestId('system-insights-telemetry')).toBeVisible();

    await attachPageScreenshot(page, testInfo, 'agent-overview-metrics-state.png', 'agent-overview-metrics-state');
  });

  test('should navigate to the global dashboard view', async ({ page }) => {
    await page.getByTestId('global-nav-dashboard').click();
    await expect(page.getByTestId('global-dashboard-page')).toBeVisible({ timeout: 30000 });
  });

  test('should add a new MQTT device', async ({ page, request }, testInfo) => {
    // This test includes a 60 s log-poll loop (subscription confirm) + 8 s sim verification,
    // so it needs a longer timeout than the default.
    test.setTimeout(180_000);

    const { expectedAgentName, expectedAgentUuid } = getE2EAuth();
    const E2E_API_URL = process.env.E2E_API_URL || 'http://localhost:4002';

    // Use a timestamp-based name to avoid conflicts between runs
    const deviceName = `e2e_mqtt_${Date.now()}`;

    // Select an agent and navigate to the Devices tab
    const agentUuid = await selectAgentFromSidebar(page, expectedAgentUuid, expectedAgentName);
    await page.getByTestId('agent-view-devices').click();
    await expect(page.getByTestId('devices-tab-trigger')).toBeVisible({ timeout: 15000 });

    // Open the Add Device dialog
    await page.getByTestId('add-device-button').click();
    await expect(page.getByTestId('add-device-dialog')).toBeVisible({ timeout: 10000 });

    // Select MQTT as the protocol
    await page.getByTestId('protocol-select').click();
    await page.getByRole('option', { name: 'MQTT' }).click();

    // Fill in the device name
    await page.getByTestId('mqtt-device-name-input').fill(deviceName);

    // Fill in MQTT credentials
    await page.getByTestId('mqtt-username-input').fill(`${deviceName}_user`);
    await page.getByTestId('mqtt-password-input').fill('E2eSecurePass1!');

    // Select Write permission
    await page.getByTestId('mqtt-permission-select').click();
    await page.getByRole('option', { name: 'Write', exact: true }).click();

    await attachPageScreenshot(page, testInfo, 'add-mqtt-device-before-save.png', 'add-mqtt-device-before-save');

    // Save the device (calls POST validateOnly — validates + adds to pending state)
    await expect(page.getByTestId('save-device-button')).toBeEnabled({ timeout: 5000 });
    await page.getByTestId('save-device-button').click();

    // Dialog should close after a successful save
    await expect(page.getByTestId('add-device-dialog')).not.toBeVisible({ timeout: 10000 });

    // Device should appear in the pending-state grid immediately
    const deviceRow = page.locator('[data-testid^="device-row-"]', { hasText: deviceName });
    await expect(deviceRow).toBeVisible({ timeout: 15000 });

    // Deploy — handleDeploy auto-saves the draft first when there are unsaved changes,
    // then dispatches to the agent in one step.
    await expect(page.getByTestId('deploy-button')).toBeEnabled({ timeout: 10000 });
    await page.getByTestId('deploy-button').click();

    // Wait for the deploy button to become disabled (deployment dispatched, needsDeployment clears)
    await expect(page.getByTestId('deploy-button')).toBeDisabled({ timeout: 30000 });

    await attachPageScreenshot(page, testInfo, 'add-mqtt-device-result.png', 'add-mqtt-device-result');

    // Fetch the newly created device record to capture the MQTT topic the agent will subscribe to.
    // The agent builds the subscription as "<connection.topic>/#", so we reconstruct it here
    // to make the subsequent log assertion deterministic.
    let expectedMqttTopic: string | null = null;
    if (agentUuid) {
      const accessToken = await page.evaluate(() => localStorage.getItem('accessToken'));
      const sensorsResp = await request.get(
        `${E2E_API_URL}/api/v1/agents/${agentUuid}/sensors?protocol=mqtt`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      expect(sensorsResp.ok()).toBeTruthy();
      const sensorsBody = await sensorsResp.json();
      const createdDeviceRecord = (sensorsBody.devices ?? sensorsBody.agents ?? []).find(
        (d: { name: string }) => d.name === deviceName
      ) ?? null;
      if (createdDeviceRecord?.connection?.topic) {
        expectedMqttTopic = `${createdDeviceRecord.connection.topic}/#`;
      }
      console.log(`[e2e] MQTT device "${deviceName}" topic: ${expectedMqttTopic ?? '(not resolved)'}`);
    }

    // Wait for the agent to reconcile and confirm the subscription in its logs.
    // Polls GET /api/v1/agents/:uuid/logs until the "Subscribed to MQTT topic" entry appears
    // for the expected topic, or times out after 60 s.
    if (agentUuid && expectedMqttTopic) {
      const accessToken = await page.evaluate(() => localStorage.getItem('accessToken'));
      const testStartIso = new Date(Date.now() - 5000).toISOString(); // 5 s grace window
      const subscribedPattern = new RegExp(
        `Subscribed to MQTT topic:\\s+${expectedMqttTopic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\(QoS 1\\)`
      );

      let subscriptionConfirmed = false;
      let lastFetchedLogs: Array<{ timestamp: string; level: string; service_name: string; message: string }> = [];
      const pollDeadline = Date.now() + 60_000;

      while (Date.now() < pollDeadline) {
        // In CI the agent runs as a systemd service. Check the journal directly
        // on every iteration to avoid waiting up to 30 s for the cloud log flush.
        if (process.env.CI) {
          try {
            const journal = execSync(
              'sudo journalctl -u iotistica-agent --no-pager --lines 1000 --since "10 minutes ago"',
              { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            if (subscribedPattern.test(journal)) {
              subscriptionConfirmed = true;
              break;
            }
          } catch { /* journalctl unavailable — fall through to cloud API check */ }
        }

        const logsResp = await request.get(
          `${E2E_API_URL}/api/v1/agents/${agentUuid}/logs?limit=200&from=${encodeURIComponent(testStartIso)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (logsResp.ok()) {
          const logsBody = await logsResp.json();
          lastFetchedLogs = logsBody.logs ?? [];
          const matched = lastFetchedLogs.some(
            (entry) => subscribedPattern.test(entry.message)
          );
          if (matched) {
            subscriptionConfirmed = true;
            break;
          }
        }
        await page.waitForTimeout(2000);
      }

      // Always attach the last batch of cloud API logs as a test artifact for debugging
      if (lastFetchedLogs.length > 0) {
        const logText = lastFetchedLogs
          .map(e => `[${e.timestamp}] [${e.level?.toUpperCase() ?? 'INFO'}] [${e.service_name ?? 'agent'}] ${e.message}`)
          .join('\n');
        console.log(`[e2e] Agent logs after deploy (${lastFetchedLogs.length} entries):\n${logText}`);
        await testInfo.attach('agent-logs-after-mqtt-deploy.txt', {
          body: logText,
          contentType: 'text/plain',
        });
      } else {
        console.log('[e2e] No agent logs returned from cloud API for this time window');
      }

      // On CI, also attach the recent journal tail so we can see the raw agent output
      if (!subscriptionConfirmed && process.env.CI) {
        try {
          const journalDump = execSync(
            'sudo journalctl -u iotistica-agent --no-pager --lines 200 --since "10 minutes ago"',
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
          );
          await testInfo.attach('agent-journal-tail.txt', {
            body: journalDump,
            contentType: 'text/plain',
          });
        } catch { /* journalctl unavailable */ }
      }

      expect(subscriptionConfirmed,
        `Timed out waiting for agent log: [INFO] [Adapters] Subscribed to MQTT topic: ${expectedMqttTopic} (QoS 1)`
      ).toBe(true);
    }

    // Cleanup: delete the test device from the API
    if (agentUuid) {
      const accessToken = await page.evaluate(() => localStorage.getItem('accessToken'));
      await request.delete(
        `${E2E_API_URL}/api/v1/agents/${agentUuid}/sensors/${encodeURIComponent(deviceName)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    }
  });
});


