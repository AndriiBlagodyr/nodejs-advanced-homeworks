import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const awsConfig = new pulumi.Config('aws');
const config = new pulumi.Config('hw31');

// Region comes from the stack file, not from ~/.aws/config.
const region = awsConfig.require('region');
const budgetEmail = config.require('budgetEmail');
const githubRepo = config.require('githubRepo');
const stateBucket = config.require('stateBucket');

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

// First resource, and the VPC waits for it. A letter, not a brake:
// AWS refreshes the actual spend 8–12 hours later.
const budget = new aws.budgets.Budget(
  'monthly',
  {
    budgetType: 'COST',
    limitAmount: '5',
    limitUnit: 'USD',
    timeUnit: 'MONTHLY',
    notifications: [
      {
        comparisonOperator: 'GREATER_THAN',
        threshold: 20,
        thresholdType: 'PERCENTAGE',
        notificationType: 'ACTUAL',
        subscriberEmailAddresses: [budgetEmail],
      },
    ],
  },
  opts,
);

// 10.31.0.0/16 does not overlap the 10.0.0.0/16 block used by most local stacks.
const vpc = new aws.ec2.Vpc(
  'main',
  {
    cidrBlock: '10.31.0.0/16',
    enableDnsHostnames: true,
    enableDnsSupport: true,
  },
  { ...opts, dependsOn: [budget] },
);

const azs = aws.getAvailabilityZonesOutput({ state: 'available' }, { provider });
const zones = [0, 1].map((index) => azs.names.apply((names) => names[index]));

const publicCidrs = ['10.31.0.0/24', '10.31.1.0/24'];
const privateCidrs = ['10.31.10.0/24', '10.31.11.0/24'];

const publicSubnets = publicCidrs.map(
  (cidr, index) =>
    new aws.ec2.Subnet(
      `public-${index}`,
      {
        vpcId: vpc.id,
        cidrBlock: cidr,
        availabilityZone: zones[index],
        mapPublicIpOnLaunch: false,
        tags: { Tier: 'public' },
      },
      opts,
    ),
);

const privateSubnets = privateCidrs.map(
  (cidr, index) =>
    new aws.ec2.Subnet(
      `private-${index}`,
      {
        vpcId: vpc.id,
        cidrBlock: cidr,
        availabilityZone: zones[index],
        mapPublicIpOnLaunch: false,
        tags: { Tier: 'private' },
      },
      opts,
    ),
);

const igw = new aws.ec2.InternetGateway('igw', { vpcId: vpc.id }, opts);

const publicRt = new aws.ec2.RouteTable('public', { vpcId: vpc.id }, opts);
// Public subnets only. The ALB lives here and has to answer from the internet.
new aws.ec2.Route(
  'public-default',
  {
    routeTableId: publicRt.id,
    destinationCidrBlock: '0.0.0.0/0',
    gatewayId: igw.id,
  },
  opts,
);

// Private means this table has no 0.0.0.0/0 route to the IGW.
// The database does not dial out, so a NAT gateway is not created in this stack.
const privateRt = new aws.ec2.RouteTable('private', { vpcId: vpc.id }, opts);

publicSubnets.forEach((subnet, index) => {
  new aws.ec2.RouteTableAssociation(`public-${index}`, { subnetId: subnet.id, routeTableId: publicRt.id }, opts);
});
privateSubnets.forEach((subnet, index) => {
  new aws.ec2.RouteTableAssociation(`private-${index}`, { subnetId: subnet.id, routeTableId: privateRt.id }, opts);
});

// Port 80 is the only public port. This homework has no hosted zone, so there is no TLS listener.
// Port 443 egress is the ALB calling the Lambda invoke API, not a port into the VPC.
const albSg = new aws.ec2.SecurityGroup(
  'alb',
  {
    vpcId: vpc.id,
    description: 'Internet-facing load balancer',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: 80,
        toPort: 80,
        cidrBlocks: ['0.0.0.0/0'],
        description: 'HTTP from the internet. The ALB check and the health probe use this port.',
      },
    ],
    egress: [
      {
        protocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ['0.0.0.0/0'],
        description: 'HTTPS egress so the ALB can call the Lambda invoke API.',
      },
    ],
  },
  opts,
);

