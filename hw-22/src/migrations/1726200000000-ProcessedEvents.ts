import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProcessedEvents1726200000000 implements MigrationInterface {
  name = 'ProcessedEvents1726200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "processed_events" (
        "event_id" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "processed_events"`);
  }
}
