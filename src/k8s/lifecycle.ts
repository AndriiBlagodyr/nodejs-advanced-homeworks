import type { NextFunction, Request, Response } from 'express';

export const LIVENESS_PATH = '/healthz';
export const READINESS_PATH = '/readyz';

export type LifecycleSettings = {
  /** Floor for the time from process start to listen(): migrations + pool, like a real service. */
  warmupMs: number;
  /** How long readiness stays red while the socket still serves, before close(). */
  drainMs: number;
  /** After close(), connections still open this long are cut. Must stay below the pod's grace. */
  closeTimeoutMs: number;
};

export function readLifecycleSettings(env: NodeJS.ProcessEnv = process.env): LifecycleSettings {
  return {
    warmupMs: nonNegativeInt(env, 'WARMUP_MS', 4000),
    drainMs: nonNegativeInt(env, 'DRAIN_MS', 5000),
    closeTimeoutMs: nonNegativeInt(env, 'CLOSE_TIMEOUT_MS', 10_000),
  };
}

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

/**
 * Two questions, two answers. Liveness: "should I be killed?" — yes only if
 * the event loop cannot answer at all, so it is 200 for as long as the
 * process runs. Readiness: "may I get traffic?" — only after warm-up and
 * never again once SIGTERM arrived. Putting both on one path would turn a
 * draining or warming pod into a restart loop.
 */
export class Lifecycle {
  ready = false;
  draining = false;

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (req.path === LIVENESS_PATH) {
        res.status(200).json({ live: true });
        return;
      }
      if (req.path === READINESS_PATH) {
        const ok = this.ready && !this.draining;
        res.status(ok ? 200 : 503).json({ ready: ok, draining: this.draining });
        return;
      }
      // A kept-alive socket stays pinned to this pod by conntrack even after the
      // endpoint is gone. Closing it after each answer sends the client's next
      // request through the Service again, to a pod that is still ready.
      if (this.draining) res.setHeader('connection', 'close');
      next();
    };
  }
}
