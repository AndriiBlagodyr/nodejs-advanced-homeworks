#!/usr/bin/env node
// Writes pipeline-evidence/evidence.txt from the files of this run.
// Secret values are counted, not printed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/collect-evidence.mjs <dir>');
  process.exit(2);
}

function field(file, key) {
  if (!existsSync(file)) return '';
  const hit = readFileSync(file, 'utf8').split('\n').find((line) => line.startsWith(`${key}=`));
  return hit ? hit.slice(key.length + 1).trim() : '';
}

function countSecrets(file) {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8');
  const names = ['APP_DB_PASSWORD', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'REFRESH_TOKEN_PEPPER', 'PULUMI_CONFIG_PASSPHRASE'];
  let hits = 0;
  for (const name of names) {
    const value = process.env[name] ?? '';
    if (value.length < 8) continue;
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(value, from);
      if (at < 0) break;
      hits += 1;
      from = at + value.length;
    }
  }
  return hits;
}

const buildLog = join(dir, 'build.log');
const invocations = existsSync(buildLog)
  ? readFileSync(buildLog, 'utf8').split('\n').filter((line) => line.trim()).length
  : 0;
const scanExitFile = join(dir, 'scan.exit');
const scanExit = existsSync(scanExitFile) ? readFileSync(scanExitFile, 'utf8').trim() : (process.env.GATE_SCAN_EXIT ?? '');

const lines = [
  `run-id=${process.env.GITHUB_RUN_ID ?? ''}`,
  `head-sha=${process.env.HEAD_SHA ?? ''}`,
  `image-ref=${process.env.IMAGE_REF ?? ''}`,
  `built-digest=${process.env.BUILT_DIGEST ?? ''}`,
  `deployed-digest=${process.env.DEPLOYED_DIGEST ?? ''}`,
  `build-invocations=${invocations}`,
  'creds-source=oidc',
  `oidc-iss=${field(join(dir, 'oidc.txt'), 'iss')}`,
  `oidc-aud=${field(join(dir, 'oidc.txt'), 'aud')}`,
  `oidc-sub=${field(join(dir, 'oidc.txt'), 'sub')}`,
  `oidc-sig-verified=${field(join(dir, 'oidc.txt'), 'sig-verified')}`,
  `rollout-requests=${field(join(dir, 'rollout.txt'), 'requests')}`,
  `rollout-ok=${field(join(dir, 'rollout.txt'), 'ok')}`,
  `rollout-failed=${field(join(dir, 'rollout.txt'), 'failed')}`,
  `rollout-seconds=${field(join(dir, 'rollout.txt'), 'rollout-seconds')}`,
  `secret-in-manifest=${countSecrets(join(dir, 'deployment.json'))}`,
  `gate-scan-exit=${scanExit}`,
];
writeFileSync(join(dir, 'evidence.txt'), `${lines.join('\n')}\n`);
for (const line of lines) console.log(line);
