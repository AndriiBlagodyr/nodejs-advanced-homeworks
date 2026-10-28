import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The list of a user's files lives here, not in a bucket listing. A row is
 * PENDING from intent until commit has seen the object with HeadObject.
 */
export class Files1726700000000 implements MigrationInterface {
  name = 'Files1726700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "files" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "owner_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "key" text NOT NULL UNIQUE,
        "content_type" text NOT NULL,
        "size" bigint NOT NULL CHECK ("size" > 0),
        "status" text NOT NULL DEFAULT 'PENDING'
          CHECK ("status" IN ('PENDING', 'COMPLETED')),
        "upload_id" text,
        "part_size" bigint,
        "part_count" integer,
        "etag" text,
        "idempotency_key" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz,
        CONSTRAINT "files_multipart_shape" CHECK (
          ("upload_id" IS NULL AND "part_size" IS NULL AND "part_count" IS NULL)
          OR ("part_size" IS NOT NULL AND "part_count" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_files_owner_idempotency_key"
        ON "files" ("owner_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL
    `);
    await queryRunner.query(`CREATE INDEX "idx_files_owner_id" ON "files" ("owner_id")`);
    // Orphan sweep: PENDING rows older than a day.
    await queryRunner.query(`
      CREATE INDEX "idx_files_pending_created_at" ON "files" ("created_at") WHERE "status" = 'PENDING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "files"`);
  }
}
