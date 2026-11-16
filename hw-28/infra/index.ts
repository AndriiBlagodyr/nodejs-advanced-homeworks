import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { loadNames, loadVaultSecrets, parseProfile } from './config';

// First action, before any provider exists: a missing vault value fails here,
// by name, instead of as a cluster or connection error further down.
const secretValues = loadVaultSecrets(process.env);

const config = new pulumi.Config();
const profile = parseProfile(config.get('profile') ?? 'hardened');
const rev = config.get('rev') ?? '1';
const replicas = config.getNumber('replicas') ?? 3;
const names = loadNames();

const PORT = 3000;
const DB_USER = 'app';
const DB_NAME = 'marketplace';
const LIVENESS_PATH = '/healthz';
const READINESS_PATH = '/readyz';
/** Distroless `nonroot`. A number: kubelet does not resolve user names. */
const NONROOT_UID = 65532;
const CLOSE_TIMEOUT_MS = 10_000;
/** Above drain + close timeout, so SIGKILL never lands in the middle of a drain. */
const GRACE_SECONDS = 30;

if (GRACE_SECONDS * 1000 <= profile.drainMs + CLOSE_TIMEOUT_MS) {
  throw new Error('terminationGracePeriodSeconds must exceed drain + close timeout');
}
if (profile.probes && replicas < 2) {
  throw new Error('replicas must be >= 2: a PDB over one replica protects nothing');
}

// Pinned to the kind context: a stray current-context never receives this stack.
// Secrets mutable: by default a change in `data` replaces the Secret, and
// everything that references it by name is replaced with it — including the
// Deployment, which is then deleted and recreated instead of rolled.
const provider = new k8s.Provider('kind', { context: names.context, enableSecretMutable: true });
const opts = { provider };

const ns = new k8s.core.v1.Namespace('ns', { metadata: { name: names.namespace } }, opts);
const namespace = ns.metadata.name;
const appLabels = { app: names.app };
const pgLabels = { app: 'postgres' };

// `data` (base64), not `stringData`: stringData is write-only, so every `up`
// would see a diff. Do not wrap each value in pulumi.secret(): that stores
// `data` as one ciphertext in state, and a new nonce on every encrypt shows
// up as `~data` even when the values did not change. The passphrase still
// encrypts the state file as a whole.
const secret = new k8s.core.v1.Secret(
  'app-secrets',
  {
    metadata: { name: `${names.app}-secrets`, namespace },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(secretValues).map(([key, value]) => [
        key,
        Buffer.from(value, 'utf8').toString('base64'),
      ]),
    ),
  },
  opts,
);

const fromSecret = (envName: string, key: keyof typeof secretValues) => ({
  name: envName,
  valueFrom: { secretKeyRef: { name: secret.metadata.name, key } },
});

const postgres = new k8s.apps.v1.Deployment(
  'postgres',
  {
    metadata: { name: 'postgres', namespace },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: pgLabels },
      template: {
        metadata: { labels: pgLabels },
        spec: {
          containers: [
            {
              name: 'postgres',
              image: names.postgresImage,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ containerPort: 5432 }],
              env: [
                { name: 'POSTGRES_USER', value: DB_USER },
                { name: 'POSTGRES_DB', value: DB_NAME },
                fromSecret('POSTGRES_PASSWORD', 'DB_PASSWORD'),
                { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
              ],
              readinessProbe: {
                exec: { command: ['pg_isready', '-U', DB_USER, '-d', DB_NAME] },
                periodSeconds: 2,
              },
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
              volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
            },
          ],
          volumes: [{ name: 'data', emptyDir: {} }],
        },
      },
    },
  },
  opts,
);

const postgresService = new k8s.core.v1.Service(
  'postgres',
  {
    metadata: { name: 'postgres', namespace },
    spec: { selector: pgLabels, ports: [{ port: 5432, targetPort: 5432 }] },
  },
  opts,
);

