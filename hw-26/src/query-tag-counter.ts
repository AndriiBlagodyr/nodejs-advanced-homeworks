import type { Logger } from 'typeorm';

/**
 * TypeORM logger that counts queries actually sent to the driver whose SQL
 * starts with the given tag. Silent otherwise.
 */
export class QueryTagCounter implements Logger {
  count = 0;

  constructor(private readonly tag: string) {}

  reset(): void {
    this.count = 0;
  }

  logQuery(query: string): void {
    if (query.trimStart().startsWith(this.tag)) this.count += 1;
  }

  logQueryError(): void {}

  logQuerySlow(): void {}

  logSchemaBuild(): void {}

  logMigration(): void {}

  log(): void {}
}
