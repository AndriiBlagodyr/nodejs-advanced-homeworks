#!/usr/bin/env node
// npm run scan — scan the image, count findings from the report, compare with SCAN_MAX.
//
//   SCAN_MAX=<n> npm run scan        # gate=pass and exit 0 iff found <= n
//
// The verdict is computed from the scanner's JSON, never printed as a fixed
// string: SCAN_MAX=-1 must fail and SCAN_MAX=99999 must pass on the same image.
// Optional: SCAN_SEVERITY (default CRITICAL,HIGH), SCAN_FIXABLE_ONLY (default
// 1: only findings with a fixed version, i.e. something we could act on),
// SCAN_IMAGE (default the image from k8s/names.json), SCAN_REPORT (keep the
// raw JSON there, e.g. as a CI artifact).

import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const TRIVY_IMAGE = 'aquasec/trivy:0.76.1';
const CACHE_VOLUME = 'hw28-trivy-cache';

function exitWith(code, message) {
  console.error(message);
  process.exit(code);
}

const rawMax = process.env.SCAN_MAX?.trim();
if (!rawMax) exitWith(2, 'missing required SCAN_MAX (max allowed findings; no default on purpose)');
if (!/^-?\d+$/.test(rawMax)) exitWith(2, `SCAN_MAX must be an integer, got "${rawMax}"`);
const maxAllowed = Number(rawMax);
const severities = (process.env.SCAN_SEVERITY ?? 'CRITICAL,HIGH').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
const fixableOnly = (process.env.SCAN_FIXABLE_ONLY ?? '1') === '1';
const image = process.env.SCAN_IMAGE ?? JSON.parse(readFileSync(join(ROOT, 'k8s', 'names.json'), 'utf8')).image;

async function docker(args, timeout) {
  return execFileP('docker', args, { maxBuffer: 64 * 1024 * 1024, timeout, killSignal: 'SIGKILL' });
}

const dir = mkdtempSync(join(tmpdir(), 'hw28-scan-'));
let report;
try {
  try {
    await docker(['image', 'inspect', image], 30_000);
  } catch {
    exitWith(2, `image ${image} not found: run npm run image:build first`);
  }
  await docker(['save', '-o', join(dir, 'image.tar'), image], 300_000);
  const args = [
    'run', '--rm',
    '-v', `${dir}:/scan`,
    '-v', `${CACHE_VOLUME}:/root/.cache/trivy`,
    TRIVY_IMAGE,
    'image', '--input', '/scan/image.tar',
    '--scanners', 'vuln',
    '--severity', severities.join(','),
    '--format', 'json', '--output', '/scan/report.json',
    '--quiet',
  ];
  if (fixableOnly) args.push('--ignore-unfixed');
  try {
    await docker(args, 900_000);
  } catch (err) {
    exitWith(2, `scanner failed, no verdict: ${err.stderr || err.message}`);
  }
  report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  if (process.env.SCAN_REPORT) copyFileSync(join(dir, 'report.json'), process.env.SCAN_REPORT);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Counted here from the data, filters applied again, one finding per CVE+package+version.
const findings = new Map();
for (const result of report.Results ?? []) {
  for (const v of result.Vulnerabilities ?? []) {
    if (!severities.includes(v.Severity)) continue;
    if (fixableOnly && !v.FixedVersion) continue;
    findings.set(`${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`, v.Severity);
  }
}
const found = findings.size;
const pass = found <= maxAllowed;

console.log(`image=${image}`);
console.log(`scanner=${TRIVY_IMAGE}`);
console.log(`severity=${severities.join(',')}`);
console.log(`fixable-only=${fixableOnly ? 1 : 0}`);
for (const s of severities) console.log(`${s.toLowerCase()}=${[...findings.values()].filter((x) => x === s).length}`);
console.log(`found=${found}`);
console.log(`max-allowed=${maxAllowed}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
process.exit(pass ? 0 : 1);
