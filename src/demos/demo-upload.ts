import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepOrphanFiles } from '../files/orphans';
import { PUT_URL_TTL_SEC } from '../files/policy';
import { createPool } from '../outbox/pg';
import { storageFromEnv } from '../storage/storage';
import {
  bootApi,
  call,
  dbQuery,
  insertUser,
  loginAs,
  migrate,
  resetAuthUsers,
  type Running,
} from './auth-kit';
import { fail, report, sleep } from './demo-kit';
import { childValues, isPortOpen, portOf, purgeDemoFiles, runKeyless } from './files-kit';

const OWNER = 'hw26-upload@example.com';
const OTHER = 'hw26-upload-other@example.com';
const EVIL_NAME = '../../etc/passwd';
const EXPIRY_PROBE_TTL_SEC = 2;

type SingleIntent = {
  fileId: string;
  key: string;
  mode: 'single';
  expiresIn: number;
  upload: { url: string; headers: Record<string, string> };
};

/**
 * intent → PUT straight into storage → commit. The PUT is made by a separate
 * process with no keys at all, while our API is shut down: the bytes do not
 * pass through us. Commit trusts HeadObject, not the client.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  const storage = storageFromEnv();
  await migrate();
  await storage.ensureBucket();
  await purgeDemoFiles('hw26-upload%');
  await resetAuthUsers('hw26-upload%');
  const ownerId = await insertUser(OWNER, 'buyer', 'HW26 Upload');
  await insertUser(OTHER, 'buyer', 'HW26 Upload Other');

  const dir = await mkdtemp(join(tmpdir(), 'hw26-upload-'));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(64 * 1024),
  ]);
  const file = join(dir, 'avatar.png');
  await writeFile(file, png);

  let api: Running | undefined = await bootApi();
  try {
    const firstPort = portOf(api.base);
    const token = await loginAs(api.base, OWNER);
    const otherToken = await loginAs(api.base, OTHER);
    const body = { contentType: 'image/png', size: png.length, filename: EVIL_NAME };
    const idem = { 'idempotency-key': `hw26-${randomUUID()}` };

    const intent = await call(api.base, 'POST', '/uploads/intent', { token, body, headers: idem });
    const it = intent.body as unknown as SingleIntent;
    const again = await call(api.base, 'POST', '/uploads/intent', { token, body, headers: idem });
    const keyPattern = new RegExp(`^uploads/${ownerId}/[0-9a-f-]{36}\\.png$`);
    const keyFromServer =
      keyPattern.test(it.key) && !it.key.includes('passwd') && !it.key.includes('..') ? 1 : 0;

    // Same signature, another key in the path: the signature covers the path.
    const tamperedUrl = new URL(it.upload.url);
    tamperedUrl.pathname = tamperedUrl.pathname.replace(/[^/]+\.png$/, `${randomUUID()}.png`);
    const tampered = await fetch(tamperedUrl, {
      method: 'PUT',
      headers: it.upload.headers,
      body: png,
    });
    await tampered.arrayBuffer();

    // Right key, more bytes than declared: Content-Length is signed too.
    const oversized = await fetch(it.upload.url, {
      method: 'PUT',
      headers: it.upload.headers,
      body: Buffer.concat([png, Buffer.alloc(1024)]),
    });
    await oversized.arrayBuffer();

    // An intent with no bytes behind it must not commit.
    const empty = await call(api.base, 'POST', '/uploads/intent', {
      token,
      body: { contentType: 'image/png', size: 1234 },
    });
    const commitWithoutBytes = await call(
      api.base,
      'POST',
      `/uploads/${String(empty.body.fileId)}/commit`,
      { token },
    );

    // Our API goes away. The upload must not care.
    await api.app.close();
    api = undefined;
    const apiAlive = (await isPortOpen(firstPort)) ? 1 : 0;
    const put = await runKeyless('keyless-put.js', {
      url: it.upload.url,
      headers: it.upload.headers,
      file,
    });
    const putValues = childValues(put.stdout);
    const putOffline = Number(putValues.status ?? 0);

    // Back on a different port: a pooled socket to the old one would be dead.
    api = await bootApi();
    while (portOf(api.base) === firstPort) {
      const stale: Running = api;
      api = await bootApi();
      await stale.app.close();
    }
    const foreignCommit = await call(api.base, 'POST', `/uploads/${it.fileId}/commit`, {
      token: otherToken,
    });
    const commit = await call(api.base, 'POST', `/uploads/${it.fileId}/commit`, { token });
    const rows = await dbQuery<Array<{ status: string }>>(`SELECT status FROM files WHERE id = $1`, [
      it.fileId,
    ]);

    const download = await fetch(`${api.base}/files/${it.fileId}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
    });
    const location = download.headers.get('location') ?? '';
    const fetched = location ? Buffer.from(await (await fetch(location)).arrayBuffer()) : null;

    // Expiry: the same signing call the API uses, a short TTL, the same URL twice.
    const probeKey = `uploads/${ownerId}/${randomUUID()}.png`;
    const probeUrl = await storage.presignPut(probeKey, 'image/png', png.length, EXPIRY_PROBE_TTL_SEC);
    const fresh = await fetch(probeUrl, { method: 'PUT', headers: it.upload.headers, body: png });
    await fresh.arrayBuffer();
    await sleep((EXPIRY_PROBE_TTL_SEC + 2) * 1000);
    const expired = await fetch(probeUrl, { method: 'PUT', headers: it.upload.headers, body: png });
    await expired.arrayBuffer();

    // The never-committed intent, aged past a day, is what the orphan job removes.
    await dbQuery(`UPDATE files SET created_at = now() - interval '2 days' WHERE id = $1`, [
      empty.body.fileId,
    ]);
    const pool = createPool();
    try {
      await sweepOrphanFiles(pool, storage);
    } finally {
      await pool.end();
    }
    const orphan = await dbQuery<unknown[]>(`SELECT 1 FROM files WHERE id = $1`, [
      empty.body.fileId,
    ]);

    const lines = {
      intent: intent.status,
      'key-from-server': keyFromServer,
      'intent-idempotent': again.status === 200 && again.body.fileId === it.fileId ? 1 : 0,
      'put-ttl-sec': it.expiresIn,
      tampered: tampered.status,
      'oversized-put': oversized.status,
      'commit-without-bytes': commitWithoutBytes.status,
      'api-alive': apiAlive,
      'put-env-keys': Number(putValues['env-keys'] ?? -1),
      'put-offline': putOffline,
      'foreign-commit': foreignCommit.status,
      commit: commit.status,
      'status-completed': rows[0]?.status === 'COMPLETED' ? 1 : 0,
      download: download.status,
      'download-body-match': fetched?.equals(png) ? 1 : 0,
      'expiry-probe-fresh': fresh.status,
      expired: expired.status,
      'orphan-swept': orphan.length === 0 ? 1 : 0,
    };
    return {
      lines,
      ok:
        lines.intent === 200 &&
        lines['key-from-server'] === 1 &&
        lines['intent-idempotent'] === 1 &&
        lines['put-ttl-sec'] === PUT_URL_TTL_SEC &&
        lines.tampered === 403 &&
        lines['oversized-put'] === 403 &&
        lines['orphan-swept'] === 1 &&
        lines['commit-without-bytes'] >= 400 &&
        lines['commit-without-bytes'] < 500 &&
        lines['api-alive'] === 0 &&
        lines['put-env-keys'] === 0 &&
        lines['put-offline'] === 200 &&
        lines['foreign-commit'] === 403 &&
        lines.commit === 200 &&
        lines['status-completed'] === 1 &&
        lines.download === 302 &&
        lines['download-body-match'] === 1 &&
        lines['expiry-probe-fresh'] === 200 &&
        lines.expired === 403,
    };
  } finally {
    await api?.app.close();
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(fail);
