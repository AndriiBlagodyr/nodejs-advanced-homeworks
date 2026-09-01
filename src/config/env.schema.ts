import { z } from 'zod';

export const envSchema = z.object({
  DB_URL: z
    .string()
    .url()
    .refine(
      (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
      'must be a PostgreSQL connection URL',
    )
    .refine(
      (value) => new URL(value).password === '',
      'must not contain a password; use DB_PASSWORD_FILE',
    ),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DB_PASSWORD_FILE: z.string().min(1).default('secrets/db_password'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const reasons = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${reasons}`);
  }

  return result.data;
}
