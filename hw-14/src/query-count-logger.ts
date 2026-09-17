import type { Logger, QueryRunner } from 'typeorm';

export class QueryCountLogger implements Logger {
  count = 0;

  logQuery(query: string, _parameters?: unknown[], _queryRunner?: QueryRunner): void {
    this.count += 1;
    console.log(`query: ${query}`);
  }

  logQueryError(): void {}

  logQuerySlow(): void {}

  logSchemaBuild(): void {}

  logMigration(): void {}

  log(): void {}
}
