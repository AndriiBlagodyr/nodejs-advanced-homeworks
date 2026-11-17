import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function stackRegion() {
  const text = readFileSync(join(root, 'infra/base/Pulumi.base.yaml'), 'utf8');
  const line = text.split('\n').find((item) => item.includes('aws:region:'));
  const region = line?.split(':').pop()?.trim();
  if (!region) throw new Error('aws:region is missing from infra/base/Pulumi.base.yaml');
  return region;
}

export function awsEnv() {
  const bucket = process.env.HW31_STATE_BUCKET?.trim();
  if (!bucket) {
    throw new Error('missing required secret: HW31_STATE_BUCKET');
  }
  const region = stackRegion();
  return {
    ...process.env,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    PULUMI_BACKEND_URL: `s3://${bucket}`,
    PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE?.trim() || 'hw31-not-a-secret',
  };
}

export function awsJson(args) {
  const out = execFileSync('aws', args, { encoding: 'utf8', env: awsEnv() });
  return out.trim() ? JSON.parse(out) : {};
}

export function pulumiOutput(which) {
  const out = execFileSync('pulumi', ['stack', 'output', '--json', '--stack', which, '--non-interactive'], {
    cwd: join(root, 'infra', which),
    encoding: 'utf8',
    env: awsEnv(),
  });
  return JSON.parse(out);
}

export function writeLines(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${lines.join('\n')}\n`);
}

export function replaceLines(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

export function evidence(name) {
  return join(root, 'evidence', name);
}
