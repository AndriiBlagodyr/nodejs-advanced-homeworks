// demo:rollout — a rolling update under load, measured from a file of response codes.
//
//   npm run demo:rollout                       # hardened profile (the graded one)
//   DEMO_PROFILE=broken npm run demo:rollout   # control run, then hardened is restored
//
// Runs through scripts/with-secrets.sh: the rollout is a real `pulumi up`
// with a new `rev` in the pod template, and the program needs the vault values.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, kubectl, kubectlJson, names, pulumi, report, ROOT, sleep } from './kit.mjs';

const PROFILE_IDS = { hardened: 1, broken: 0 };
const MIN_REQUESTS = 5000;
const BASELINE_MS = 3000;
/**
 * Load stays on this long after the last old pod is gone. Longer than the
 * app's 4 s warm-up: in the broken profile a pod counts as available before
 * it listens, and that gap has to be inside the measured window.
 */
const TAIL_MS = 8000;
/**
 * Quiet time before the baseline. Pods that exit without a drain (the broken
 * profile, or its restore) stay in kube-proxy's rules for a moment after
 * their object is gone; a new connection then goes to a dead IP and hangs.
 * Without this, the previous run's teardown shows up in this run's numbers.
 */
const SETTLE_MS = 5000;
const ROLLOUT_TIMEOUT_MS = 300_000;
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 16);
const TARGET = `http://127.0.0.1:${names.hostPort}/products?limit=5`;

async function main() {
  const profile = process.env.DEMO_PROFILE ?? 'hardened';
  if (!(profile in PROFILE_IDS)) throw new Error(`DEMO_PROFILE must be hardened or broken, got ${profile}`);

  await kubectlJson(['get', 'deploy', names.app]); // fails early if `npm run up` was not run
  if (profile !== 'hardened') await apply(['-c', `profile=${profile}`], `switch to ${profile}`);

  const dir = mkdtempSync(join(tmpdir(), 'hw28-rollout-'));
  const codesFile = join(dir, 'codes.txt');
  let lines;
  try {
    lines = await measure(codesFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // Leave the cluster in the graded profile, whatever happened above.
    if (profile !== 'hardened') await apply(['-c', 'profile=hardened'], 'restore hardened');
  }

  const out = { profile: PROFILE_IDS[profile], ...lines };
  // Hardened: zero failures on a non-empty measurement. Broken (control): the
  // same counter must see the failures, or the measurement proves nothing.
  report(out, profile === 'hardened' ? out.requests >= MIN_REQUESTS && out.failed === 0 : out.failed > 0);
}

async function measure(codesFile) {
  await settle();
  const load = spawn(process.execPath, [join(ROOT, 'scripts', 'load.mjs'), TARGET, codesFile, String(CONCURRENCY)], {
    stdio: 'inherit',
  });
  const loadExit = new Promise((r) => load.on('close', r));
  process.on('exit', () => load.kill('SIGKILL'));

  await sleep(BASELINE_MS);
  const before = await kubectlJson(['get', 'deploy', names.app]);
  const rev = String(Date.now());

  const upDone = pulumi(['up', '--yes', '--non-interactive', '--skip-preview', '-c', `rev=${rev}`]);
  const rolloutSeconds = await watchRollout(before.metadata.generation, upDone);
  const up = await upDone;
  if (up.code !== 0) throw new Error(`pulumi up failed:\n${up.tail}`);

  // Old pods are still draining after the Deployment reports done: keep the
  // load on until the last one is gone, so its close() is inside the window.
  await waitNoTerminating();
  await sleep(TAIL_MS);
  load.kill('SIGINT');
  await loadExit;

  const codes = readFileSync(codesFile, 'utf8').split('\n').filter(Boolean);
  const ok = codes.filter((c) => c === '200').length;
  return {
    requests: codes.length,
    ok,
    failed: codes.length - ok,
    'no-response': codes.filter((c) => c === '000').length,
    'http-5xx': codes.filter((c) => c.startsWith('5')).length,
    'rollout-seconds': rolloutSeconds,
    rev: Number(rev),
  };
}

/** From the new generation appearing to every replica updated, available, and the old ones gone. */
async function watchRollout(previousGeneration, upDone) {
  let up;
  void upDone.then((res) => (up = res));
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  let startedAt;
  for (;;) {
    if (up && up.code !== 0) throw new Error(`pulumi up failed:\n${up.tail}`);
    if (Date.now() > deadline) throw new Error('rollout did not finish in time');
    const d = await kubectlJson(['get', 'deploy', names.app]);
    if (!startedAt && d.metadata.generation > previousGeneration) startedAt = Date.now();
    if (startedAt) {
      const want = d.spec.replicas;
      const s = d.status ?? {};
      const done =
        (s.observedGeneration ?? 0) >= d.metadata.generation &&
        s.updatedReplicas === want &&
        s.availableReplicas === want &&
        s.replicas === want;
      if (done) return Math.round((Date.now() - startedAt) / 100) / 10;
    }
    await sleep(200);
  }
}

async function waitNoTerminating() {
  for (;;) {
    const pods = await kubectlJson(['get', 'pods', '-l', `app=${names.app}`]);
    if (!pods.items.some((p) => p.metadata.deletionTimestamp)) return;
    await sleep(250);
  }
}

async function apply(extraArgs, label) {
  const res = await pulumi(['up', '--yes', '--non-interactive', '--skip-preview', ...extraArgs]);
  if (res.code !== 0) throw new Error(`pulumi up (${label}) failed:\n${res.tail}`);
  await settle();
}

async function settle() {
  const wait = await kubectl(['rollout', 'status', `deploy/${names.app}`, '--timeout=180s']);
  if (wait.code !== 0) throw new Error(`deployment not settled: ${wait.stderr}`);
  await waitNoTerminating();
  await sleep(SETTLE_MS);
}

main().catch(fail);
