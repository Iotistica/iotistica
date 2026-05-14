import { test, expect } from '@playwright/test';

test.describe('Dashboard Login', () => {
  // Collect browser console errors for diagnostics
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[browser error] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      console.log(`[page error] ${err.message}`);
    });
    await page.goto('/');
  });

  test('should display login page', async ({ page }) => {
    await expect(page).toHaveTitle(/Iotistic|Dashboard/i);
    console.log(`Page title: ${await page.title()}`);
    console.log(`Page URL: ${page.url()}`);

    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    await expect(loginButton).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: 'test-results/login-page.png', fullPage: true });
    console.log('Screenshot saved: test-results/login-page.png');
  });

  test('should show validation error for empty credentials', async ({ page }) => {
    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    await loginButton.click();

    const errorMessage = page.getByText(/required|invalid|enter/i).first();
    await expect(errorMessage).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'test-results/login-validation-error.png', fullPage: true });
    console.log(`Validation error text: ${await errorMessage.textContent()}`);
  });

  test('should login with valid credentials', async ({ page }) => {
    const username = process.env.E2E_AUTH_USERNAME || 'admin';
    const password = process.env.E2E_AUTH_PASSWORD || 'admin';
    console.log(`Logging in as: ${username}`);

    const emailInput = page.getByLabel(/email|username/i);
    const passwordInput = page.getByLabel(/password/i);
    const loginButton = page.getByRole('button', { name: /login|sign in/i });

    await emailInput.fill(username);
    await passwordInput.fill(password);

    await page.screenshot({ path: 'test-results/login-form-filled.png', fullPage: true });

    await loginButton.click();
    console.log('Login button clicked, waiting for app shell...');

    // SPA stays at '/' and renders the authenticated shell in-place — no URL change.
    await page.waitForLoadState('networkidle');

    await page.screenshot({ path: 'test-results/login-after-submit.png', fullPage: true });
    console.log(`URL after login: ${page.url()}`);

    const searchBox = page.getByPlaceholder('Search agents...');
    await expect(searchBox).toBeVisible({ timeout: 20000 });

    await page.screenshot({ path: 'test-results/login-authenticated-shell.png', fullPage: true });
    console.log('Authenticated shell rendered — sidebar search box is visible');
  });

  test('should show error for invalid credentials', async ({ page }) => {
    const emailInput = page.getByLabel(/email|username/i);
    const passwordInput = page.getByLabel(/password/i);
    const loginButton = page.getByRole('button', { name: /login|sign in/i });

    await emailInput.fill('wrong@example.com');
    await passwordInput.fill('wrongpassword');
    await loginButton.click();

    const errorMessage = page.getByText(/invalid|incorrect|failed|wrong/i);
    await expect(errorMessage).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'test-results/login-invalid-credentials.png', fullPage: true });
    console.log(`Error message text: ${await errorMessage.textContent()}`);
  });

  test('should navigate to forgot password page', async ({ page }) => {
    const forgotPasswordLink = page.getByRole('link', { name: /forgot password/i });
    const linkExists = await forgotPasswordLink.count() > 0;

    if (linkExists) {
      await forgotPasswordLink.click();
      await expect(page).toHaveURL(/forgot|reset/i);
      await page.screenshot({ path: 'test-results/login-forgot-password.png', fullPage: true });
      console.log(`Forgot password URL: ${page.url()}`);
    } else {
      console.log('No forgot-password link found — skipping');
      test.skip();
    }
  });
});


