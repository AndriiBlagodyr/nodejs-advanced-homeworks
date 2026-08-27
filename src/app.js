import express from 'express';
import OpenApiValidator from 'express-openapi-validator';
import { fileURLToPath } from 'node:url';

const apiSpec = fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url));

const products = [
  { id: 1, name: 'Mechanical Keyboard', price_cents: 12900 },
  { id: 2, name: 'Wireless Mouse', price_cents: 5900 },
  { id: 3, name: 'USB-C Hub', price_cents: 7900 },
  { id: 4, name: 'Laptop Stand', price_cents: 4500 },
  { id: 5, name: 'Web Camera', price_cents: 9900 },
];

const initialOrders = [
  {
    id: 1,
    items: [
      {
        product_id: 2,
        quantity: 2,
        unit_price_cents: 5900,
        line_total_cents: 11800,
      },
    ],
    total_cents: 11800,
    created_at: '2026-08-01T10:00:00.000Z',
  },
];

class ApiError extends Error {
  constructor(status, title, detail, type) {
    super(detail);
    this.status = status;
    this.title = title;
    this.type = type;
  }
}

function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`).toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined) return 0;

  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^offset:(0|[1-9]\d*)$/.exec(decoded);

  if (!match || encodeCursor(Number(match[1])) !== cursor) {
    throw new ApiError(
      400,
      'Bad Request',
      'The cursor is invalid or malformed.',
      'https://marketplace.example/problems/invalid-cursor',
    );
  }

  return Number(match[1]);
}

function page(collection, query) {
  const offset = decodeCursor(query.cursor);
  const limit = query.limit ?? 20;
  const items = collection.slice(offset, offset + limit);
  const nextOffset = offset + items.length;

  return {
    items,
    next_cursor:
      nextOffset < collection.length ? encodeCursor(nextOffset) : null,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function problemFrom(error, requestPath) {
  const status = error.status ?? 500;
  const isServerError = status >= 500;

  return {
    status,
    body: {
      type:
        error.type ??
        (isServerError
          ? 'https://marketplace.example/problems/internal-server-error'
          : 'https://marketplace.example/problems/invalid-request'),
      title:
        error.title ??
        (isServerError ? 'Internal Server Error' : 'Bad Request'),
      status,
      detail: error.message ?? 'An unexpected error occurred.',
      instance: requestPath,
    },
  };
}

export function createApp() {
  const app = express();
  const orders = structuredClone(initialOrders);
  const idempotencyRecords = new Map();

  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec,
      validateRequests: true,
      validateResponses: true,
    }),
  );

  app.get('/products', (req, res) => {
    res.json(page(products, req.query));
  });

  app.get('/products/:productId', (req, res, next) => {
    const product = products.find(({ id }) => id === Number(req.params.productId));

    if (!product) {
      return next(
        new ApiError(
          404,
          'Product Not Found',
          `Product ${req.params.productId} does not exist.`,
          'https://marketplace.example/problems/product-not-found',
        ),
      );
    }

    return res.json(product);
  });

  app.get('/orders', (req, res) => {
    res.json(page(orders, req.query));
  });

  app.post('/orders', (req, res, next) => {
    const key = req.get('Idempotency-Key');
    const requestFingerprint = stableStringify(req.body);
    const previous = idempotencyRecords.get(key);

    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) {
        return next(
          new ApiError(
            422,
            'Idempotency Conflict',
            'This Idempotency-Key was already used with a different request body.',
            'https://marketplace.example/problems/idempotency-conflict',
          ),
        );
      }

      return res
        .status(201)
        .location(`/orders/${previous.order.id}`)
        .set('Idempotency-Replay', 'true')
        .json(previous.order);
    }

    const orderItems = [];

    for (const item of req.body.items) {
      const product = products.find(({ id }) => id === item.product_id);

      if (!product) {
        return next(
          new ApiError(
            404,
            'Product Not Found',
            `Product ${item.product_id} does not exist.`,
            'https://marketplace.example/problems/product-not-found',
          ),
        );
      }

      orderItems.push({
        product_id: product.id,
        quantity: item.quantity,
        unit_price_cents: product.price_cents,
        line_total_cents: product.price_cents * item.quantity,
      });
    }

    const order = {
      id: orders.length + 1,
      items: orderItems,
      total_cents: orderItems.reduce(
        (total, item) => total + item.line_total_cents,
        0,
      ),
      created_at: new Date().toISOString(),
    };

    orders.push(order);
    idempotencyRecords.set(key, { requestFingerprint, order });

    return res.status(201).location(`/orders/${order.id}`).json(order);
  });

  app.get('/orders/:orderId', (req, res, next) => {
    const order = orders.find(({ id }) => id === Number(req.params.orderId));

    if (!order) {
      return next(
        new ApiError(
          404,
          'Order Not Found',
          `Order ${req.params.orderId} does not exist.`,
          'https://marketplace.example/problems/order-not-found',
        ),
      );
    }

    return res.json(order);
  });

  app.use((error, req, res, _next) => {
    const problem = problemFrom(error, req.originalUrl);
    res
      .status(problem.status)
      .type('application/problem+json')
      .json(problem.body);
  });

  return app;
}
