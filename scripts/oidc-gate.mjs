#!/usr/bin/env node
// Verifies a GitHub-style OIDC token: signature against the issuer's JWKS,
// then iss, aud and sub against a policy file. Prints the claims, never the token.
//
//   OIDC_ISSUER   issuer URL; discovery is fetched from here
//   OIDC_POLICY   path to the policy JSON (iss, aud, sub)
//   OIDC_TOKEN_FILE   token to check (local demo)
//   or ACTIONS_ID_TOKEN_REQUEST_URL + ACTIONS_ID_TOKEN_REQUEST_TOKEN
//      and OIDC_AUDIENCE (the CI job)

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

function deny(claims) {
  const aud = Array.isArray(claims.aud) ? claims.aud.join(',') : (claims.aud ?? '');
  console.log(`iss=${claims.iss ?? ''}`);
  console.log(`aud=${aud}`);
  console.log(`sub=${claims.sub ?? ''}`);
  console.log('sig-verified=0');
  console.log('policy-allow=0');
  process.exit(1);
}

function matchSub(sub, pattern) {
  const star = pattern.indexOf('*');
  if (star < 0) return sub === pattern;
  if (pattern.indexOf('*', star + 1) >= 0) return false;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return sub.startsWith(prefix) && sub.endsWith(suffix) && sub.length >= prefix.length + suffix.length;
}

function policyAllows(claims, policy) {
  if (claims.iss !== policy.iss) return false;
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(policy.aud) : claims.aud === policy.aud;
  if (!audOk) return false;
  const patterns = Array.isArray(policy.sub) ? policy.sub : [policy.sub];
  return patterns.some((pattern) => typeof pattern === 'string' && matchSub(String(claims.sub ?? ''), pattern));
}

async function loadToken() {
  if (process.env.OIDC_TOKEN_FILE) return readFileSync(process.env.OIDC_TOKEN_FILE, 'utf8').trim();
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const audience = process.env.OIDC_AUDIENCE;
  if (!url || !bearer || !audience) {
    console.error('no token: set OIDC_TOKEN_FILE or the Actions id-token request env');
    process.exit(2);
  }
  const endpoint = `${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
  const response = await fetch(endpoint, { headers: { Authorization: `bearer ${bearer}` } });
  if (!response.ok) {
    console.error('id-token request failed');
    process.exit(2);
  }
  const body = await response.json();
  if (typeof body.value !== 'string' || body.value.split('.').length !== 3) {
    console.error('id-token request failed');
    process.exit(2);
  }
  return body.value;
}

async function signatureOk(token, issuer) {
  const parts = token.split('.');
  if (parts.length !== 3) return { claims: {}, ok: false };
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { claims: {}, ok: false };
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { claims, ok: false };
  const discoveryRes = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!discoveryRes.ok) return { claims, ok: false };
  const discovery = await discoveryRes.json();
  if (discovery.issuer !== issuer || typeof discovery.jwks_uri !== 'string') return { claims, ok: false };
  if (claims.iss !== discovery.issuer) return { claims, ok: false };
  const jwksRes = await fetch(discovery.jwks_uri);
  if (!jwksRes.ok) return { claims, ok: false };
  const jwks = await jwksRes.json();
  const jwk = (jwks.keys ?? []).find((key) => key.kid === header.kid && (key.use === undefined || key.use === 'sig'));
  if (!jwk) return { claims, ok: false };
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  let ok = false;
  try {
    ok = verify('sha256', signed, key, Buffer.from(parts[2], 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return { claims, ok: false };
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now - 60) return { claims, ok: false };
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return { claims, ok: false };
  return { claims, ok: true };
}

async function main() {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, '');
  const policyPath = process.env.OIDC_POLICY;
  if (!issuer || !policyPath) {
    console.error('OIDC_ISSUER and OIDC_POLICY are required');
    process.exit(2);
  }
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const token = await loadToken();
  const { claims, ok } = await signatureOk(token, issuer);
  const allow = ok && policyAllows(claims, policy);
  const aud = Array.isArray(claims.aud) ? claims.aud.join(',') : (claims.aud ?? '');
  console.log(`iss=${claims.iss ?? ''}`);
  console.log(`aud=${aud}`);
  console.log(`sub=${claims.sub ?? ''}`);
  console.log(`sig-verified=${ok ? 1 : 0}`);
  console.log(`policy-allow=${allow ? 1 : 0}`);
  process.exit(allow ? 0 : 1);
}

main().catch(() => deny({}));
