import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  userId?: string;
  tenant?: string;
  idempotencyKey?: string;
};

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return als.getStore();
}

export function patchContext(patch: Partial<RequestContext>): void {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}
