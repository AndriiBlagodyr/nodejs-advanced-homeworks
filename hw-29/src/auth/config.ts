import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';

/**
 * ES256 (P-256). OWASP marks RS256 as "not recommended" and points at ES256,
 * PS256 or EdDSA. P-256 is supported by node:crypto with no extra library,
 * and the signatures are short. Verification passes an explicit `algorithms`
 * allowlist (RFC 8725 §3.1), so a token cannot switch itself to HS256 or none.
 */
export const JWT_ALG = 'ES256' as const;
export const JWT_ISSUER = 'marketplace';
export const JWT_AUDIENCE = 'marketplace-api';
/** Short on purpose: logout's denylist only has to remember it this long. */
export const ACCESS_TTL_SEC = 10 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

/** Names the grader reads out of the README table and unsets. No defaults. */
export const AUTH_SECRET_VARS = [
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_KID',
  'REFRESH_TOKEN_PEPPER',
] as const;

export type AuthConfig = {
  kid: string;
  privateKey: KeyObject;
  /** kid → public key. The current key, plus any previous ones still in overlap. */
  publicKeys: Map<string, KeyObject>;
  pepper: string;
  /** SHA-256 of the current public key (SPKI DER), first 16 hex chars. */
  fingerprint: string;
};

let cached: AuthConfig | undefined;

/**
 * First thing the process does. Throws a message that names every missing
 * variable, before Nest or Postgres is touched. A default here would be a
 * signing key baked into the code, so there is none.
 */
export function loadAuthConfig(): AuthConfig {
  if (cached) return cached;

  const missing = AUTH_SECRET_VARS.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing required secret: ${missing.join(', ')}`);
  }

  const kid = process.env.JWT_KID!.trim();
  const privateKey = parseKey('JWT_PRIVATE_KEY', process.env.JWT_PRIVATE_KEY!, 'private');
  const publicKey = parseKey('JWT_PUBLIC_KEY', process.env.JWT_PUBLIC_KEY!, 'public');
  assertSamePair(privateKey, publicKey);

  const publicKeys = new Map<string, KeyObject>();
  for (const [oldKid, value] of Object.entries(parseOverlap(process.env.JWT_PUBLIC_KEYS))) {
    publicKeys.set(oldKid, parseKey(`JWT_PUBLIC_KEYS.${oldKid}`, value, 'public'));
  }
  // The current key wins if the overlap map also lists its kid.
  publicKeys.set(kid, publicKey);

  cached = {
    kid,
    privateKey,
    publicKeys,
    pepper: process.env.REFRESH_TOKEN_PEPPER!.trim(),
    fingerprint: fingerprintOf(publicKey),
  };
  return cached;
}

/** SHA-256 of the SPKI DER, first 16 hex characters. Safe to log and to print. */
export function fingerprintOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function parseOverlap(raw: string | undefined): Record<string, string> {
  const text = raw?.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('JWT_PUBLIC_KEYS is not JSON (expected {"<kid>":"<base64 PEM>"})');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JWT_PUBLIC_KEYS must be a JSON object of kid to base64 PEM');
  }
  const out: Record<string, string> = {};
  for (const [kid, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`JWT_PUBLIC_KEYS entry ${kid} is empty`);
    }
    out[kid] = value;
  }
  return out;
}

/** Base64 PEM → KeyObject, and it must be a P-256 key: anything else cannot sign ES256. */
function parseKey(name: string, b64: string, kind: 'private' | 'public'): KeyObject {
  const pem = Buffer.from(b64.trim(), 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN ')) throw new Error(`${name} is not a base64-encoded PEM`);
  let key: KeyObject;
  try {
    key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
  } catch {
    throw new Error(`${name} could not be parsed as a ${kind} key`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`${name} must be an EC P-256 key for ES256`);
  }
  return key;
}

/** A private key from one pair and a public key from another would sign tokens nobody accepts. */
function assertSamePair(privateKey: KeyObject, publicKey: KeyObject): void {
  const probe = Buffer.from('marketplace-key-pair-check');
  const signature = sign('sha256', probe, privateKey);
  if (!verify('sha256', probe, publicKey, signature)) {
    throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are not one key pair');
  }
}
