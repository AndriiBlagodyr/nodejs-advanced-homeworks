import path from 'path';
import { PactV4, MatchersV3 } from '@pact-foundation/pact';

const { integer, string, eachLike } = MatchersV3;

const provider = new PactV4({
  consumer: 'MarketplaceFrontend',
  provider: 'MarketplaceAPI',
  dir: path.resolve(process.cwd(), 'pacts'),
  logLevel: 'warn',
});

describe('Marketplace Consumer Contract', () => {
  it('returns a list of products', async () => {
    await provider
      .addInteraction()
      .given('products exist')
      .uponReceiving('a request for products')
      .withRequest('GET', '/products')
      .willRespondWith(200, (_builder) => {
        _builder.jsonBody({
          items: eachLike({
            id: integer(1),
            name: string('Widget'),
            price_cents: integer(500),
          }),
          next_cursor: null,
        });
      })
      .executeTest(async (mockServer) => {
        const res = await fetch(`${mockServer.url}/products`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('returns a single product', async () => {
    await provider
      .addInteraction()
      .given('product 1 exists')
      .uponReceiving('a request for product 1')
      .withRequest('GET', '/products/1')
      .willRespondWith(200, (_builder) => {
        _builder.jsonBody({
          id: integer(1),
          name: string('Widget'),
          price_cents: integer(500),
        });
      })
      .executeTest(async (mockServer) => {
        const res = await fetch(`${mockServer.url}/products/1`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('name');
      });
  });
});
