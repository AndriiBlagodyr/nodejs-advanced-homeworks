import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vault values (HW-11), brought into the process by scripts/with-secrets.sh.
 * Env name → key in the K8s Secret. No defaults: a missing one stops the
 * program before it talks to the cluster, and the error names it.
 */
export const VAULT_VARS = {
  APP_DB_PASSWORD: 'DB_PASSWORD',
  JWT_PRIVATE_KEY: 'JWT_PRIVATE_KEY',
  JWT_PUBLIC_KEY: 'JWT_PUBLIC_KEY',
  JWT_KID: 'JWT_KID',
  REFRESH_TOKEN_PEPPER: 'REFRESH_TOKEN_PEPPER',
} as const;

export type SecretData = Record<(typeof VAULT_VARS)[keyof typeof VAULT_VARS], string>;

export function loadVaultSecrets(env: NodeJS.ProcessEnv): SecretData {
  const names = Object.keys(VAULT_VARS) as Array<keyof typeof VAULT_VARS>;
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing required secret: ${missing.join(', ')} (vault, via scripts/with-secrets.sh)`);
  }
  const out = {} as SecretData;
  for (const name of names) out[VAULT_VARS[name]] = env[name]!.trim();
  return out;
}

export type Names = {
  cluster: string;
  context: string;
  namespace: string;
  app: string;
  image: string;
  postgresImage: string;
  nodePort: number;
  hostPort: number;
};

/** Shared with the shell scripts and the demos. */
export function loadNames(): Names {
  return JSON.parse(readFileSync(join(__dirname, '..', 'k8s', 'names.json'), 'utf8')) as Names;
}

export type Profile = {
  /** Printed by demo:rollout as `profile=`: 1 hardened, 0 broken. */
  id: 0 | 1;
  maxSurge: number;
  maxUnavailable: number;
  probes: boolean;
  drainMs: number;
};

/**
 * `broken` is the control run: no probes, a pod may go down before its
 * replacement is up, and SIGTERM closes the socket at once. Same image.
 */
export const PROFILES: Record<'hardened' | 'broken', Profile> = {
  hardened: { id: 1, maxSurge: 1, maxUnavailable: 0, probes: true, drainMs: 5000 },
  broken: { id: 0, maxSurge: 1, maxUnavailable: 1, probes: false, drainMs: 0 },
};

export function parseProfile(raw: string): Profile {
  if (raw !== 'hardened' && raw !== 'broken') {
    throw new Error(`config profile must be "hardened" or "broken", got "${raw}"`);
  }
  return PROFILES[raw];
}
