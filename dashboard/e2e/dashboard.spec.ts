import { test, expect } from '@playwright/test';
import { ensureAuthenticatedDashboard, getE2EAuth, selectAgentFromSidebar } from './helpers/auth';

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await ensureAuthenticatedDashboard(page, testInfo);
  });

  test('should display main navigation after login', async ({ page }) => {
    await expect(page.getByTestId('dashboard-app')).toBeVisible();
    await expect(page.getByTestId('global-nav-home')).toBeVisible();
    await expect(page.getByTestId('global-nav-fleets')).toBeVisible();
    await expect(page.getByTestId('global-nav-dashboard')).toBeVisible();
  });

  test('should show an agent in the left sidebar', async ({ page }) => {
    const { expectedAgentName, expectedAgentUuid } = getE2EAuth();
    const selectedAgentUuid = await selectAgentFromSidebar(page, expectedAgentUuid, expectedAgentName);

    if (selectedAgentUuid) {
      await expect(page.getByTestId(`agent-row-selected-${selectedAgentUuid}`)).toBeVisible();
    }
  });

  test('should show system metrics for the selected agent', async ({ page }) => {
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
  });

  test('should navigate to the global dashboard view', async ({ page }) => {
    await page.getByTestId('global-nav-dashboard').click();
    await expect(page.getByTestId('global-dashboard-page')).toBeVisible({ timeout: 30000 });
  });
});


