import { test, expect } from '@playwright/test';

test.describe('Dashboard Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display login page', async ({ page }) => {
    await expect(page).toHaveTitle(/Iotistic|Dashboard/i);
    
    // Check for login form elements
    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    await expect(loginButton).toBeVisible({ timeout: 10000 });
  });

  test('should show validation error for empty credentials', async ({ page }) => {
    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    await loginButton.click();
    
    // Should show validation errors
    const errorMessage = page.getByText(/required|invalid|enter/i).first();
    await expect(errorMessage).toBeVisible({ timeout: 5000 });
  });

  test('should login with valid credentials', async ({ page }) => {
    // Fill in login form - use env vars set by CI seeding, fall back to local dev defaults
    const username = process.env.E2E_AUTH_USERNAME || 'admin';
    const password = process.env.E2E_AUTH_PASSWORD || 'admin';

    const emailInput = page.getByLabel(/email|username/i);
    const passwordInput = page.getByLabel(/password/i);
    const loginButton = page.getByRole('button', { name: /login|sign in/i });

    await emailInput.fill(username);
    await passwordInput.fill(password);
    await loginButton.click();

    // SPA stays at '/' and renders the authenticated shell in-place — no URL change.
    // Wait for the sidebar search box which is always present when logged in.
    await page.waitForLoadState('networkidle');
    await expect(page.getByPlaceholder('Search agents...')).toBeVisible({ timeout: 20000 });
  });

  test('should show error for invalid credentials', async ({ page }) => {
    const emailInput = page.getByLabel(/email|username/i);
    const passwordInput = page.getByLabel(/password/i);
    const loginButton = page.getByRole('button', { name: /login|sign in/i });

    await emailInput.fill('wrong@example.com');
    await passwordInput.fill('wrongpassword');
    await loginButton.click();

    // Should show error message
    const errorMessage = page.getByText(/invalid|incorrect|failed|wrong/i);
    await expect(errorMessage).toBeVisible({ timeout: 5000 });
  });

  test('should navigate to forgot password page', async ({ page }) => {
    const forgotPasswordLink = page.getByRole('link', { name: /forgot password/i });
    
    // Only run if forgot password link exists
    const linkExists = await forgotPasswordLink.count() > 0;
    
    if (linkExists) {
      await forgotPasswordLink.click();
      await expect(page).toHaveURL(/forgot|reset/i);
    } else {
      test.skip();
    }
  });
});


