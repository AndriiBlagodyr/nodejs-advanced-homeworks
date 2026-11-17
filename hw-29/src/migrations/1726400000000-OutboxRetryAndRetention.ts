import { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxRetryAndRetention1726400000000 implements MigrationInterface {
  name = 'OutboxRetryAndRetention1726400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "outbox" ADD COLUMN "last_error" text`);

    // Retention sweeps: DELETE … WHERE published_at < cutoff.
    await queryRunner.query(`
      CREATE INDEX "idx_outbox_published_at"
        ON "outbox" ("published_at")
        WHERE "published_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_processed_messages_processed_at"
        ON "processed_messages" ("processed_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_processed_messages_processed_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_published_at"`);
    await queryRunner.query(`ALTER TABLE "outbox" DROP COLUMN IF EXISTS "last_error"`);
  }
}