// Source group only. No listeners and no egress: the database does not dial out.
const clientSg = new aws.ec2.SecurityGroup(
  'db-client',
  {
    vpcId: vpc.id,
    description: 'Source group for Postgres. No listeners of its own.',
    egress: [],
  },
  opts,
);

// 5432 is PostgreSQL. The source is the client group, never 0.0.0.0/0.
const rdsSg = new aws.ec2.SecurityGroup(
  'rds',
  {
    vpcId: vpc.id,
    description: 'Postgres. Private subnets, no public address.',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: 5432,
        toPort: 5432,
        securityGroups: [clientSg.id],
        description: 'Postgres from the client security group only.',
      },
    ],
    egress: [],
  },
  opts,
);

const oidc = new aws.iam.OpenIdConnectProvider(
  'github',
  {
    url: 'https://token.actions.githubusercontent.com',
    clientIdLists: ['sts.amazonaws.com'],
    thumbprintLists: [
      '6938fd4d98bab03faadb97b34396831e3780aea1',
      '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
    ],
  },
  opts,
);

const assumeRole = pulumi.interpolate`{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${oidc.arn}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:${githubRepo}:*" }
    }
  }]
}`;

// Actions are listed. Resource "*" is only where the EC2/RDS/ELB APIs reject a resource ARN.
const teardownPolicy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'Budget',
      Effect: 'Allow',
      Action: [
        'budgets:ModifyBudget',
        'budgets:ViewBudget',
        'budgets:ListTagsForResource',
        'budgets:TagResource',
        'budgets:UntagResource',
      ],
      Resource: '*',
    },
    {
      Sid: 'Network',
      Effect: 'Allow',
      Action: [
        'ec2:DescribeAvailabilityZones',
        'ec2:DescribeVpcs',
        'ec2:DescribeVpcAttribute',
        'ec2:DescribeSubnets',
        'ec2:DescribeInternetGateways',
        'ec2:DescribeRouteTables',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeSecurityGroupRules',
        'ec2:DescribeNatGateways',
        'ec2:DescribeAddresses',
        'ec2:DescribeAddressesAttribute',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeAccountAttributes',
        'ec2:CreateVpc',
        'ec2:DeleteVpc',
        'ec2:ModifyVpcAttribute',
        'ec2:CreateSubnet',
        'ec2:DeleteSubnet',
        'ec2:ModifySubnetAttribute',
        'ec2:CreateInternetGateway',
        'ec2:DeleteInternetGateway',
        'ec2:AttachInternetGateway',
        'ec2:DetachInternetGateway',
        'ec2:CreateRouteTable',
        'ec2:DeleteRouteTable',
        'ec2:AssociateRouteTable',
        'ec2:DisassociateRouteTable',
        'ec2:CreateRoute',
        'ec2:DeleteRoute',
        'ec2:ReplaceRoute',
        'ec2:CreateSecurityGroup',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:CreateNatGateway',
        'ec2:DeleteNatGateway',
        'ec2:AllocateAddress',
        'ec2:ReleaseAddress',
        'ec2:AssociateAddress',
        'ec2:DisassociateAddress',
        'ec2:CreateTags',
        'ec2:DeleteTags',
        'ec2:DescribeTags',
      ],
      Resource: '*',
    },
    {
      Sid: 'Database',
      Effect: 'Allow',
      Action: [
        'rds:CreateDBInstance',
        'rds:DeleteDBInstance',
        'rds:DescribeDBInstances',
        'rds:ModifyDBInstance',
        'rds:RebootDBInstance',
        'rds:ListTagsForResource',
        'rds:AddTagsToResource',
        'rds:RemoveTagsFromResource',
        'rds:CreateDBSubnetGroup',
        'rds:DeleteDBSubnetGroup',
        'rds:DescribeDBSubnetGroups',
        'rds:ModifyDBSubnetGroup',
        'rds:DescribeEvents',
        'rds:DescribeOrderableDBInstanceOptions',
        'rds:DescribeDBEngineVersions',
        'rds:DescribeDBSnapshots',
        'rds:DeleteDBSnapshot',
      ],
      Resource: '*',
    },
    {
      Sid: 'LoadBalancer',
      Effect: 'Allow',
      Action: [
        'elasticloadbalancing:CreateLoadBalancer',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeLoadBalancerAttributes',
        'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets',
        'elasticloadbalancing:CreateTargetGroup',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetGroupAttributes',
        'elasticloadbalancing:ModifyTargetGroup',
        'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:DescribeTargetHealth',
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:DescribeListeners',
        'elasticloadbalancing:DescribeListenerAttributes',
        'elasticloadbalancing:DescribeRules',
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:DescribeTags',
        'elasticloadbalancing:AddTags',
        'elasticloadbalancing:RemoveTags',
      ],
      Resource: '*',
    },
    {
      Sid: 'LambdaTarget',
      Effect: 'Allow',
      Action: [
        'lambda:CreateFunction',
        'lambda:DeleteFunction',
        'lambda:GetFunction',
        'lambda:GetFunctionConfiguration',
        'lambda:GetFunctionCodeSigningConfig',
        'lambda:GetRuntimeManagementConfig',
        'lambda:UpdateFunctionCode',
        'lambda:UpdateFunctionConfiguration',
        'lambda:AddPermission',
        'lambda:RemovePermission',
        'lambda:GetPolicy',
        'lambda:ListVersionsByFunction',
        'lambda:TagResource',
        'lambda:UntagResource',
        'lambda:ListTags',
      ],
      Resource: '*',
    },
    {
      Sid: 'RolesForThisStack',
      Effect: 'Allow',
      Action: [
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:GetRole',
        'iam:GetPolicy',
        'iam:GetPolicyVersion',
        'iam:UpdateAssumeRolePolicy',
        'iam:PassRole',
        'iam:TagRole',
        'iam:UntagRole',
        'iam:ListRolePolicies',
        'iam:PutRolePolicy',
        'iam:GetRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:ListAttachedRolePolicies',
        'iam:AttachRolePolicy',
        'iam:DetachRolePolicy',
        'iam:ListInstanceProfilesForRole',
        'iam:CreateOpenIDConnectProvider',
        'iam:DeleteOpenIDConnectProvider',
        'iam:GetOpenIDConnectProvider',
        'iam:ListOpenIDConnectProviders',
        'iam:TagOpenIDConnectProvider',
        'iam:UntagOpenIDConnectProvider',
        'iam:UpdateOpenIDConnectProviderThumbprint',
      ],
      Resource: '*',
    },
    {
      Sid: 'FindLeftovers',
      Effect: 'Allow',
      Action: ['tag:GetResources'],
      Resource: '*',
    },
    {
      Sid: 'StateBucket',
      Effect: 'Allow',
      Action: [
        's3:ListBucket',
        's3:GetBucketLocation',
        's3:GetBucketVersioning',
        's3:ListBucketVersions',
        's3:ListBucketMultipartUploads',
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
        's3:GetObjectVersion',
        's3:DeleteObjectVersion',
      ],
      Resource: [`arn:aws:s3:::${stateBucket}`, `arn:aws:s3:::${stateBucket}/*`],
    },
  ],
};

const ciRole = new aws.iam.Role(
  'gha-teardown',
  {
    name: 'hw31-gha-teardown',
    assumeRolePolicy: assumeRole,
    description: 'GitHub Actions OIDC role that destroys the HW-31 stacks.',
  },
  opts,
);

new aws.iam.RolePolicy(
  'gha-teardown',
  {
    name: 'gha-teardown',
    role: ciRole.id,
    policy: JSON.stringify(teardownPolicy),
  },
  opts,
);

export const vpcId = vpc.id;
export const publicSubnetIds = pulumi.output(publicSubnets.map((subnet) => subnet.id));
export const privateSubnetIds = pulumi.output(privateSubnets.map((subnet) => subnet.id));
export const albSecurityGroupId = albSg.id;
export const rdsSecurityGroupId = rdsSg.id;
export const ciRoleArn = ciRole.arn;
export const regionName = region;
