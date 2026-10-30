import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadStorageConfig, type StorageConfig } from './config';

export type ObjectHead = { size: number; etag: string; contentType?: string; cacheControl?: string };
export type UploadedPart = { partNumber: number; etag: string; size: number };
export type StoredObject = {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
};

/**
 * The only place that talks to S3. Every other module gets keys and URLs from
 * here, never credentials. The same code runs against MinIO and AWS: only the
 * endpoint changes.
 */
export class Storage {
  readonly bucket: string;
  readonly client: S3Client;

  constructor(readonly cfg: StorageConfig) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: Boolean(cfg.endpoint),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // A presigned PUT is signed before the body exists; with the default
      // (WHEN_SUPPORTED) the URL would carry the CRC32 of empty data.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Anonymous URL of an object, straight at the bucket. Used to prove it is closed. */
  directUrl(key: string): string {
    const path = key.split('/').map(encodeURIComponent).join('/');
    if (this.cfg.endpoint) return `${this.cfg.endpoint.replace(/\/$/, '')}/${this.bucket}/${path}`;
    return `https://${this.bucket}.s3.${this.cfg.region}.amazonaws.com/${path}`;
  }

  /**
   * The signature covers the path, Content-Type and Content-Length: the URL is
   * good for exactly this key, this type and this many bytes.
   */
  presignPut(
    key: string,
    contentType: string,
    contentLength: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  presignGet(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: Number(res.ContentLength ?? 0),
        etag: res.ETag ?? '',
        contentType: res.ContentType,
        cacheControl: res.CacheControl,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async readRange(key: string, bytes: number): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        body: Buffer.from(await res.Body!.transformToByteArray()),
        contentType: res.ContentType,
        cacheControl: res.CacheControl,
        etag: res.ETag,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(
    key: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
      }),
    );
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error('CreateMultipartUpload returned no UploadId');
    return res.UploadId;
  }

  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      { expiresIn, signableHeaders: new Set(['content-length']) },
    );
  }

  /** What the storage already has. The source of truth for resume and for Complete. */
  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const p of res.Parts ?? []) {
        parts.push({ partNumber: p.PartNumber!, etag: p.ETag!, size: Number(p.Size ?? 0) });
      }
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.deleteKeys([key]);
  }

  /** Deletes objects and aborts unfinished multipart uploads under a prefix. */
  async purgePrefix(prefix: string): Promise<{ objects: number; uploads: number }> {
    let uploads = 0;
    let keyMarker: string | undefined;
    let idMarker: string | undefined;
    do {
      const res = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          UploadIdMarker: idMarker,
        }),
      );
      for (const u of res.Uploads ?? []) {
        await this.abortMultipart(u.Key!, u.UploadId!);
        uploads += 1;
      }
      keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
      idMarker = res.IsTruncated ? res.NextUploadIdMarker : undefined;
    } while (keyMarker);

    let objects = 0;
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (res.Contents ?? []).map((o) => o.Key!);
      await this.deleteKeys(keys);
      objects += keys.length;
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return { objects, uploads };
  }

  /**
   * Dev/demo setup only; in production the bucket is infrastructure (IaC).
   * Private (no bucket policy) plus the incomplete-multipart hygiene rule.
   */
  async ensureBucket(): Promise<{ lifecycle: boolean }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    try {
      await this.client.send(new DeleteBucketPolicyCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    let lifecycle = true;
    try {
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-multipart',
                Status: 'Enabled',
                Filter: { Prefix: '' },
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
              },
            ],
          },
        }),
      );
    } catch {
      lifecycle = false;
    }
    return { lifecycle };
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}

export function isNotFound(err: unknown): boolean {
  if (!(err instanceof S3ServiceException)) return false;
  const status = err.$metadata?.httpStatusCode;
  return (
    status === 404 ||
    ['NotFound', 'NoSuchKey', 'NoSuchBucket', 'NoSuchUpload', 'NoSuchBucketPolicy'].includes(
      err.name,
    )
  );
}

let shared: Storage | undefined;

export function storageFromEnv(): Storage {
  shared ??= new Storage(loadStorageConfig());
  return shared;
}
