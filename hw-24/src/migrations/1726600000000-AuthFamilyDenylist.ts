import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Revocation is per family, not per jti: every access token carries `fid`, and
 * a revoked family must kill all of them, including ones issued before the
 * last refresh. A row lives for ACCESS_TTL after revocation, which is the
 * longest any access token of that family can still be valid.
 */
export class AuthFamilyDenylist1726600000000 implements MigrationInterface {
  name = 'AuthFamilyDenylist1726600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "revoked_families" (
        "family_id" uuid PRIMARY KEY,
        "expires_at" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_revoked_families_expires_at" ON "revoked_families" ("expires_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_refresh_tokens_expires_at" ON "refresh_tokens" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_refresh_tokens_expires_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "revoked_families"`);
  }
}
