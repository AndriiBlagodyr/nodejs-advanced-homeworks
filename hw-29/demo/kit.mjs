import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const names = JSON.parse(readFileSync(join(ROOT, 'k8s', 'names.json'), 'utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const execFileP = promisify(execFile);

/**
 * Runs a command, returns { code, stdout, stderr } without throwing. Hard
 * timeout with SIGKILL: a wedged Docker daemon leaves `docker run` waiting
 * forever and it ignores SIGTERM; the demo must fail, not hang.
 */
export async function run(cmd, args, { timeoutMs = 120_000, ...opts } = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      maxBuffer: 256 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      ...opts,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (err.killed) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} timed out after ${timeoutMs} ms`);
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
}

export async function kubectl(args) {
  return run('kubectl', ['--context', names.context, '-n', names.namespace, ...args]);
}

export async function kubectlJson(args) {
  const res = await kubectl([...args, '-o', 'json']);
  if (res.code !== 0) throw new Error(`kubectl ${args.join(' ')}: ${res.stderr.trim()}`);
  return JSON.parse(res.stdout);
}

/** Pulumi via scripts/pulumi.sh (local file backend, stack dev); output streamed to stderr. */
export function pulumi(args) {
  return new Promise((resolve) => {
    const child = spawn('bash', [join(ROOT, 'scripts', 'pulumi.sh'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => resolve({ code: code ?? 1, tail }));
  });
}

/** key=number lines, then invariant-ok, then the exit code the grader reads. */
export function report(lines, ok) {
  for (const [key, value] of Object.entries(lines)) console.log(`${key}=${value}`);
  console.log(`invariant-ok=${ok ? 1 : 0}`);
  process.exit(ok ? 0 : 1);
}

export function fail(err) {
  console.error(err instanceof Error ? err.message : err);
  console.log('invariant-ok=0');
  process.exit(1);
}
