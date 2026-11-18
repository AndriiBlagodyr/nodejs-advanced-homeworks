#!/usr/bin/env node
// Three tokens signed by a key this process just generated. The gate under
// test is scripts/oidc-gate.mjs — the same file the pipeline runs.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ALLOWED = 'repo:AndriiBlagodyr@44027355/nodejs-advanced-homeworks@1345837420:*';
const GREEN_SUB = 'repo:AndriiBlagodyr@44027355/nodejs-advanced-homeworks@1345837420:ref:refs/heads/hw-32';
const FOREIGN_SUB = 'repo:other-org/other-repo:ref:refs/heads/main';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'hw32';
jwk.alg = 'RS256';
jwk.use = 'sig';

let issuer = '';
const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (url.startsWith('/.well-known/openid-configuration')) {
    const body = JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  if (url.startsWith('/jwks')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('jwks server did not bind');
issuer = `http://127.0.0.1:${address.port}`;

function b64url(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.toString('base64url');
}

function mint(sub) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'hw32' }));
  const payload = b64url(JSON.stringify({
    iss: issuer,
    aud: 'hw32-deploy',
    sub,
    iat: now,
    nbf: now - 10,
    exp: now + 600,
  }));
  const data = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(data), privateKey);
  return `${data}.${b64url(signature)}`;
}

function corrupt(token) {
  const parts = token.split('.');
  const bytes = Buffer.from(parts[2], 'base64url');
  bytes[0] ^= 0xff;
  parts[2] = b64url(bytes);
  return parts.join('.');
}

const dir = mkdtempSync(join(tmpdir(), 'hw32-oidc-'));
const policyPath = join(dir, 'policy.json');
writeFileSync(policyPath, JSON.stringify({ iss: issuer, aud: 'hw32-deploy', sub: [ALLOWED] }));

function runCase(name, token) {
  const tokenPath = join(dir, `${name}.jwt`);
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts/oidc-gate.mjs')], {
      env: {
        ...process.env,
        OIDC_TOKEN_FILE: tokenPath,
        OIDC_POLICY: policyPath,
        OIDC_ISSUER: issuer,
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('close', () => {
      console.log(`case=${name}`);
      for (const line of stdout.split('\n')) {
        if (line.startsWith('sig-verified=') || line.startsWith('policy-allow=')) console.log(line);
      }
      resolve(stdout);
    });
  });
}

try {
  const green = await runCase('green', mint(GREEN_SUB));
  const foreign = await runCase('foreign-sub', mint(FOREIGN_SUB));
  const bad = await runCase('bad-signature', corrupt(mint(GREEN_SUB)));
  const ok = green.includes('sig-verified=1') && green.includes('policy-allow=1')
    && foreign.includes('sig-verified=1') && foreign.includes('policy-allow=0')
    && bad.includes('sig-verified=0') && bad.includes('policy-allow=0');
  if (!ok) process.exitCode = 1;
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
