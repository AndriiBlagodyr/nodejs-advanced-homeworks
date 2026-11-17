import { randomBytes, randomUUID } from 'node:crypto';
import { fail, report } from './demo-kit';
import {
  bootApi,
  call,
  dbQuery,
  DEMO_PASSWORD,
  insertUser,
  migrate,
  resetAuthUsers,
} from './auth-kit';

const EMAIL = 'hw24-auth@example.com';

/**
 * Login, a protected read, refresh, then logout. Logout has to kill both
 * tokens: the refresh family (revoked_at) and every access token of that
 * login (family denylist), because an access token would otherwise stay valid
 * until exp. `old-access-after-logout` is the access token issued at login,
 * before the refresh: a jti-only denylist leaves it at 200.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  await migrate();
  await resetAuthUsers('hw24-auth@%');
  const userId = await insertUser(EMAIL, 'buyer', 'HW24 Auth');
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

    // An already expired refresh row; logout's sweep must remove it.
    const staleHash = randomBytes(32).toString('hex');
    await dbQuery(
      `INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 second')`,
      [staleHash, randomUUID(), userId],
    );

    const logout = await call(base, 'POST', '/auth/logout', { token: access2 });
    const afterLogout = await call(base, 'GET', '/auth/me', { token: access2 });
    const oldAccessAfter = await call(base, 'GET', '/auth/me', { token: access });
    const refreshAfter = await call(base, 'POST', '/auth/refresh', {
      body: { refresh_token: refresh2 },
    });
    const stale = await dbQuery<unknown[]>(`SELECT 1 FROM refresh_tokens WHERE token_hash = $1`, [
      staleHash,
    ]);

    const lines = {
      login: login.status,
      'no-token': noToken.status,
      'with-token': withToken.status,
      refresh: refreshed.status,
      logout: logout.status,
      'after-logout': afterLogout.status,
      'old-access-after-logout': oldAccessAfter.status,
      'refresh-after-logout': refreshAfter.status,
      'expired-refresh-swept': stale.length === 0 ? 1 : 0,
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
        lines['old-access-after-logout'] === 401 &&
        lines['refresh-after-logout'] === 401 &&
        lines['expired-refresh-swept'] === 1,
    };
  } finally {
    await app.close();
  }
}

main().catch(fail);
