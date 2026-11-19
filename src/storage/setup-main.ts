import { storageFromEnv } from './storage';

/** Dev setup: creates the bucket, keeps it private, adds the incomplete-multipart rule. */
async function main(): Promise<void> {
  const storage = storageFromEnv();
  const { lifecycle } = await storage.ensureBucket();
  console.log(`bucket=${storage.bucket} private=1 abort-incomplete-multipart-rule=${lifecycle ? 1 : 0}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
