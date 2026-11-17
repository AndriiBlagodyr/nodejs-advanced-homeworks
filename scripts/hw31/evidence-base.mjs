import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { awsEnv, awsJson, evidence, pulumiOutput, root } from './run.mjs';

const output = pulumiOutput('base');
const vpcId = output.vpcId;
const publicIds = output.publicSubnetIds;
const privateIds = new Set(output.privateSubnetIds);
const region = awsEnv().AWS_REGION;

const subnets = awsJson([
  'ec2',
  'describe-subnets',
  '--region',
  region,
  '--subnet-ids',
  ...publicIds,
  ...output.privateSubnetIds,
]);
const zones = new Set(subnets.Subnets.map((subnet) => subnet.AvailabilityZone));

const tables = awsJson([
  'ec2',
  'describe-route-tables',
  '--region',
  region,
  '--filters',
  `Name=vpc-id,Values=${vpcId}`,
]);
let privateDefaultRoute = 0;
for (const table of tables.RouteTables ?? []) {
  const ownsPrivate = (table.Associations ?? []).some((item) => privateIds.has(item.SubnetId));
  if (!ownsPrivate) continue;
  for (const route of table.Routes ?? []) {
    if (route.DestinationCidrBlock === '0.0.0.0/0' && String(route.GatewayId ?? '').startsWith('igw-')) {
      privateDefaultRoute += 1;
    }
  }
}

const groups = awsJson([
  'ec2',
  'describe-security-groups',
  '--region',
  region,
  '--filters',
  `Name=vpc-id,Values=${vpcId}`,
]);
const tagged = awsJson([
  'resourcegroupstaggingapi',
  'get-resources',
  '--region',
  region,
  '--tag-filters',
  'Key=Project,Values=nodejs-pro-hw31',
  'Key=Stack,Values=base',
]);

const lines = [
  `vpc-id=${vpcId}`,
  `public-subnets=${publicIds.length}`,
  `private-subnets=${output.privateSubnetIds.length}`,
  `subnet-azs=${zones.size}`,
  `private-default-route=${privateDefaultRoute}`,
  `security-groups=${groups.SecurityGroups.length}`,
  `tagged-resources=${tagged.ResourceTagMappingList.length}`,
];
mkdirSync(dirname(evidence('base.txt')), { recursive: true });
writeFileSync(evidence('base.txt'), `${lines.join('\n')}\n`);
const exported = execFileSync('pulumi', ['stack', 'export', '--stack', 'base', '--non-interactive'], {
  cwd: `${root}/infra/base`,
  env: awsEnv(),
  encoding: 'utf8',
});
writeFileSync(evidence('base-state.json'), exported);
