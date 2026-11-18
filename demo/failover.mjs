import { awsEnv, awsJson, evidence, pulumiOutput, writeLines } from '../scripts/hw31/run.mjs';

const region = awsEnv().AWS_REGION;
const id = pulumiOutput('demo').dbIdentifier;
const before = awsJson(['rds', 'describe-db-instances', '--region', region, '--db-instance-identifier', id])
  .DBInstances[0];
if (before.DBInstanceStatus !== 'available') {
  throw new Error(`rds status is ${before.DBInstanceStatus}; wait until available`);
}
const azBefore = before.AvailabilityZone;
const started = Date.now();
awsJson([
  'rds',
  'reboot-db-instance',
  '--region',
  region,
  '--db-instance-identifier',
  id,
  '--force-failover',
]);

let azAfter = azBefore;
const deadline = Date.now() + 10 * 60 * 1000;
for (;;) {
  const current = awsJson(['rds', 'describe-db-instances', '--region', region, '--db-instance-identifier', id])
    .DBInstances[0];
  azAfter = current.AvailabilityZone;
  if (current.DBInstanceStatus === 'available' && azAfter !== azBefore) break;
  if (Date.now() > deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

const events = awsJson([
  'rds',
  'describe-events',
  '--region',
  region,
  '--source-identifier',
  id,
  '--source-type',
  'db-instance',
  '--duration',
  '60',
]);
const messages = (events.Events ?? []).map((item) => item.Message).filter(Boolean);
const event = messages.find((message) => /fail|az|multi/i.test(message)) ?? messages.at(-1);
const seconds = Math.round((Date.now() - started) / 1000);
const lines = [`az-before=${azBefore}`, `az-after=${azAfter}`, `failover-seconds=${seconds}`];
if (event) lines.push(`event=${event.replace(/\s+/g, ' ')}`);
writeLines(evidence('demos.txt'), lines);
if (!event) throw new Error('describe-events returned no message');
if (azBefore === azAfter) throw new Error(`AZ did not change (${azBefore})`);
