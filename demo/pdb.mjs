// demo:pdb — two evictions in a row through the Eviction API, codes read from the HTTP responses.
//
// The PDB allows one voluntary disruption: the first eviction is 201, the
// second (before the replacement is ready) is 429. A plain `kubectl delete pod`
// would ignore the budget entirely; only the Eviction API consults it.
// At the end the demo waits until the Deployment is whole again.

import { spawn } from 'node:child_process';
import { fail, kubectl, kubectlJson, names, report, sleep } from './kit.mjs';

const RECOVER_TIMEOUT_MS = 180_000;

async function main() {
  const pdb = await kubectlJson(['get', 'pdb', names.app]);
  const before = pdb.status ?? {};
  const pods = (await kubectlJson(['get', 'pods', '-l', `app=${names.app}`])).items.filter(
    (p) => !p.metadata.deletionTimestamp && p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
  );
  if (pods.length < 2) throw new Error(`need at least 2 ready pods, have ${pods.length}`);

  const proxy = await startProxy();
  let first;
  let second;
  try {
    first = await evict(proxy.base, pods[0].metadata.name);
    second = await evict(proxy.base, pods[1].metadata.name);
  } finally {
    proxy.stop();
  }

  const recovered = await waitRecovered();
  const lines = {
    healthy: before.currentHealthy,
    minAvailable: pdb.spec.minAvailable,
    'disruptions-allowed-before': before.disruptionsAllowed,
    'evict-1': first,
    'evict-2': second,
    recovered: recovered ? 1 : 0,
  };
  report(lines, lines['disruptions-allowed-before'] >= 1 && first === 201 && second === 429 && recovered);
}

async function evict(base, pod) {
  const res = await fetch(`${base}/api/v1/namespaces/${names.namespace}/pods/${pod}/eviction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiVersion: 'policy/v1',
      kind: 'Eviction',
      metadata: { name: pod, namespace: names.namespace },
    }),
  });
  await res.arrayBuffer();
  return res.status;
}

/** kubectl proxy on a free port: the API server's own status codes, no kubectl formatting in between. */
function startProxy() {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', names.context, 'proxy', '--port=0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.on('exit', () => child.kill());
    const timer = setTimeout(() => reject(new Error('kubectl proxy did not start')), 15_000);
    child.stdout.on('data', (chunk) => {
      const m = /Starting to serve on ([\d.]+):(\d+)/.exec(chunk.toString());
      if (!m) return;
      clearTimeout(timer);
      resolve({ base: `http://${m[1]}:${m[2]}`, stop: () => child.kill() });
    });
    child.on('error', reject);
  });
}

async function waitRecovered() {
  const deadline = Date.now() + RECOVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await kubectlJson(['get', 'deploy', names.app]);
    const pdb = await kubectlJson(['get', 'pdb', names.app]);
    const pods = await kubectlJson(['get', 'pods', '-l', `app=${names.app}`]);
    const whole =
      d.status.availableReplicas === d.spec.replicas &&
      !pods.items.some((p) => p.metadata.deletionTimestamp) &&
      (pdb.status?.disruptionsAllowed ?? 0) >= 1;
    if (whole) return true;
    await sleep(1000);
  }
  const res = await kubectl(['get', 'pods', '-l', `app=${names.app}`]);
  console.error(res.stdout);
  return false;
}

main().catch(fail);
