#!/usr/bin/env node
// Four gates, each on a good input and on a real defect of the kind it exists to catch.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function report(name, ok, broken) {
  console.log(`${name}-ok=${ok.status}`);
  console.log(`${name}-broken=${broken.status}`);
  if (ok.status !== 0) {
    console.error(`\n${name} ok side failed\n${ok.stdout}\n${ok.stderr}`);
  }
  if (broken.status === 0) {
    console.error(`\n${name} broken side passed\n${broken.stdout}\n${broken.stderr}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'hw32-gates-'));
const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const forbidden = join(ROOT, 'src', 'products', 'hw32-forbidden-import.ts');

try {
  const typesOkTsc = run([tsc, '--noEmit', '--pretty', 'false', '--incremental', 'false']);
  const typesOkLint = run([join(ROOT, 'scripts', 'style-lint.mjs'), 'src']);
  const typesOk = typesOkTsc.status === 0 ? typesOkLint : typesOkTsc;
  writeFileSync(join(tmp, 'bad.ts'), 'export const amount: number = "broken";\n');
  writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'commonjs',
      noEmit: true,
      skipLibCheck: true,
    },
    files: ['bad.ts'],
  }));
  const typesBroken = run([tsc, '--pretty', 'false', '-p', join(tmp, 'tsconfig.json')]);
  report('types', typesOk, typesBroken);

  const contractOk = run([join(ROOT, 'scripts', 'contract-diff.mjs'), 'openapi.yaml', 'openapi.yaml']);
  const brokenSpec = join(tmp, 'broken.yaml');
  const spec = readFileSync(join(ROOT, 'openapi.yaml'), 'utf8').replace('\n  /products:\n', '\n  /catalog-removed:\n');
  writeFileSync(brokenSpec, spec);
  const contractBroken = run([join(ROOT, 'scripts', 'contract-diff.mjs'), 'openapi.yaml', brokenSpec]);
  report('contract', contractOk, contractBroken);

  const depcruise = join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
  const architectureOk = run([depcruise, '--config', '.dependency-cruiser.cjs', 'src']);
  writeFileSync(forbidden, "import '../demos/observe-kit';\n");
  const architectureBroken = run([depcruise, '--config', '.dependency-cruiser.cjs', 'src']);
  rmSync(forbidden, { force: true });
  report('architecture', architectureOk, architectureBroken);

  const reportPath = join(tmp, 'trivy.json');
  writeFileSync(reportPath, JSON.stringify({
    Results: [{
      Vulnerabilities: [{
        VulnerabilityID: 'CVE-2026-0001',
        PkgName: 'example',
        InstalledVersion: '1.0.0',
        FixedVersion: '1.0.1',
        Severity: 'HIGH',
      }],
    }],
  }));
  const scanEnv = { SCAN_REPORT_IN: reportPath, SCAN_IMAGE: 'fixture' };
  const imageOk = run([join(ROOT, 'scripts', 'scan.mjs')], { ...scanEnv, SCAN_MAX: '99999' });
  const imageBroken = run([join(ROOT, 'scripts', 'scan.mjs')], { ...scanEnv, SCAN_MAX: '-1' });
  report('image', imageOk, imageBroken);
} finally {
  rmSync(forbidden, { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
