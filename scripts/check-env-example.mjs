import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { envSchema } from '../src/config/env.schema.ts';

const examplePath = resolve('.env.example');
const contents = await readFile(examplePath, 'utf8');
const expectedKeys = Object.keys(envSchema.shape).sort();
const actualKeys = [];
const errors = [];
let hasComment = false;

for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
  const line = rawLine.trim();

  if (!line) continue;

  if (line.startsWith('#')) {
    hasComment = true;
    continue;
  }

  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);

  if (!match) {
    errors.push(`line ${index + 1}: expected KEY=value or a comment`);
    hasComment = false;
    continue;
  }

  const key = match[1];

  if (!hasComment) {
    errors.push(`line ${index + 1}: ${key} must have a preceding comment`);
  }

  if (actualKeys.includes(key)) {
    errors.push(`line ${index + 1}: duplicate variable ${key}`);
  }

  actualKeys.push(key);
  hasComment = false;
}

const uniqueActualKeys = [...new Set(actualKeys)].sort();
const missing = expectedKeys.filter((key) => !uniqueActualKeys.includes(key));
const extra = uniqueActualKeys.filter((key) => !expectedKeys.includes(key));

if (missing.length) errors.push(`missing variables: ${missing.join(', ')}`);
if (extra.length) errors.push(`unknown variables: ${extra.join(', ')}`);

if (errors.length) {
  console.error(`.env.example is out of sync:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`.env.example matches the schema (${expectedKeys.length} variables).`);
}
