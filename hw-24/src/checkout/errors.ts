export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export class InsufficientStockError extends CheckoutError {
  constructor() {
    super('insufficient stock');
    this.name = 'InsufficientStockError';
  }
}

export class InsufficientFundsError extends CheckoutError {
  constructor() {
    super('insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export type CheckoutInput = {
  userId: string;
  productId: string;
  quantity: number;
  shippingCountry?: string;
};

export type CheckoutResult = {
  orderId: string;
  jobId: string;
  totalCents: number;
  stockLeft: number;
};
