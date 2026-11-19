import { readFileSync } from 'node:fs';
import { sensitiveEnvKeys } from './keyless-env';

/**
 * A client process: one presigned URL, one file, no credentials of any kind.
 * Run with an environment that holds only PATH.
 */
type Plan = { url: string; headers: Record<string, string>; file: string };

async function main(): Promise<void> {
  console.log(`env-keys=${sensitiveEnvKeys()}`);
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Plan;
  const res = await fetch(plan.url, {
    method: 'PUT',
    headers: plan.headers,
    body: readFileSync(plan.file),
  });
  await res.arrayBuffer();
  console.log(`status=${res.status}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.log('status=0');
});
