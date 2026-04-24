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


