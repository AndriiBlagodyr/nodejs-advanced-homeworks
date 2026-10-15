import { connectStateRedis } from '../redis/clients';
import { SESSION_COOKIE, SessionStore } from '../session/session.store';
import { fail, report, sleep } from './demo-kit';
import { bootApp, scanKeys } from './redis-kit';

const DEMO_USER_ID = '9001';

/**
 * Session in the noeviction Redis with rolling TTL. Request 1 creates it on
 * pod A, request 2 renews it on pod A after a pause, then pod A is shut down
 * and request 3 reads the same session on a freshly started pod B.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  const redis = await connectStateRedis();
  try {
    await removeDemoSessions(redis);

    let requests = 0;
    const sids = new Set<string>();

    let pod = await bootApp();
    const created = await fetch(`${pod.base}/session`, {
      method: 'POST',
      headers: { 'x-user-id': DEMO_USER_ID },
    });
    requests += 1;
    const sid = cookieValue(created.headers.get('set-cookie'));
    if (!sid) throw new Error(`no session cookie (status ${created.status})`);
    sids.add(sid);
    const key = SessionStore.keyFor(sid);
    const cookie = `${SESSION_COOKIE}=${sid}`;

    await sleep(1500);
    const ttlBefore = await redis.pttl(key);
    const renewed = await fetch(`${pod.base}/session`, { headers: { cookie } });
    requests += 1;
    collect(sids, renewed.headers.get('set-cookie'));
    const ttlAfter = await redis.pttl(key);

    // Process restart: nothing survives in memory, only Redis.
    await pod.app.close();
    pod = await bootApp();
    await sleep(500);
    const afterRestart = await fetch(`${pod.base}/session`, { headers: { cookie } });
    requests += 1;
    collect(sids, afterRestart.headers.get('set-cookie'));
    const body = (await afterRestart.json()) as { requests?: number; user_id?: string };
    await pod.app.close();

    const sessionsInRedis = (await demoSessionKeys(redis)).length;
    const inRedis = await redis.exists(key);
    const ttlRenewed = ttlAfter > ttlBefore ? 1 : 0;
    const survivedRestart = afterRestart.status === 200 && body.user_id === DEMO_USER_ID ? 1 : 0;

    return {
      lines: {
        requests,
        sessions: sids.size,
        'sessions-in-redis': sessionsInRedis,
        'in-redis': inRedis,
        'ttl-before-ms': ttlBefore,
        'ttl-after-ms': ttlAfter,
        'ttl-renewed': ttlRenewed,
        'survived-restart': survivedRestart,
        'server-requests': body.requests ?? 0,
      },
      ok:
        requests >= 3 &&
        sids.size === 1 &&
        sessionsInRedis === 1 &&
        inRedis === 1 &&
        ttlRenewed === 1 &&
        survivedRestart === 1 &&
        body.requests === requests,
    };
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

function cookieValue(header: string | null): string | null {
  const match = header ? new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header) : null;
  return match && match[1] ? match[1] : null;
}

function collect(sids: Set<string>, header: string | null): void {
  const sid = cookieValue(header);
  if (sid) sids.add(sid);
}

async function demoSessionKeys(redis: import('ioredis').default): Promise<string[]> {
  const keys = await scanKeys(redis, 'session:*');
  const owners = await Promise.all(keys.map((k) => redis.hget(k, 'userId')));
  return keys.filter((_, i) => owners[i] === DEMO_USER_ID);
}

async function removeDemoSessions(redis: import('ioredis').default): Promise<void> {
  const keys = await demoSessionKeys(redis);
  if (keys.length > 0) await redis.del(...keys);
}

main().catch(fail);
