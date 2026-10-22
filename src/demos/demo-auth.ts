import { fail, report } from './demo-kit';
import { bootApi, call, DEMO_PASSWORD, insertUser, migrate, resetAuthUsers } from './auth-kit';

const EMAIL = 'hw24-auth@example.com';

/**
 * Login, a protected read, refresh, then logout. Logout has to kill both
 * tokens: the refresh row (revoked_at) and the access token (denylist),
 * because the access token would otherwise stay valid until exp.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  await migrate();
  await resetAuthUsers('hw24-auth@%');
  await insertUser(EMAIL, 'buyer', 'HW24 Auth');
  const { app, base } = await bootApi();
  try {
    const login = await call(base, 'POST', '/auth/login', {
      body: { email: EMAIL, password: DEMO_PASSWORD },
    });
    const access = String(login.body.access_token ?? '');
    const refresh = String(login.body.refresh_token ?? '');

    const noToken = await call(base, 'GET', '/auth/me');
    const withToken = await call(base, 'GET', '/auth/me', { token: access });
    const refreshed = await call(base, 'POST', '/auth/refresh', {
      body: { refresh_token: refresh },
    });
    const access2 = String(refreshed.body.access_token ?? '');
    const refresh2 = String(refreshed.body.refresh_token ?? '');

    const logout = await call(base, 'POST', '/auth/logout', { token: access2 });
    const afterLogout = await call(base, 'GET', '/auth/me', { token: access2 });
    const refreshAfter = await call(base, 'POST', '/auth/refresh', {
      body: { refresh_token: refresh2 },
    });

    const lines = {
      login: login.status,
      'no-token': noToken.status,
      'with-token': withToken.status,
      refresh: refreshed.status,
      logout: logout.status,
      'after-logout': afterLogout.status,
      'refresh-after-logout': refreshAfter.status,
    };
    return {
      lines,
      ok:
        lines.login === 200 &&
        lines['no-token'] === 401 &&
        lines['with-token'] === 200 &&
        lines.refresh === 200 &&
        (lines.logout === 200 || lines.logout === 204) &&
        lines['after-logout'] === 401 &&
        lines['refresh-after-logout'] === 401,
    };
  } finally {
    await app.close();
  }
}

main().catch(fail);
