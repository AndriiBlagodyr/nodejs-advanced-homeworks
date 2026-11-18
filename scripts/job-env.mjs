#!/usr/bin/env node
// One-job values for the kind deploy. Written to GITHUB_ENV, not to the log.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const envFile = process.env.GITHUB_ENV;
if (!envFile) {
  console.error('GITHUB_ENV is not set');
  process.exit(2);
}

const keys = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const lines = [
  `APP_DB_PASSWORD=${randomBytes(18).toString('hex')}`,
  `JWT_PRIVATE_KEY=${Buffer.from(keys.privateKey).toString('base64')}`,
  `JWT_PUBLIC_KEY=${Buffer.from(keys.publicKey).toString('base64')}`,
  'JWT_KID=ci',
  `REFRESH_TOKEN_PEPPER=${randomBytes(32).toString('hex')}`,
  `PULUMI_CONFIG_PASSPHRASE=${randomBytes(16).toString('hex')}`,
];
appendFileSync(envFile, `${lines.join('\n')}\n`);
console.log('job secrets generated');
