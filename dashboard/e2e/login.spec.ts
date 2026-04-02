import { test, expect } from '@playwright/test';
import { loginWithCredentials, requireE2EAuth } from './helpers/auth';

test.describe('Dashboard Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display login page', async ({ page }) => {
    await expect(page).toHaveTitle(/Iotistic|Dashboard/i);

    await expect(page.getByTestId('login-page')).toBeVisible();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('login-email')).toBeVisible();
    await expect(page.getByTestId('login-password')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });

  test('should show validation error for empty credentials', async ({ page }) => {
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText('Email and password are required');
  });

  test('should login with Auth0-backed credentials', async ({ page }, testInfo) => {
    const { username, password } = requireE2EAuth(testInfo);
    await loginWithCredentials(page, username, password);
    await expect(page.getByTestId('dashboard-app')).toBeVisible();
    await expect(page.getByTestId('global-nav-home')).toBeVisible();
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await page.getByTestId('login-email').fill('wrong@example.com');
    await page.getByTestId('login-password').fill('wrongpassword');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 10000 });
  });
});


