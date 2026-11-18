import { execFileSync } from 'node:child_process';
import { awsEnv, awsJson, evidence, root, writeLines } from '../scripts/hw31/run.mjs';

const env = awsEnv();
const region = env.AWS_REGION;

function up(withNat) {
  execFileSync('bash', [`${root}/scripts/hw31/up.sh`, 'demo'], {
    stdio: 'inherit',
    env: { ...env, HW31_WITH_NAT: withNat },
  });
}

up('true');
const created = awsJson([
  'ec2',
  'describe-nat-gateways',
  '--region',
  region,
  '--filter',
  'Name=state,Values=available',
  'Name=tag:Project,Values=nodejs-pro-hw31',
]).NatGateways?.[0]?.CreateTime;
if (!created) throw new Error('nat gateway was not created');
const createdMs = typeof created === 'number' ? (created < 1e12 ? created * 1000 : created) : Date.parse(String(created));
if (Number.isNaN(createdMs)) throw new Error(`bad nat CreateTime: ${created}`);

up('false');
const minutes = Math.max(1, Math.ceil((Date.now() - createdMs) / 60000));
writeLines(evidence('demos.txt'), [
  `nat-minutes=${minutes}`,
  `nat-billed-hours=${minutes < 60 ? 1 : Math.ceil(minutes / 60)}`,
]);
