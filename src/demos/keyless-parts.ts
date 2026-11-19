import { openSync, readFileSync, readSync } from 'node:fs';
import { sensitiveEnvKeys } from './keyless-env';

/**
 * A client process uploading multipart parts with presigned URLs and no
 * credentials. `crashAfter` makes it die with SIGKILL after that many parts,
 * which is the "connection dropped / laptop closed" case.
 */
type Plan = {
  file: string;
  size: number;
  partSize: number;
  parts: Array<{ partNumber: number; url: string }>;
  crashAfter?: number;
};

async function main(): Promise<void> {
  console.log(`env-keys=${sensitiveEnvKeys()}`);
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Plan;
  const fd = openSync(plan.file, 'r');
  let uploaded = 0;
  for (const part of plan.parts) {
    const offset = (part.partNumber - 1) * plan.partSize;
    const length = Math.min(plan.partSize, plan.size - offset);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, offset);
    const res = await fetch(part.url, { method: 'PUT', body: buf });
    await res.arrayBuffer();
    if (res.status !== 200) {
      console.log(`failed-part=${part.partNumber}`);
      console.log(`failed-status=${res.status}`);
      break;
    }
    uploaded += 1;
    console.log(`uploaded-part=${part.partNumber}`);
    if (plan.crashAfter !== undefined && uploaded >= plan.crashAfter) {
      process.kill(process.pid, 'SIGKILL');
    }
  }
  console.log(`uploaded=${uploaded}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.log('uploaded=0');
});
