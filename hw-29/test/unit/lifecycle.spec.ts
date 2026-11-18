import express from 'express';
import request from 'supertest';
import { LIVENESS_PATH, Lifecycle, READINESS_PATH, readLifecycleSettings } from '../../src/k8s/lifecycle';

function appWith(lifecycle: Lifecycle) {
  const app = express();
  app.use(lifecycle.middleware());
  app.get('/products', (_req, res) => {
    res.json([]);
  });
  return app;
}

describe('k8s lifecycle', () => {
  it('uses two different paths for liveness and readiness', () => {
    expect(LIVENESS_PATH).not.toBe(READINESS_PATH);
  });

  it('is live but not ready while warming up', async () => {
    const app = appWith(new Lifecycle());
    expect((await request(app).get(LIVENESS_PATH)).status).toBe(200);
    expect((await request(app).get(READINESS_PATH)).status).toBe(503);
  });

  it('is ready after warm-up and serves with keep-alive', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.ready = true;
    const app = appWith(lifecycle);
    expect((await request(app).get(READINESS_PATH)).status).toBe(200);
    const res = await request(app).get('/products').set('Connection', 'keep-alive');
    expect(res.status).toBe(200);
    expect(res.headers.connection).toBe('keep-alive');
  });

  it('turns readiness red on drain, stays live, and still serves with Connection: close', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.ready = true;
    lifecycle.draining = true;
    const app = appWith(lifecycle);
    expect((await request(app).get(READINESS_PATH)).status).toBe(503);
    expect((await request(app).get(LIVENESS_PATH)).status).toBe(200);
    const res = await request(app).get('/products').set('Connection', 'keep-alive');
    expect(res.status).toBe(200);
    expect(res.headers.connection).toBe('close');
  });

  it('reads timings from env and rejects garbage', () => {
    expect(readLifecycleSettings({})).toEqual({ warmupMs: 4000, drainMs: 5000, closeTimeoutMs: 10_000 });
    expect(readLifecycleSettings({ DRAIN_MS: '0' }).drainMs).toBe(0);
    expect(() => readLifecycleSettings({ DRAIN_MS: '-1' })).toThrow('DRAIN_MS');
    expect(() => readLifecycleSettings({ WARMUP_MS: 'soon' })).toThrow('WARMUP_MS');
  });
});
