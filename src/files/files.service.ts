import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AccessClaims } from '../auth/tokens';
import { isNotFound, Storage } from '../storage/storage';
import {
  ALLOWED_TYPES,
  DOWNLOAD_URL_TTL_SEC,
  MAGIC_BYTES,
  magicMatches,
  MULTIPART_THRESHOLD_BYTES,
  PART_URL_TTL_SEC,
  partLength,
  planParts,
  PUT_URL_TTL_SEC,
} from './policy';

export const STORAGE = Symbol('STORAGE');

type FileRow = {
  id: string;
  owner_id: string;
  key: string;
  content_type: string;
  size: string;
  status: 'PENDING' | 'COMPLETED';
  upload_id: string | null;
  part_size: string | null;
  part_count: number | null;
  etag: string | null;
};

export type PartUrl = { partNumber: number; url: string };

export type IntentResponse =
  | {
      fileId: string;
      key: string;
      status: 'PENDING';
      mode: 'single';
      expiresIn: number;
      upload: { method: 'PUT'; url: string; headers: Record<string, string> };
    }
  | {
      fileId: string;
      key: string;
      status: 'PENDING';
      mode: 'multipart';
      expiresIn: number;
      partSize: number;
      partCount: number;
      uploadedParts: number[];
      parts: PartUrl[];
    }
  | { fileId: string; key: string; status: 'COMPLETED' };

export type CommitResponse = {
  fileId: string;
  key: string;
  status: 'COMPLETED';
  size: number;
  etag: string;
};

const COLUMNS = `id, owner_id::text AS owner_id, key, content_type, size::text AS size, status,
                 upload_id, part_size::text AS part_size, part_count, etag`;

