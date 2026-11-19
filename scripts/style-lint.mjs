#!/usr/bin/env node
// Fails when a TypeScript file under the given directory contains a debugger statement.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/style-lint.mjs <dir>');
  process.exit(2);
}

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...files(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const hits = [];
for (const path of files(root)) {
  const text = readFileSync(path, 'utf8');
  if (/^\s*debugger\s*;/m.test(text)) hits.push(path);
}
console.log(`debugger=${hits.length}`);
if (hits.length > 0) {
  for (const path of hits) console.error(path);
  process.exit(1);
}
