import { expect, Page, TestInfo } from '@playwright/test';

export function getE2EAuth() {
  const userJson = process.env.E2E_AUTH_USER_JSON;

  return {
    username: process.env.E2E_AUTH_USERNAME,
    password: process.env.E2E_AUTH_PASSWORD,
    accessToken: process.env.E2E_AUTH_ACCESS_TOKEN,
    refreshToken: process.env.E2E_AUTH_REFRESH_TOKEN,
    user: userJson ? JSON.parse(userJson) : undefined,
    expectedAgentName: process.env.E2E_EXPECTED_AGENT_NAME,
    expectedAgentUuid: process.env.E2E_EXPECTED_AGENT_UUID,
  };
}

export function requireE2EAuth(testInfo: TestInfo) {
  const { username, password, accessToken, refreshToken, user } = getE2EAuth();

  const hasCredentialLogin = !!username && !!password;
  const hasInjectedSession = !!accessToken && !!refreshToken && !!user;

  if (!hasCredentialLogin && !hasInjectedSession) {
    testInfo.skip(true, 'Set either credential login env vars or injected session env vars for authenticated dashboard tests.');
  }

  return {
    username,
    password,
    accessToken,
    refreshToken,
    user,
  };
}

export async function injectAuthenticatedSession(page: Page, accessToken: string, refreshToken: string, user: unknown) {
  await page.addInitScript(
    ({ initAccessToken, initRefreshToken, initUser }) => {
      localStorage.setItem('accessToken', initAccessToken);
      localStorage.setItem('refreshToken', initRefreshToken);
      localStorage.setItem('user', JSON.stringify(initUser));
    },
    {
      initAccessToken: accessToken,
      initRefreshToken: refreshToken,
      initUser: user,
    }
  );

  await page.goto('/');
  await expect(page.getByTestId('dashboard-app')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('global-nav-home')).toBeVisible();
}

export async function loginWithCredentials(page: Page, username: string, password: string) {
  await page.goto('/');

  if (await page.getByTestId('dashboard-app').isVisible().catch(() => false)) {
    return;
  }

  await expect(page.getByTestId('login-form')).toBeVisible();
  await page.getByTestId('login-email').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('dashboard-app')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('global-nav-home')).toBeVisible();
}

export async function ensureAuthenticatedDashboard(page: Page, testInfo: TestInfo) {
  const auth = requireE2EAuth(testInfo);

  if (auth.accessToken && auth.refreshToken && auth.user) {
    await injectAuthenticatedSession(page, auth.accessToken, auth.refreshToken, auth.user);
    return;
  }

  await loginWithCredentials(page, auth.username!, auth.password!);
}

export async function selectAgentFromSidebar(page: Page, expectedAgentUuid?: string, expectedAgentName?: string) {
  await expect(page.getByTestId('agent-sidebar')).toBeVisible({ timeout: 30000 });

  if (expectedAgentUuid) {
    const agentRow = page.getByTestId(`agent-row-${expectedAgentUuid}`);
    await expect(agentRow).toBeVisible({ timeout: 30000 });
    await agentRow.click();
    return expectedAgentUuid;
  }

  if (expectedAgentName) {
    const rowByName = page.locator('[data-testid^="agent-row-"]', {
      hasText: expectedAgentName,
    }).first();
    await expect(rowByName).toBeVisible({ timeout: 30000 });
    const testId = await rowByName.getAttribute('data-testid');
    await rowByName.click();
    return testId?.replace('agent-row-', '') ?? null;
  }

  const firstAgentRow = page.locator('[data-testid^="agent-row-"]').first();
  await expect(firstAgentRow).toBeVisible({ timeout: 30000 });
  const testId = await firstAgentRow.getAttribute('data-testid');
  await firstAgentRow.click();
  return testId?.replace('agent-row-', '') ?? null;
}