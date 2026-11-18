import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { awsEnv, awsJson, evidence, replaceLines } from './run.mjs';

function decoded(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value ?? '');
  const raw = text.includes('%') ? decodeURIComponent(text) : text;
  return JSON.parse(raw);
}

const region = awsEnv().AWS_REGION;
const roleName = 'hw31-gha-teardown';
const role = awsJson(['iam', 'get-role', '--role-name', roleName, '--region', region]);
const policy = awsJson([
  'iam',
  'get-role-policy',
  '--role-name',
  roleName,
  '--policy-name',
  'gha-teardown',
  '--region',
  region,
]);

const document = {
  Role: {
    ...role.Role,
    AssumeRolePolicyDocument: decoded(role.Role.AssumeRolePolicyDocument),
  },
  Policy: decoded(policy.PolicyDocument),
};
mkdirSync(dirname(evidence('iam.json')), { recursive: true });
writeFileSync(evidence('iam.json'), `${JSON.stringify(document, null, 2)}\n`);

const arn = role.Role.Arn;
function decision(action) {
  const result = awsJson([
    'iam',
    'simulate-principal-policy',
    '--policy-source-arn',
    arn,
    '--action-names',
    action,
    '--region',
    region,
  ]);
  return result.EvaluationResults?.[0]?.EvalDecision ?? 'missing';
}

replaceLines(evidence('iam.txt'), [
  `sim-allowed=${decision('rds:DescribeDBInstances')}`,
  `sim-denied=${decision('iam:CreateUser')}`,
]);
