import { awsEnv, awsJson, evidence, pulumiOutput, writeLines } from '../scripts/hw31/run.mjs';

const region = awsEnv().AWS_REGION;
const output = pulumiOutput('demo');
const dns = output.albDns;
const group = output.targetGroupArn;

let state = 'unknown';
const deadline = Date.now() + 5 * 60 * 1000;
for (;;) {
  const health = awsJson([
    'elbv2',
    'describe-target-health',
    '--region',
    region,
    '--target-group-arn',
    group,
  ]);
  state = health.TargetHealthDescriptions?.[0]?.TargetHealth?.State ?? 'missing';
  if (state === 'healthy') break;
  if (Date.now() > deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

let response;
let lastError;
for (let attempt = 0; attempt < 12; attempt += 1) {
  try {
    response = await fetch(`http://${dns}/`);
    break;
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
if (!response) throw lastError;
writeLines(evidence('demos.txt'), [
  `alb-dns=${dns}`,
  `http-code=${response.status}`,
  `target-state=${state}`,
]);
if (state !== 'healthy' || response.status !== 200) {
  throw new Error(`alb not ready: target-state=${state} http-code=${response.status}`);
}
