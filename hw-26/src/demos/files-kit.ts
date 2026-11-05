import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageFromEnv } from '../storage/storage';
import { dbQuery } from './auth-kit';

/** Raw TCP probe. fetch would reuse a pooled socket and could lie about a dead port. */
export function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export function portOf(base: string): number {
  return Number(new URL(base).port);
}

export type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

/**
 * Runs a client process with nothing but PATH in its environment: no storage
 * keys, no DATABASE_URL, no JWT. If it can upload, the URL alone carried the right.
 */
export async function runKeyless(script: string, plan: unknown): Promise<ChildResult> {
  const dir = await mkdtemp(join(tmpdir(), 'hw26-'));
  const planFile = join(dir, 'plan.json');
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
  try {
    const child = spawn(process.execPath, [join(__dirname, script), planFile], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    // The trap-on-EXIT of this demo: a child never outlives it.
    const killChild = () => child.kill('SIGKILL');
    process.once('exit', killChild);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    return await new Promise<ChildResult>((resolve) =>
      child.once('exit', (code, signal) => {
        process.off('exit', killChild);
        resolve({ code, signal, stdout });
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Parses `key=value` lines a child printed. */
export function childValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = /^([\w-]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Clean slate for a demo's users: their objects, their unfinished multipart
 * uploads (ListMultipartUploads → Abort; they are billed and invisible), and
 * then the rows (files go with the users, ON DELETE CASCADE).
 */
export async function purgeDemoFiles(emailLike: string): Promise<void> {
  const storage = storageFromEnv();
  const users = await dbQuery<Array<{ id: string }>>(
    `SELECT id::text AS id FROM users WHERE email LIKE $1`,
    [emailLike],
  );
  for (const u of users) await storage.purgePrefix(`uploads/${u.id}/`);
}
