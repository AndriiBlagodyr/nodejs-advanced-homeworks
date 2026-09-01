import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { Pool, QueryResultRow } from 'pg';
import { Env } from '../config/env.schema';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService<Env, true>) {
    const databaseUrl = new URL(config.get('DB_URL', { infer: true }));
    const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });

    this.pool = new Pool({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 5432),
      user: decodeURIComponent(databaseUrl.username),
      database: decodeURIComponent(databaseUrl.pathname.slice(1)),
      password: async () => (await readFile(passwordFile, 'utf8')).trim(),
    });

    this.pool.on('error', (error) => {
      this.logger.error('An idle PostgreSQL connection failed', error.stack);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
    this.logger.log('PostgreSQL connection established');
  }

  async query<Row extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.pool.query<Row>(text, values);
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
