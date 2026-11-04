/**
 * Storage credentials come from the vault: they are the right to read and
 * write every file in the bucket. The endpoint and the bucket name are not
 * secrets. An empty endpoint means real AWS S3.
 */
export const STORAGE_SECRET_VARS = ['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'] as const;
export const STORAGE_REQUIRED_VARS = [...STORAGE_SECRET_VARS, 'STORAGE_BUCKET'] as const;

export type StorageConfig = {
  /** undefined → AWS S3; set → MinIO / LocalStack / R2, path-style. */
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function missingStorageVars(): string[] {
  return STORAGE_REQUIRED_VARS.filter((name) => !process.env[name]?.trim());
}

export function storageConfigured(): boolean {
  return missingStorageVars().length === 0;
}

export function loadStorageConfig(): StorageConfig {
  const missing = missingStorageVars();
  if (missing.length > 0) {
    throw new Error(`missing required secret: ${missing.join(', ')}`);
  }
  return {
    endpoint: process.env.STORAGE_ENDPOINT?.trim() || undefined,
    region: process.env.STORAGE_REGION?.trim() || 'us-east-1',
    bucket: process.env.STORAGE_BUCKET!.trim(),
    accessKeyId: process.env.STORAGE_ACCESS_KEY!.trim(),
    secretAccessKey: process.env.STORAGE_SECRET_KEY!.trim(),
  };
}
