import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planParts } from '../files/policy';
import { storageFromEnv } from '../storage/storage';
import { bootApi, call, insertUser, loginAs, migrate, resetAuthUsers } from './auth-kit';
import { fail, report } from './demo-kit';
import { childValues, purgeDemoFiles, runKeyless } from './files-kit';

const EMAIL = 'hw26-multipart@example.com';
const MiB = 1024 * 1024;
/** 12 MiB → planParts gives 5 MiB parts: 5 + 5 + 2, three parts. */
const FILE_SIZE = 12 * MiB;
const CRASH_AFTER = 2;

type MultipartIntent = {
  fileId: string;
  key: string;
  mode: 'multipart';
  partSize: number;
  partCount: number;
  uploadedParts: number[];
  parts: Array<{ partNumber: number; url: string }>;
};

/**
 * Process A uploads two of three parts and is killed. Process B is a new
 * process with no memory of A: it asks the API, which asks the storage
 * (ListParts), and uploads only what is missing. Before Complete the object
 * does not exist even though its parts do.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  const storage = storageFromEnv();
  await migrate();
  await storage.ensureBucket();
  await purgeDemoFiles('hw26-multipart%');
  await resetAuthUsers('hw26-multipart%');
  await insertUser(EMAIL, 'seller', 'HW26 Multipart');

  const dir = await mkdtemp(join(tmpdir(), 'hw26-multipart-'));
  // A pg_dump-like archive: gzip magic, then noise.
  const data = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), randomBytes(FILE_SIZE - 4)]);
  const file = join(dir, 'dump.sql.gz');
  await writeFile(file, data);
  const md5 = createHash('md5').update(data).digest('hex');
  const plan = planParts(FILE_SIZE);

  const { app, base } = await bootApi();
  try {
    const token = await loginAs(base, EMAIL);
    const intent = await call(base, 'POST', '/uploads/intent', {
      token,
      body: { contentType: 'application/gzip', size: FILE_SIZE, filename: 'dump.sql.gz' },
    });
    const it = intent.body as unknown as MultipartIntent;

    const first = await runKeyless('keyless-parts.js', {
      file,
      size: FILE_SIZE,
      partSize: it.partSize,
      parts: it.parts,
      crashAfter: CRASH_AFTER,
    });

    const headBefore = (await storage.head(it.key)) ? 200 : 404;

    const resume = await call(base, 'POST', `/uploads/${it.fileId}/resume`, { token });
    const rs = resume.body as unknown as MultipartIntent;
    const second = await runKeyless('keyless-parts.js', {
      file,
      size: FILE_SIZE,
      partSize: rs.partSize,
      parts: rs.parts,
    });
    const secondValues = childValues(second.stdout);
    const resumedParts = Number(secondValues.uploaded ?? -1);
    const envKeys =
      Number(childValues(first.stdout)['env-keys'] ?? -1) + Number(secondValues['env-keys'] ?? -1);

    const complete = await call(base, 'POST', `/uploads/${it.fileId}/commit`, { token });
    const head = await storage.head(it.key);
    const etag = (head?.etag ?? '').replace(/"/g, '');

    const lines = {
      'file-bytes': FILE_SIZE,
      'part-size-mib': it.partSize / MiB,
      parts: it.partCount,
      intent: intent.status,
      'uploader-env-keys': envKeys,
      'first-process-killed': first.signal === 'SIGKILL' ? 1 : 0,
      'parts-before-crash': rs.uploadedParts?.length ?? -1,
      'head-before-complete': headBefore,
      'resumed-parts': resumedParts,
      complete: complete.status,
      'size-match': head?.size === FILE_SIZE ? 1 : 0,
      'etag-multipart': etag.endsWith(`-${it.partCount}`) && etag !== md5 ? 1 : 0,
    };
    return {
      lines,
      ok:
        lines.intent === 200 &&
        it.partSize === plan.partSize &&
        lines.parts === 3 &&
        lines['uploader-env-keys'] === 0 &&
        lines['first-process-killed'] === 1 &&
        lines['parts-before-crash'] === CRASH_AFTER &&
        lines['head-before-complete'] === 404 &&
        lines['resumed-parts'] === 1 &&
        lines.complete === 200 &&
        lines['size-match'] === 1 &&
        lines['etag-multipart'] === 1,
    };
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(fail);
