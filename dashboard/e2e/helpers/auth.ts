import { expect, Page, TestInfo } from '@playwright/test';

const DASHBOARD_STATE_KEYS_TO_CLEAR = [
  'selectedFleetId',
  'selectedDeviceId',
  'lastViewedAgent',
  'deviceSidebar.searchQuery',
  'deviceSidebar.statusFilters',
  'deviceSidebar.typeFilters',
];

const E2E_API_URL = process.env.E2E_API_URL || 'http://localhost:4002';

async function primeDashboardState(page: Page, session?: { accessToken?: string; refreshToken?: string; user?: unknown }) {
  await page.addInitScript(
    ({ keysToClear, initAccessToken, initRefreshToken, initUser }) => {
      keysToClear.forEach((key) => localStorage.removeItem(key));
      localStorage.setItem('dashboard-kiosk-mode', 'false');
      localStorage.setItem('currentView', 'home');

      if (initAccessToken) {
        localStorage.setItem('accessToken', initAccessToken);
      }

      if (initRefreshToken) {
        localStorage.setItem('refreshToken', initRefreshToken);
      }

      if (initUser) {
        localStorage.setItem('user', JSON.stringify(initUser));
      }
    },
    {
      keysToClear: DASHBOARD_STATE_KEYS_TO_CLEAR,
      initAccessToken: session?.accessToken,
      initRefreshToken: session?.refreshToken,
      initUser: session?.user,
    }
  );
}

async function openAgentHome(page: Page) {
  await expect(page.getByTestId('dashboard-app')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('global-nav-home')).toBeVisible();

  await page.waitForFunction(
    () => !document.querySelector('[data-testid="devices-loading"]'),
    undefined,
    { timeout: 30000 }
  );

  await page.getByTestId('global-nav-home').click();

  await page.waitForFunction(
    () => {
      return (
        !!document.querySelector('[data-testid="agent-sidebar"]') ||
        !!document.querySelector('[data-testid="no-agents-state"]') ||
        !!document.querySelector('[data-testid="no-selected-agent-state"]')
      );
    },
    undefined,
    { timeout: 30000 }
  );
}

async function waitForAgentsApi(
  page: Page,
  expectedAgentUuid?: string,
  expectedAgentName?: string,
  timeoutMs = 30000
) {
  const startedAt = Date.now();
  let lastSnapshot: {
    ok: boolean;
    status: number;
    count: number;
    hasExpected: boolean;
    agentUuids: string[];
  } | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = await page.evaluate(
      async ({ apiUrl, uuid, name }) => {
        const token = localStorage.getItem('accessToken');

        if (!token) {
          return {
            ok: false,
            status: 0,
            count: 0,
            hasExpected: false,
            agentUuids: [],
          };
        }

        try {
          const response = await fetch(`${apiUrl}/api/v1/agents?limit=100`, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          let body: any = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }

          const agents = Array.isArray(body?.agents) ? body.agents : [];
          const agentUuids = agents
            .map((agent: any) => agent?.uuid)
            .filter((value: unknown): value is string => typeof value === 'string');

          const hasExpected = uuid
            ? agentUuids.includes(uuid)
            : name
              ? agents.some((agent: any) => {
                  const agentName = agent?.device_name || agent?.name || '';
                  return typeof agentName === 'string' && agentName.includes(name);
                })
              : agents.length > 0;

          return {
            ok: response.ok,
            status: response.status,
            count: agents.length,
            hasExpected,
            agentUuids,
          };
        } catch {
          return {
            ok: false,
            status: 0,
            count: 0,
            hasExpected: false,
            agentUuids: [],
          };
        }
      },
      {
        apiUrl: E2E_API_URL,
        uuid: expectedAgentUuid,
        name: expectedAgentName,
      }
    );

    if (lastSnapshot.ok && lastSnapshot.hasExpected) {
      return lastSnapshot;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error(
    `Dashboard agents API did not expose the expected agent within ${timeoutMs}ms. `
    + `status=${lastSnapshot?.status ?? 0} count=${lastSnapshot?.count ?? 0} `
    + `visibleAgentUuids=${(lastSnapshot?.agentUuids || []).join(',')}`
  );
}

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
  await primeDashboardState(page, { accessToken, refreshToken, user });

  await page.goto('/');
  await openAgentHome(page);
}

export async function loginWithCredentials(page: Page, username: string, password: string) {
  await primeDashboardState(page);
  await page.goto('/');

  if (await page.getByTestId('dashboard-app').isVisible().catch(() => false)) {
    await openAgentHome(page);
    return;
  }

  await expect(page.getByTestId('login-form')).toBeVisible();
  await page.getByTestId('login-email').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();

  await openAgentHome(page);
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
  await openAgentHome(page);
  await waitForAgentsApi(page, expectedAgentUuid, expectedAgentName);
  await page.reload();
  await openAgentHome(page);
  await expect(page.getByTestId('agent-sidebar')).toBeVisible({ timeout: 30000 });

  await page.waitForFunction(
    ({ uuid, name }) => {
      const rows = Array.from(document.querySelectorAll('[data-testid^="agent-row-"]'));

      if (uuid && document.querySelector(`[data-testid="agent-row-${uuid}"]`)) {
        return true;
      }

      if (name && rows.some((row) => row.textContent?.includes(name))) {
        return true;
      }

      return rows.length > 0 || !!document.querySelector('[data-testid="no-agents-state"]');
    },
    { uuid: expectedAgentUuid, name: expectedAgentName },
    { timeout: 30000 }
  );

  if (expectedAgentUuid) {
    const agentRow = page.getByTestId(`agent-row-${expectedAgentUuid}`);
    if (await agentRow.isVisible().catch(() => false)) {
      await agentRow.click();
      return expectedAgentUuid;
    }
  }

  if (expectedAgentName) {
    const rowByName = page.locator('[data-testid^="agent-row-"]', {
      hasText: expectedAgentName,
    }).first();
    if (await rowByName.isVisible().catch(() => false)) {
      const testId = await rowByName.getAttribute('data-testid');
      await rowByName.click();
      return testId?.replace('agent-row-', '') ?? null;
    }
  }

  const firstAgentRow = page.locator('[data-testid^="agent-row-"]').first();
  await expect(firstAgentRow).toBeVisible({ timeout: 30000 });
  const testId = await firstAgentRow.getAttribute('data-testid');
  await firstAgentRow.click();
  return testId?.replace('agent-row-', '') ?? null;
}