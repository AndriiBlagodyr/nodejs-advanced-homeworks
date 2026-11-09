import { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxAndInbox1726300000000 implements MigrationInterface {
  name = 'OutboxAndInbox1726300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "outbox" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "aggregate_type" text NOT NULL,
        "aggregate_id" text NOT NULL,
        "type" text NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "published_at" timestamptz,
        "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_outbox_unpublished"
        ON "outbox" ("created_at", "id")
        WHERE "published_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "processed_messages" (
        "message_id" text NOT NULL,
        "consumer" text NOT NULL,
        "processed_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("message_id", "consumer")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "order_confirmations" (
        "order_id" bigint PRIMARY KEY,
        "event_id" text NOT NULL,
        "user_id" bigint NOT NULL,
        "total_cents" integer NOT NULL CHECK ("total_cents" >= 0),
        "confirmed_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_confirmations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "processed_messages"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox"`);
  }
}
