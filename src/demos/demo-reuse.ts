import { fail, report } from './demo-kit';
import { bootApi, call, DEMO_PASSWORD, insertUser, migrate, resetAuthUsers } from './auth-kit';

const EMAIL = 'hw24-reuse@example.com';

/**
 * r1 is the refresh token from login. Refreshing it yields r2. Presenting r1
 * again is reuse: the family is revoked, so the honest client's r2 dies too.
 * Rotation without a family would leave r2 working.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  await migrate();
  await resetAuthUsers('hw24-reuse@%');
  await insertUser(EMAIL, 'buyer', 'HW24 Reuse');
  const { app, base } = await bootApi();
  try {
    const login = await call(base, 'POST', '/auth/login', {
      body: { email: EMAIL, password: DEMO_PASSWORD },
    });
    const r1 = String(login.body.refresh_token ?? '');

    const first = await call(base, 'POST', '/auth/refresh', { body: { refresh_token: r1 } });
    const r2 = String(first.body.refresh_token ?? '');

    const reuse = await call(base, 'POST', '/auth/refresh', { body: { refresh_token: r1 } });
    const after = await call(base, 'POST', '/auth/refresh', { body: { refresh_token: r2 } });

    const lines = {
      login: login.status,
      'r1-refresh': first.status,
      'r1-reuse': reuse.status,
      'r2-after-reuse': after.status,
    };
    return {
      lines,
      ok:
        lines.login === 200 &&
        lines['r1-refresh'] === 200 &&
        lines['r1-reuse'] === 401 &&
        lines['r2-after-reuse'] === 401,
    };
  } finally {
    await app.close();
  }
}

main().catch(fail);
