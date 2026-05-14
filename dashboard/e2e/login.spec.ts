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

  test('should display login page', async ({ page }, testInfo) => {
    await expect(page).toHaveTitle(/Iotistic|Dashboard/i);
    console.log(`Page title: ${await page.title()}`);
    console.log(`Page URL: ${page.url()}`);

    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    await expect(loginButton).toBeVisible({ timeout: 10000 });

    await testInfo.attach('login-page', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('should show validation error for empty credentials', async ({ page }, testInfo) => {
    const loginButton = page.getByRole('button', { name: /login|sign in/i });
    await loginButton.click();

    const errorMessage = page.getByText(/required|invalid|enter/i).first();
    await expect(errorMessage).toBeVisible({ timeout: 5000 });

    console.log(`Validation error text: ${await errorMessage.textContent()}`);
    await testInfo.attach('validation-error', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('should login with valid credentials', async ({ page }, testInfo) => {
    const username = process.env.E2E_AUTH_USERNAME || 'admin';
    const password = process.env.E2E_AUTH_PASSWORD || 'admin';
    console.log(`Logging in as: ${username}`);

    const emailInput = page.getByLabel(/email|username/i);
    const passwordInput = page.getByLabel(/password/i);
    const loginButton = page.getByRole('button', { name: /login|sign in/i });

    await emailInput.fill(username);
    await passwordInput.fill(password);

    await testInfo.attach('form-filled', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    await loginButton.click();
    console.log('Login button clicked, waiting for app shell...');

    // SPA stays at '/' and renders the authenticated shell in-place — no URL change.
    await page.waitForLoadState('networkidle');
    console.log(`URL after login: ${page.url()}`);

    await testInfo.attach('after-submit', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    const searchBox = page.getByPlaceholder('Search agents...');
    await expect(searchBox).toBeVisible({ timeout: 20000 });

    await testInfo.attach('authenticated-shell', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    console.log('Authenticated shell rendered — sidebar search box is visible');
  });

  test('should show error for invalid credentials', async ({ page }, testInfo) => {
    const emailInput = page.getByLabel(/email|username/i);
    const passwordInput = page.getByLabel(/password/i);
    const loginButton = page.getByRole('button', { name: /login|sign in/i });

    await emailInput.fill('wrong@example.com');
    await passwordInput.fill('wrongpassword');
    await loginButton.click();

    const errorMessage = page.getByText(/invalid|incorrect|failed|wrong/i);
    await expect(errorMessage).toBeVisible({ timeout: 5000 });

    console.log(`Error message text: ${await errorMessage.textContent()}`);
    await testInfo.attach('invalid-credentials-error', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('should navigate to forgot password page', async ({ page }, testInfo) => {
    const forgotPasswordLink = page.getByRole('link', { name: /forgot password/i });
    const linkExists = await forgotPasswordLink.count() > 0;

    if (linkExists) {
      await forgotPasswordLink.click();
      await expect(page).toHaveURL(/forgot|reset/i);
      console.log(`Forgot password URL: ${page.url()}`);
      await testInfo.attach('forgot-password-page', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    } else {
      console.log('No forgot-password link found — skipping');
      test.skip();
    }
  });
});