const probes = profile.probes
  ? {
      // Short period: a draining pod leaves the endpoints within about a second.
      readinessProbe: {
        httpGet: { path: READINESS_PATH, port: PORT },
        periodSeconds: 1,
        failureThreshold: 1,
        timeoutSeconds: 1,
      },
      // Only "is the event loop alive". Never the readiness path.
      livenessProbe: {
        httpGet: { path: LIVENESS_PATH, port: PORT },
        periodSeconds: 10,
        failureThreshold: 3,
        timeoutSeconds: 2,
      },
      // Until it passes, liveness and readiness are off: 60 s to warm up, then never again.
      startupProbe: {
        httpGet: { path: LIVENESS_PATH, port: PORT },
        periodSeconds: 1,
        failureThreshold: 60,
      },
    }
  : {};

const deployment = new k8s.apps.v1.Deployment(
  'api',
  {
    metadata: { name: names.app, namespace, labels: appLabels },
    spec: {
      // HPA owns this in a cluster with metrics-server; see README "replicas vs HPA".
      replicas,
      selector: { matchLabels: appLabels },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: profile.maxSurge, maxUnavailable: profile.maxUnavailable },
      },
      template: {
        metadata: { labels: appLabels },
        spec: {
          terminationGracePeriodSeconds: GRACE_SECONDS,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: NONROOT_UID,
            runAsGroup: NONROOT_UID,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: names.app,
              image: names.image,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'http', containerPort: PORT }],
              env: [
                { name: 'PORT', value: String(PORT) },
                // Changing it changes the pod template, which is what starts a rollout.
                { name: 'REV', value: rev },
                { name: 'DRAIN_MS', value: String(profile.drainMs) },
                { name: 'CLOSE_TIMEOUT_MS', value: String(CLOSE_TIMEOUT_MS) },
                { name: 'WARMUP_MS', value: '4000' },
                { name: 'DB_HOST', value: postgresService.metadata.name },
                { name: 'DB_PORT', value: '5432' },
                { name: 'DB_USER', value: DB_USER },
                { name: 'DB_NAME', value: DB_NAME },
                fromSecret('DB_PASSWORD', 'DB_PASSWORD'),
                fromSecret('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY'),
                fromSecret('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY'),
                fromSecret('JWT_KID', 'JWT_KID'),
                fromSecret('REFRESH_TOKEN_PEPPER', 'REFRESH_TOKEN_PEPPER'),
              ],
              ...probes,
              resources: {
                requests: { cpu: '100m', memory: '160Mi' },
                limits: { memory: '320Mi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
        },
      },
    },
  },
  { ...opts, dependsOn: [postgres] },
);

const service = new k8s.core.v1.Service(
  'api',
  {
    metadata: { name: names.app, namespace, labels: appLabels },
    spec: {
      type: 'NodePort',
      selector: appLabels,
      ports: [{ name: 'http', port: 80, targetPort: PORT, nodePort: names.nodePort }],
    },
  },
  opts,
);

// minAvailable below replicas: one voluntary disruption (a node drain) is allowed, a second waits.
const pdb = new k8s.policy.v1.PodDisruptionBudget(
  'api',
  {
    metadata: { name: names.app, namespace },
    spec: { minAvailable: replicas - 1, selector: { matchLabels: appLabels } },
  },
  opts,
);

const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
  'api',
  {
    metadata: { name: names.app, namespace },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment.metadata.name },
      minReplicas: 2,
      maxReplicas: 6,
      metrics: [
        {
          type: 'Resource',
          resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } },
        },
      ],
    },
  },
  opts,
);

export const profileName = profile.id === 1 ? 'hardened' : 'broken';
export const revision = rev;
export const namespaceName = namespace;
export const deploymentName = deployment.metadata.name;
export const serviceName = service.metadata.name;
export const pdbName = pdb.metadata.name;
export const hpaName = hpa.metadata.name;
export const url = `http://127.0.0.1:${names.hostPort}`;
