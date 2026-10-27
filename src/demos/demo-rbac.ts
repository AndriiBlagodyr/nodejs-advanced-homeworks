import { fail, report } from './demo-kit';
import {
  bootApi,
  call,
  DEMO_PASSWORD,
  insertOrder,
  insertUser,
  migrate,
  resetAuthUsers,
  tamperRole,
} from './auth-kit';

/**
 * 401 and 403 are different answers. No token is 401. A valid token for
 * someone else's order is 403, and so is a buyer writing a product. A seller
 * writing a product is 201. A token whose payload was edited and whose
 * signature was left alone is 401: the signature is checked, not decoded.
 */
async function main(): Promise<void> {
  const { lines, ok } = await run();
  report(lines, ok);
}

async function run(): Promise<{ lines: Record<string, number>; ok: boolean }> {
  await migrate();
  await resetAuthUsers('hw24-rbac-%@example.com');
  const ownerId = await insertUser('hw24-rbac-owner@example.com', 'buyer', 'HW24 Owner');
  await insertUser('hw24-rbac-other@example.com', 'buyer', 'HW24 Other');
  await insertUser('hw24-rbac-seller@example.com', 'seller', 'HW24 Seller');
  const orderId = await insertOrder(ownerId);

  const { app, base } = await bootApi();
  try {
    const owner = await call(base, 'POST', '/auth/login', {
      body: { email: 'hw24-rbac-owner@example.com', password: DEMO_PASSWORD },
    });
    const other = await call(base, 'POST', '/auth/login', {
      body: { email: 'hw24-rbac-other@example.com', password: DEMO_PASSWORD },
    });
    const seller = await call(base, 'POST', '/auth/login', {
      body: { email: 'hw24-rbac-seller@example.com', password: DEMO_PASSWORD },
    });
    const ownerToken = String(owner.body.access_token ?? '');
    const otherToken = String(other.body.access_token ?? '');
    const sellerToken = String(seller.body.access_token ?? '');

    const anon = await call(base, 'GET', `/orders/${orderId}`);
    const own = await call(base, 'GET', `/orders/${orderId}`, { token: ownerToken });
    const foreign = await call(base, 'GET', `/orders/${orderId}`, { token: otherToken });

    const product = { name: 'HW24 role item', price_cents: 100, stock: 1 };
    const roleDenied = await call(base, 'POST', '/products', { token: ownerToken, body: product });
    const roleAllowed = await call(base, 'POST', '/products', {
      token: sellerToken,
      body: product,
    });
    const tampered = await call(base, 'POST', '/products', {
      token: tamperRole(ownerToken),
      body: product,
    });

    const lines = {
      anon: anon.status,
      own: own.status,
      foreign: foreign.status,
      'role-denied': roleDenied.status,
      'role-allowed': roleAllowed.status,
      tampered: tampered.status,
    };
    return {
      lines,
      ok:
        lines.anon === 401 &&
        lines.own === 200 &&
        lines.foreign === 403 &&
        lines['role-denied'] === 403 &&
        (lines['role-allowed'] === 200 || lines['role-allowed'] === 201) &&
        lines.tampered === 401,
    };
  } finally {
    await app.close();
  }
}

main().catch(fail);
