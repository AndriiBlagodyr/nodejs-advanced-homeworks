import { generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Throwaway signing key for the older demos (HW-22 outbox, HW-23 session and
 * rate limit) and the tests, which boot the app but are not about auth. The
 * application has no default key: this lives outside src/auth, fills only this
 * process's environment, and never writes a file. If the real variables are
 * set, they are left alone. demo:auth, demo:reuse and demo:rbac never call it.
 */
export function ensureEphemeralAuthEnv(): void {
  const complete =
    process.env.JWT_PRIVATE_KEY?.trim() &&
    process.env.JWT_PUBLIC_KEY?.trim() &&
    process.env.JWT_KID?.trim() &&
    process.env.REFRESH_TOKEN_PEPPER?.trim();
  if (complete) return;

  const keys = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.JWT_KID = 'ephemeral';
  process.env.JWT_PRIVATE_KEY = Buffer.from(keys.privateKey).toString('base64');
  process.env.JWT_PUBLIC_KEY = Buffer.from(keys.publicKey).toString('base64');
  process.env.REFRESH_TOKEN_PEPPER = randomBytes(32).toString('base64url');
}