/**
 * Upload contract: intent → the client PUTs bytes straight into storage with
 * a presigned URL → commit. This service is on the authorization path and
 * never on the data path: no request body here is ever file bytes.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  async intent(
    viewer: AccessClaims,
    input: { contentType: string; size: number },
    idempotencyKey?: string,
  ): Promise<IntentResponse> {
    const type = ALLOWED_TYPES[input.contentType];
    if (!type) throw new UnsupportedMediaTypeException('content type not allowed');
    if (input.size > type.maxBytes) throw new PayloadTooLargeException('file too large');

    // The server picks the key. The client's filename never gets near it.
    const key = `uploads/${viewer.sub}/${randomUUID()}.${type.ext}`;
    const multipart = input.size > MULTIPART_THRESHOLD_BYTES;
    const plan = multipart ? planParts(input.size) : null;

    const inserted = await this.dataSource.query<FileRow[]>(
      `INSERT INTO files (owner_id, key, content_type, size, part_size, part_count, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        viewer.sub,
        key,
        input.contentType,
        input.size,
        plan?.partSize ?? null,
        plan?.partCount ?? null,
        idempotencyKey ?? null,
      ],
    );

    let row = inserted[0];
    if (!row) {
      // A double tap with the same Idempotency-Key: the same file, fresh URLs.
      row = await this.findOwned(viewer, idempotencyKey!, 'idempotency_key');
      if (row.content_type !== input.contentType || Number(row.size) !== input.size) {
        throw new UnprocessableEntityException('Idempotency-Key reused with a different body');
      }
      if (row.status === 'COMPLETED') return { fileId: row.id, key: row.key, status: 'COMPLETED' };
      if (row.part_count !== null && row.upload_id === null) {
        throw new ConflictException('intent in progress, retry');
      }
    } else if (plan) {
      const uploadId = await this.storage.createMultipart(row.key, row.content_type);
      await this.dataSource.query(`UPDATE files SET upload_id = $2 WHERE id = $1`, [
        row.id,
        uploadId,
      ]);
      row = { ...row, upload_id: uploadId };
    }

    this.logger.log(`upload intent file_id=${row.id} key=${row.key} multipart=${Boolean(plan)}`);
    return this.signFor(row);
  }

  /** A new process after a crash: what is already in storage, and URLs for the rest. */
  async resume(viewer: AccessClaims, id: string): Promise<IntentResponse> {
    const row = await this.findOwned(viewer, id);
    if (row.status === 'COMPLETED') return { fileId: row.id, key: row.key, status: 'COMPLETED' };
    if (!row.upload_id) throw new BadRequestException('not a multipart upload');
    return this.signFor(row);
  }

  async commit(viewer: AccessClaims, id: string): Promise<CommitResponse> {
    const row = await this.findOwned(viewer, id);
    if (row.status === 'COMPLETED') {
      return {
        fileId: row.id,
        key: row.key,
        status: 'COMPLETED',
        size: Number(row.size),
        etag: row.etag ?? '',
      };
    }

    if (row.upload_id) await this.completeFromStorage(row, row.upload_id);

    const head = await this.storage.head(row.key);
    if (!head) throw new ConflictException('object not uploaded');
    if (head.size !== Number(row.size)) {
      await this.storage.deleteObject(row.key);
      throw new ConflictException(`size mismatch: expected ${row.size}, got ${head.size}`);
    }
    const magic = await this.storage.readRange(row.key, MAGIC_BYTES);
    if (!magicMatches(row.content_type, magic)) {
      await this.storage.deleteObject(row.key);
      throw new UnprocessableEntityException('content does not match its content type');
    }

    await this.dataSource.query(
      `UPDATE files SET status = 'COMPLETED', etag = $2, completed_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [row.id, head.etag],
    );
    this.logger.log(`upload committed file_id=${row.id} key=${row.key} size=${head.size}`);
    return { fileId: row.id, key: row.key, status: 'COMPLETED', size: head.size, etag: head.etag };
  }

  /**
   * A presigned GET cannot be revoked, so nobody gets a long one: this
   * endpoint runs the guard on every request and hands out a minute.
   */
  async downloadUrl(viewer: AccessClaims, id: string): Promise<string> {
    const row = await this.findOwned(viewer, id);
    if (row.status !== 'COMPLETED') throw new NotFoundException('file not found');
    return this.storage.presignGet(row.key, DOWNLOAD_URL_TTL_SEC);
  }

  /** Ownership is checked on the loaded row: someone else's file is 403, a missing one 404. */
  private async findOwned(
    viewer: AccessClaims,
    value: string,
    by: 'id' | 'idempotency_key' = 'id',
  ): Promise<FileRow> {
    const rows =
      by === 'id'
        ? await this.dataSource.query<FileRow[]>(
            `SELECT ${COLUMNS} FROM files WHERE id = $1`,
            [isUuid(value) ? value : '00000000-0000-0000-0000-000000000000'],
          )
        : await this.dataSource.query<FileRow[]>(
            `SELECT ${COLUMNS} FROM files WHERE owner_id = $1 AND idempotency_key = $2`,
            [viewer.sub, value],
          );
    const row = rows[0];
    if (!row) throw new NotFoundException('file not found');
    if (row.owner_id !== viewer.sub && viewer.role !== 'admin') {
      throw new ForbiddenException('not your file');
    }
    return row;
  }

  /** Complete from what the storage says it has, not from what the client claims. */
  private async completeFromStorage(row: FileRow, uploadId: string): Promise<void> {
    let parts;
    try {
      parts = await this.storage.listParts(row.key, uploadId);
    } catch (err) {
      // A concurrent commit already completed it: HeadObject below decides.
      if (isNotFound(err) && (await this.storage.head(row.key))) return;
      throw err;
    }
    if (parts.length !== row.part_count) {
      throw new ConflictException(`parts uploaded ${parts.length} of ${row.part_count}`);
    }
    const plan = { partSize: Number(row.part_size), partCount: row.part_count };
    const wrong = parts.find((p) => p.size !== partLength(plan, Number(row.size), p.partNumber));
    if (wrong) throw new ConflictException(`part ${wrong.partNumber} has the wrong size`);
    try {
      await this.storage.completeMultipart(row.key, uploadId, parts);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private async listPartsOrGone(row: FileRow) {
    try {
      return await this.storage.listParts(row.key, row.upload_id!);
    } catch (err) {
      if (isNotFound(err)) throw new GoneException('upload expired, start a new intent');
      throw err;
    }
  }

  private async signFor(row: FileRow): Promise<IntentResponse> {
    if (!row.upload_id) {
      const url = await this.storage.presignPut(
        row.key,
        row.content_type,
        Number(row.size),
        PUT_URL_TTL_SEC,
      );
      return {
        fileId: row.id,
        key: row.key,
        status: 'PENDING',
        mode: 'single',
        expiresIn: PUT_URL_TTL_SEC,
        upload: { method: 'PUT', url, headers: { 'content-type': row.content_type } },
      };
    }
    const uploaded = await this.listPartsOrGone(row);
    const have = new Set(uploaded.map((p) => p.partNumber));
    const plan = { partSize: Number(row.part_size), partCount: row.part_count! };
    const parts: PartUrl[] = [];
    for (let n = 1; n <= plan.partCount; n += 1) {
      if (have.has(n)) continue;
      const length = partLength(plan, Number(row.size), n);
      parts.push({
        partNumber: n,
        url: await this.storage.presignPart(row.key, row.upload_id, n, length, PART_URL_TTL_SEC),
      });
    }
    return {
      fileId: row.id,
      key: row.key,
      status: 'PENDING',
      mode: 'multipart',
      expiresIn: PART_URL_TTL_SEC,
      partSize: Number(row.part_size),
      partCount: row.part_count!,
      uploadedParts: [...have].sort((a, b) => a - b),
      parts,
    };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
