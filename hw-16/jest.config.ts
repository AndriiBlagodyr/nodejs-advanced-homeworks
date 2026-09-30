import type { Config } from 'jest';

const shared = {
  preset: 'ts-jest' as const,
  testEnvironment: 'node' as const,
  testTimeout: 60_000,
  modulePathIgnorePatterns: ['<rootDir>/hw-'],
  transformIgnorePatterns: [
    'node_modules/(?!(@nestjs|supertest)/)',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
    '^.+\\.js$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};

const config: Config = {
  reporters: ['default'],
  maxWorkers: 1,
  modulePathIgnorePatterns: ['<rootDir>/hw-'],
  projects: [
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'contract',
      testMatch: ['<rootDir>/test/contract/**/*.consumer.spec.ts'],
    },
  ],
};

export default config;
