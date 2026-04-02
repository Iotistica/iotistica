import { test, expect, type Page, type TestInfo } from '@playwright/test';
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
});


