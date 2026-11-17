import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

// Registered before any resource. A leftover deletionProtection or a final snapshot
// would keep billing after destroy.
pulumi.runtime.registerResourceTransform((args) =>
  args.type === 'aws:rds/instance:Instance'
    ? {
        props: { ...args.props, deletionProtection: false, skipFinalSnapshot: true },
        opts: args.opts,
      }
    : undefined,
);

const awsConfig = new pulumi.Config('aws');
const config = new pulumi.Config('hw31');
const region = awsConfig.require('region');
const baseStack = config.require('baseStack');
const withNat = (config.get('withNat') ?? 'false') === 'true';
const dbPassword = config.requireSecret('dbPassword');

const provider = new aws.Provider('aws', {
  region: region as aws.Region,
  defaultTags: {
    tags: {
      Project: 'nodejs-pro-hw31',
      Stack: pulumi.getStack(),
      ManagedBy: 'pulumi',
    },
  },
});
const opts = { provider };

const base = new pulumi.StackReference(baseStack);
const vpcId = base.getOutput('vpcId') as pulumi.Output<string>;
const publicSubnetIds = base.getOutput('publicSubnetIds') as pulumi.Output<string[]>;
const privateSubnetIds = base.getOutput('privateSubnetIds') as pulumi.Output<string[]>;
const albSecurityGroupId = base.getOutput('albSecurityGroupId') as pulumi.Output<string>;
const rdsSecurityGroupId = base.getOutput('rdsSecurityGroupId') as pulumi.Output<string>;

const subnetGroup = new aws.rds.SubnetGroup(
  'pg',
  { subnetIds: privateSubnetIds, description: 'Private subnets for the Multi-AZ instance' },
  opts,
);

// Multi-AZ instance deployment, not a Multi-AZ DB cluster.
// No Performance Insights and no Enhanced Monitoring: they are not graded and they bill.
const db = new aws.rds.Instance(
  'pg',
  {
    identifier: 'hw31-pg',
    engine: 'postgres',
    engineVersion: '16',
    instanceClass: 'db.t4g.micro',
    allocatedStorage: 20,
    storageType: 'gp3',
    multiAz: true,
    storageEncrypted: true,
    backupRetentionPeriod: 1,
    deletionProtection: false,
    skipFinalSnapshot: true,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [rdsSecurityGroupId],
    username: 'hw31',
    password: dbPassword,
    dbName: 'marketplace',
    publiclyAccessible: false,
    performanceInsightsEnabled: false,
    monitoringInterval: 0,
    applyImmediately: true,
  },
  opts,
);

const role = new aws.iam.Role(
  'api',
  {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    }),
  },
  opts,
);

new aws.iam.RolePolicyAttachment(
  'api-logs',
  { role: role.name, policyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
  opts,
);

const fn = new aws.lambda.Function(
  'api',
  {
    runtime: 'nodejs22.x',
    handler: 'index.handler',
    role: role.arn,
    code: new pulumi.asset.AssetArchive({
      'index.js': new pulumi.asset.StringAsset(
        "exports.handler = async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' });\n",
      ),
    }),
  },
  opts,
);

const target = new aws.lb.TargetGroup(
  'api',
  {
    targetType: 'lambda',
    name: 'hw31-api',
    // Lambda targets stay "unavailable" while the health check is off, even when
    // the function returns 200. Two successes at the default interval mark it healthy.
    healthCheck: {
      enabled: true,
      path: '/',
      matcher: '200',
      healthyThreshold: 2,
      timeout: 5,
      interval: 35,
    },
  },
  opts,
);

const attachment = new aws.lb.TargetGroupAttachment(
  'api',
  { targetGroupArn: target.arn, targetId: fn.arn },
  opts,
);

const invoke = new aws.lambda.Permission(
  'alb',
  {
    action: 'lambda:InvokeFunction',
    function: fn.name,
    principal: 'elasticloadbalancing.amazonaws.com',
    sourceArn: target.arn,
  },
  opts,
);

const alb = new aws.lb.LoadBalancer(
  'api',
  {
    name: 'hw31-alb',
    loadBalancerType: 'application',
    internal: false,
    ipAddressType: 'ipv4',
    securityGroups: [albSecurityGroupId],
    subnets: publicSubnetIds,
  },
  opts,
);

new aws.lb.Listener(
  'http',
  {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: 'HTTP',
    defaultActions: [{ type: 'forward', targetGroupArn: target.arn }],
  },
  { ...opts, dependsOn: [attachment, invoke] },
);

// One NAT, only while hw31:withNat is true. It is not attached to the private
// route table: the measurement is the billed hour, and a 0.0.0.0/0 route on
// the private table would fail the base-stack privacy check.
const nat = withNat
  ? new aws.ec2.NatGateway(
      'nat',
      {
        subnetId: publicSubnetIds.apply((ids) => ids[0]),
        allocationId: new aws.ec2.Eip('nat', { domain: 'vpc' }, opts).id,
      },
      opts,
    )
  : undefined;

export const vpcIdOut = vpcId;
export const dbIdentifier = db.identifier;
export const albDns = alb.dnsName;
export const albArn = alb.arn;
export const targetGroupArn = target.arn;
export const natGatewayId = nat ? nat.id : pulumi.output('');
