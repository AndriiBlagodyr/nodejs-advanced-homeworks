// demo:image — is the image production-grade, and did the build secret stay out of it?
//
//   npm run demo:image                         # the image from npm run image:build
//   DEMO_IMAGE_CONTROL=1 npm run demo:image    # also build two leaky controls and measure them
//
// Every number is read from Docker: the Dockerfile's FROM lines, `docker run`
// with a shell as entrypoint, the uid the process really gets, and the token
// searched in `docker history`, `docker image inspect` and every layer of
// `docker save`. No single one of those sees both kinds of leak: an ARG lands
// in history/config but not in a layer; COPY + rm lands in a layer only.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { fail, names, report, ROOT, run } from './kit.mjs';

const SHELLS = ['sh', '/bin/sh', '/bin/bash', '/busybox/sh'];

async function main() {
  const tokenFile = process.env.NPM_TOKEN_FILE ?? join(ROOT, '.npm_token');
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (token.length < 8) throw new Error(`${tokenFile}: token too short to search for reliably`);

  const dockerfile = readFileSync(join(ROOT, 'docker', 'Dockerfile'), 'utf8');
  const lines = { stages: (dockerfile.match(/^\s*FROM\s+/gim) ?? []).length, ...(await measure(names.image, token)) };

  let ok =
    lines.stages >= 2 &&
    lines['shell-inside'] === 0 &&
    Number.isInteger(lines['runtime-uid']) &&
    lines['runtime-uid'] !== 0 &&
    lines['token-in-history'] === 0 &&
    lines['token-in-config'] === 0 &&
    lines['token-in-layers'] === 0;

  if (process.env.DEMO_IMAGE_CONTROL === '1') {
    const control = await controls(token);
    Object.assign(lines, control.lines);
    ok &&= control.ok;
  }
  report(lines, ok);
}

async function measure(image, token) {
  const inspect = await run('docker', ['image', 'inspect', image]);
  if (inspect.code !== 0) throw new Error(`image ${image} not found: run npm run image:build first`);

  let shell = 0;
  for (const candidate of SHELLS) {
    const res = await run('docker', ['run', '--rm', '--entrypoint', candidate, image, '-c', 'exit 0']);
    if (res.code === 0) shell = 1;
  }

  // The image's own entrypoint (node), so this is the uid the app really runs as.
  const uid = await run('docker', ['run', '--rm', image, '-e', 'process.stdout.write(String(process.getuid()))']);
  const runtimeUid = /^\d+$/.test(uid.stdout.trim()) ? Number(uid.stdout.trim()) : NaN;

  const history = await run('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', image]);
  if (history.code !== 0) throw new Error(`docker history: ${history.stderr}`);

  return {
    'shell-inside': shell,
    'runtime-uid': runtimeUid,
    'token-in-history': history.stdout.split('\n').filter((line) => line.includes(token)).length,
    'token-in-config': inspect.stdout.split(token).length - 1,
    'token-in-layers': await layersContaining(image, token),
  };
}

/** docker save → unpack → every layer blob, decompressed, searched for the raw bytes. */
async function layersContaining(image, token) {
  const dir = mkdtempSync(join(tmpdir(), 'hw28-image-'));
  try {
    const tar = join(dir, 'image.tar');
    const save = await run('docker', ['save', '-o', tar, image]);
    if (save.code !== 0) throw new Error(`docker save: ${save.stderr}`);
    const out = join(dir, 'x');
    mkdirSync(out);
    const untar = await run('tar', ['-xf', tar, '-C', out]);
    if (untar.code !== 0) throw new Error(`tar: ${untar.stderr}`);

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const layers = [...new Set(manifest.flatMap((m) => m.Layers))];
    if (layers.length === 0) throw new Error('docker save produced no layers');
    const needle = Buffer.from(token);
    let hits = 0;
    for (const layer of layers) {
      if (decompress(readFileSync(join(out, layer))).includes(needle)) hits += 1;
    }
    return hits;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function decompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  if (buf.readUInt32LE(0) === 0xfd2fb528) {
    if (!zlib.zstdDecompressSync) throw new Error('zstd layer, and this Node has no zstd: use Node >= 22.15');
    return zlib.zstdDecompressSync(buf);
  }
  return buf;
}

/** The two wrong ways, built from a throwaway context, measured with the same code, then removed. */
async function controls(token) {
  const dir = mkdtempSync(join(tmpdir(), 'hw28-control-'));
  const lines = {};
  let ok = true;
  try {
    writeFileSync(join(dir, 'npm_token'), token, { mode: 0o600 });
    for (const kind of ['arg', 'copy']) {
      const tag = `hw28-control-${kind}:latest`;
      const src = join(ROOT, 'docker', 'control', `Dockerfile.${kind}`);
      const args = ['build', '-q', '-f', src, '-t', tag];
      if (kind === 'arg') args.push('--build-arg', `NPM_TOKEN=${token}`);
      const build = await run('docker', [...args, dir]);
      if (build.code !== 0) throw new Error(`control build ${kind}: ${build.stderr}`);
      try {
        const m = await measure(tag, token);
        for (const key of ['token-in-history', 'token-in-config', 'token-in-layers']) {
          lines[`control-${kind}-${key}`] = m[key];
        }
        const leaked = m['token-in-history'] + m['token-in-config'] + m['token-in-layers'];
        ok &&= leaked > 0;
      } finally {
        await run('docker', ['image', 'rm', '-f', tag]);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { lines, ok };
}

main().catch(fail);
