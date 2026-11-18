#!/usr/bin/env node
// Breaking-change check for openapi.yaml. Same script in CI and demo:gates.
// A removed path or HTTP method is breaking. Exit 0 when the revision still
// offers every operation the base offered.

import { readFileSync } from 'node:fs';

const [basePath, revisionPath] = process.argv.slice(2);
if (!basePath || !revisionPath) {
  console.error('usage: node scripts/contract-diff.mjs <base.yaml> <revision.yaml>');
  process.exit(2);
}

function operations(text) {
  const ops = new Set();
  let inPaths = false;
  let path = '';
  for (const line of text.split('\n')) {
    if (/^paths:/.test(line)) {
      inPaths = true;
      path = '';
      continue;
    }
    if (inPaths && /^[A-Za-z]/.test(line)) break;
    if (!inPaths) continue;
    const pathMatch = line.match(/^ {2}(\/[^:]+):\s*$/);
    if (pathMatch) {
      path = pathMatch[1];
      continue;
    }
    const method = line.match(/^ {4}(get|post|put|patch|delete|head|options):\s*$/);
    if (method && path) ops.add(`${method[1].toUpperCase()} ${path}`);
  }
  return ops;
}

const base = operations(readFileSync(basePath, 'utf8'));
const revision = operations(readFileSync(revisionPath, 'utf8'));
const removed = [...base].filter((op) => !revision.has(op));
console.log(`base-ops=${base.size}`);
console.log(`revision-ops=${revision.size}`);
console.log(`breaking=${removed.length}`);
for (const op of removed) console.log(`removed=${op}`);
process.exit(removed.length === 0 ? 0 : 1);
