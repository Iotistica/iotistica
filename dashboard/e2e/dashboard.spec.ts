import { test, expect } from '@playwright/test';

/**
 * Helper function to login before running dashboard tests
 */
async function login(page: any) {
  await page.goto('/');
  
  // Check if we're already logged in
  const isLoggedIn = await page.getByRole('button', { name: /logout|profile|user|admin/i }).count() > 0;
  
  if (!isLoggedIn) {
    // Perform login with default admin credentials
    const emailInput = page.getByLabel(/email|username/i);
    const passwordInput = page.getByLabel(/password/i);
    const loginButton = page.getByRole('button', { name: /login|sign in/i });

    await emailInput.fill('admin');
    await passwordInput.fill('admin');
    await loginButton.click();
    
    // Wait for navigation after login
    await page.waitForURL(/dashboard|devices|home/i, { timeout: 10000 });
  }
}

/**
 * Helper function to inject pre-obtained auth tokens into localStorage.
 * Returns true if a real token was injected, false if no token was available.
 */
async function injectAuthTokens(page: any): Promise<boolean> {
  const accessToken = process.env.E2E_AUTH_ACCESS_TOKEN;
  const refreshToken = process.env.E2E_AUTH_REFRESH_TOKEN;
  if (!accessToken) return false;

  // Navigate to the app first to establish the origin, then set localStorage
  await page.goto('/');
  await page.evaluate(
    ({ at, rt }: { at: string; rt: string }) => {
      localStorage.setItem('accessToken', at);
      if (rt) localStorage.setItem('refreshToken', rt);
    },
    { at: accessToken, rt: refreshToken || '' }
  );
  // Reload so AuthContext.initAuth picks up the tokens and verifies them
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return true;
}

/**
 * Integration tests that require a live stack with a registered agent.
 * These use real auth tokens injected via environment variables set by CI.
 */
