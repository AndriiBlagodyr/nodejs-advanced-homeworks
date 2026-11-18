/**
 * Prices a Pulumi preview. Kubernetes objects themselves are free, so this
 * charges the CPU and memory the pods request, multiplied by the deployment
 * replica count, at the rates declared in the README (CI/CD). Two previews
 * of the same program have different plan hashes and the same sum.
 *
 * Rates are the public AWS Fargate Linux/x86 prices:
 *   https://aws.amazon.com/fargate/pricing/
 * A month is 730 hours. The gate checks the arithmetic, not a live bill.
 */
export const CPU_USD_PER_VCPU_HOUR = 0.04048;
export const MEMORY_USD_PER_GB_HOUR = 0.004445;
export const HOURS_PER_MONTH = 730;

export function cpuToVcpu(raw: string): number {
  const text = raw.trim();
  if (text.endsWith('m')) return Number(text.slice(0, -1)) / 1000;
  return Number(text);
}

export function memoryToGb(raw: string): number {
  const match = raw.trim().match(/^([0-9.]+)(Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|K)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const binary: Record<string, number> = { Ki: 1 / 1024 / 1024, Mi: 1 / 1024, Gi: 1, Ti: 1024 };
  const decimal: Record<string, number> = { K: 1e3 / 1e9, M: 1e6 / 1e9, G: 1, T: 1e3 };
  if (unit in binary) return amount * binary[unit];
  if (unit in decimal) return amount * decimal[unit];
  return amount / 1e9;
}

function monthlyUsd(cpu: string, memory: string): number {
  const vcpu = cpuToVcpu(cpu);
  const gb = memoryToGb(memory);
  if (!Number.isFinite(vcpu) || !Number.isFinite(gb)) return 0;
  return (vcpu * CPU_USD_PER_VCPU_HOUR + gb * MEMORY_USD_PER_GB_HOUR) * HOURS_PER_MONTH;
}

function replicaCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function visit(node: unknown, pairs: Set<string>, replicas = 1): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visit(item, pairs, replicas);
    return;
  }
  const obj = node as Record<string, unknown>;
  const here = replicaCount(obj.replicas) ?? replicas;
  if (typeof obj.cpu === 'string' && typeof obj.memory === 'string') {
    pairs.add(`${obj.cpu}|${obj.memory}|${here}`);
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && value.startsWith('{')) {
      try {
        visit(JSON.parse(value), pairs, here);
      } catch {
        // A string that merely starts with "{" is not a nested plan.
      }
    } else {
      visit(value, pairs, here);
    }
  }
}

/** Sum of distinct CPU/memory request pairs, each multiplied by its replica count. */
export function planCostUsd(raw: string): number {
  const pairs = new Set<string>();
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      visit(JSON.parse(trimmed), pairs);
    } catch {
      // Engine events are one JSON value per line; a wrapped file is parsed below.
    }
  }
  if (pairs.size === 0) {
    // `npm run` prints its script banner before the preview JSON.
    const start = raw.indexOf('{');
    try {
      visit(JSON.parse(start >= 0 ? raw.slice(start) : raw), pairs);
    } catch {
      return 0;
    }
  }
  let usd = 0;
  for (const pair of pairs) {
    const [cpu, memory, replicas] = pair.split('|');
    usd += monthlyUsd(cpu, memory) * Number(replicas);
  }
  return usd;
}
