import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** A real-looking hash so a missing user takes as long as a wrong password. */
let dummy: string | undefined;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return encode(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, hash);
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const against = stored ?? (await dummyHash());
  const parts = against.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p });
  const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
  return stored !== null && matches;
}

async function dummyHash(): Promise<string> {
  if (!dummy) dummy = await hashPassword('not-a-real-password');
  return dummy;
}

function encode(n: number, r: number, p: number, salt: Buffer, hash: Buffer): string {
  return `scrypt$${n}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