test.describe('Dashboard Integration Tests', () => {
  test.beforeEach(async ({ page }) => {
    const authed = await injectAuthTokens(page);
    if (!authed) {
      // No real token available – fall back to form login for local dev
      await login(page);
    }
  });

  test('should show an agent in the left sidebar', async ({ page }) => {
    const agentName = process.env.E2E_EXPECTED_AGENT_NAME || '';

    // Agent names are truncated to 15 characters in the sidebar <h3> elements
    const displayName = agentName.length > 15 ? agentName.substring(0, 15) : agentName;

    if (displayName) {
      await expect(
        page.locator('h3').filter({ hasText: displayName }).first()
      ).toBeVisible({ timeout: 20000 });
    } else {
      // No expected name provided – verify the sidebar search input exists at minimum
      await expect(
        page.getByPlaceholder('Search agents...')
      ).toBeVisible({ timeout: 20000 });
    }
  });

  test('should capture the fleets page state', async ({ page }) => {
    await page.goto('/fleets');
    await page.waitForLoadState('networkidle');

    // Fleets page renders fleet cards inside <main>
    await expect(page.locator('main').first()).toBeVisible({ timeout: 15000 });

    // Capture a screenshot for CI diagnostics
    await page.screenshot({ path: 'test-results/fleets-page-state.png', fullPage: true });
  });

  test('should show system metrics for the selected agent', async ({ page }) => {
    // Wait for at least one agent card to appear in the sidebar
    await expect(page.locator('h3').first()).toBeVisible({ timeout: 20000 });

    // Click the first agent card – the app defaults to the metrics (system) view
    await page.locator('h3').first().click();

    // URL transitions to /fleets/:fleetId/agents/:agentId[/system]
    await page.waitForURL(/\/fleets\/.+\/agents\//i, { timeout: 15000 });

    // If the current URL doesn't include the system view segment, navigate there explicitly
    const currentUrl = page.url();
    if (!currentUrl.includes('/system')) {
      await page.goto(currentUrl.replace(/\/$/, '') + '/system');
      await page.waitForLoadState('networkidle');
    }

    // Overview.tsx renders data-testid="system-metrics" when the metrics view is active
    await expect(
      page.locator('[data-testid="system-metrics"]').or(
        page.locator('[data-testid="system-metrics-cards"]')
      ).first()
    ).toBeVisible({ timeout: 20000 });
  });

  test('should add a new MQTT device', async ({ page }) => {
    const agentUuid = process.env.E2E_EXPECTED_AGENT_UUID;
    const accessToken = process.env.E2E_AUTH_ACCESS_TOKEN;
    const apiUrl = process.env.E2E_API_URL || 'http://localhost:4002';

    if (!agentUuid || !accessToken) {
      test.skip();
      return;
    }

    // POST directly to the backend API to create a persistent MQTT endpoint device.
    // Using a fixed name so repeated runs produce a predictable 409 rather than orphaned records.
    const deviceName = 'e2e-mqtt-sensor';
    const response = await page.request.post(
      `${apiUrl}/api/v1/agents/${agentUuid}/devices`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        data: {
          name: deviceName,
          protocol: 'mqtt',
          connection: {
            brokerUrl: 'mqtt://mosquitto:1883',
          },
          discoveryRoots: ['e2e/+/telemetry'],
        },
        failOnStatusCode: false,
      }
    );

    // 201 = created successfully; 409 = already exists from a prior run – both are acceptable
    expect([201, 409]).toContain(response.status());

    if (response.status() === 201) {
      const body = await response.json();
      expect(body.status).toBe('ok');
    }
  });
});

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should display main navigation after login', async ({ page }) => {
    // Check for main navigation items
    const navigation = page.locator('nav, [role="navigation"], aside, .sidebar');
    await expect(navigation.first()).toBeVisible({ timeout: 10000 });
  });

  test('should navigate to devices page', async ({ page }) => {
    // Look for devices link
    const devicesLink = page.getByRole('link', { name: /devices/i }).first();
    
    if (await devicesLink.count() > 0) {
      await devicesLink.click();
      await expect(page).toHaveURL(/devices/i);
      
      // Check for devices heading or content
      const devicesHeading = page.getByRole('heading', { name: /devices/i });
      await expect(devicesHeading).toBeVisible({ timeout: 10000 });
    } else {
      test.skip();
    }
  });

  test('should display device list', async ({ page }) => {
    // Navigate to devices page
    await page.goto('/devices');
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    
    // Check if device table or list is present
    const deviceContent = page.locator('table, [role="table"], .device-list, [data-testid="device-list"]');
    const hasContent = await deviceContent.count() > 0;
    
    if (hasContent) {
      await expect(deviceContent.first()).toBeVisible({ timeout: 10000 });
    } else {
      // If no devices, should show empty state
      const emptyState = page.getByText(/no devices|empty|add device/i);
      await expect(emptyState).toBeVisible({ timeout: 10000 });
    }
  });

  test('should display dashboard sections', async ({ page }) => {
    await page.goto('/');
    
    // Wait for dashboard to load
    await page.waitForLoadState('networkidle');
    
    // Check for common dashboard sections (cards, widgets, etc)
    const dashboardContent = page.locator('[class*="card"], [class*="widget"], [class*="panel"], main');
    await expect(dashboardContent.first()).toBeVisible({ timeout: 10000 });
  });

  test('should allow logout', async ({ page }) => {
    // Find logout button
    const logoutButton = page.getByRole('button', { name: /logout|sign out/i });
    
    if (await logoutButton.count() > 0) {
      await logoutButton.click();
      
      // Should redirect to login page
      await page.waitForURL(/login|^\/$/, { timeout: 5000 });
      
      // Should show login form again
      const loginButton = page.getByRole('button', { name: /login|sign in/i });
      await expect(loginButton).toBeVisible({ timeout: 5000 });
    } else {
      test.skip();
    }
  });
});


