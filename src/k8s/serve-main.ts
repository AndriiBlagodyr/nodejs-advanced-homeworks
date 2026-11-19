import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { AUTH_SECRET_VARS, loadAuthConfig } from '../auth/config';
import { configureApp } from '../configure-app';
import { createDataSourceOptions } from '../data-source';
import { Lifecycle, readLifecycleSettings } from './lifecycle';

/** The pod gets these from the Deployment: DB_PASSWORD and the auth keys by secretKeyRef. */
const REQUIRED_VARS = ['DB_HOST', 'DB_USER', 'DB_NAME', 'DB_PASSWORD', ...AUTH_SECRET_VARS] as const;
const MIGRATION_LOCK = 2028;
const DB_WAIT_MS = 60_000;

function log(event: string, fields: Record<string, string | number> = {}): void {
  const extra = Object.entries(fields).map(([k, v]) => ` ${k}=${v}`).join('');
  console.log(`[serve] ${event}${extra}`);
}

/**
 * Container entrypoint. Order matters:
 *   validate env → migrate (one pod at a time) → boot Nest → hold until the
 *   warm-up floor → listen → ready.
 * And on SIGTERM: readiness red → drain → close the socket → exit.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    console.error(`missing required env: ${missing.join(', ')}`);
    process.exit(1);
  }
  const settings = readLifecycleSettings();
  const auth = loadAuthConfig();
  const rev = process.env.REV ?? '-';
  log('starting', { rev, kid: auth.kid, fingerprint: auth.fingerprint, ...settings });

  const lifecycle = new Lifecycle();
  let server: Server | undefined;
  let closeApp: (() => Promise<void>) | undefined;

  process.once('SIGTERM', () => {
    void shutdown();
  });

  async function shutdown(): Promise<void> {
    lifecycle.draining = true;
    if (!server) {
      log('sigterm before listen, exiting');
      process.exit(0);
    }
    log('sigterm: readiness off, draining', { ms: settings.drainMs });
    await sleep(settings.drainMs);
    const cut = setTimeout(() => server?.closeAllConnections(), settings.closeTimeoutMs);
    cut.unref();
    await closeApp?.();
    log('socket closed, exiting');
    process.exit(0);
  }

  await migrate();

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.use(lifecycle.middleware());
  configureApp(app);
  await app.init();
  closeApp = () => app.close();

  const wait = settings.warmupMs - (Date.now() - startedAt);
  if (wait > 0) await sleep(wait);
  if (lifecycle.draining) return;

  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  server = app.getHttpServer() as Server;
  lifecycle.ready = true;
  log('ready', { rev, warmupMs: Date.now() - startedAt });
}

/** Several pods start at once on the first deploy; the advisory lock lets one migrate. */
async function migrate(): Promise<void> {
  const ds = new DataSource(createDataSourceOptions());
  const deadline = Date.now() + DB_WAIT_MS;
  for (;;) {
    try {
      await ds.initialize();
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      log('database not reachable yet, retrying');
      await sleep(1000);
    }
  }
  const runner = ds.createQueryRunner();
  try {
    await runner.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    const applied = await ds.runMigrations({ transaction: 'all' });
    log('migrations', { applied: applied.length });
  } finally {
    await runner.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    await runner.release();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
