import { readFileSync } from 'node:fs';
import { planCostUsd } from '../src/mapping';

const planPath = process.env.PLAN_JSON?.trim();
const budgetRaw = process.env.COST_BUDGET_USD?.trim();
if (!planPath) {
  console.error('missing PLAN_JSON');
  process.exit(2);
}
if (!budgetRaw || !/^-?\d+(\.\d+)?$/.test(budgetRaw)) {
  console.error('COST_BUDGET_USD must be a number');
  process.exit(2);
}

const budget = Number(budgetRaw);
const plan = planCostUsd(readFileSync(planPath, 'utf8'));
const bypass = process.env.COST_GATE_BYPASS === '1' || process.env.COST_GATE_BYPASS === 'true';
const pass = bypass || plan <= budget;

console.log(`budget-usd=${budget}`);
console.log(`plan-usd=${plan.toFixed(4)}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
process.exit(pass ? 0 : 1);
