import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadAuthConfig } from './auth/config';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  // Before NestFactory: that opens the database, and a connection error would
  // hide the name of the missing secret.
  let auth;
  try {
    auth = loadAuthConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log(`auth signing kid=${auth.kid} fingerprint=${auth.fingerprint}`);

  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
