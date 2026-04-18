import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callKalshiApi, buildOrderPriceCount } from './api.js';
import { formatToolResult } from '../types.js';

// Shared schema fragments: counts and prices are validated at the Kalshi layer
// (market fetch + buildOrderPriceCount) — the schema only enforces positivity.
const priceCentsSchema = z
  .number()
  .positive()
  .max(99)
  .describe('Limit price in cents (1-99; fractional like 56.5 allowed on subcent markets where price_level_structure != "linear_cent")');

const countSchema = z
  .number()
  .positive()
  .describe('Number of contracts (whole number; fractional allowed when market.fractional_trading_enabled is true)');

/**
 * Fetch a market just to resolve its fractional/subcent capability — order
 * placement uses this to gate input before submitting to the API.
 */
async function fetchMarketForOrder(ticker: string) {
  const res = await callKalshiApi('GET', `/markets/${ticker}`);
  const market = (res as { market?: Record<string, unknown> }).market;
  if (!market) throw new Error(`Market not found: ${ticker}`);
  return market as unknown as import('./types.js').KalshiMarket;
}

export const placeOrder = new DynamicStructuredTool({
  name: 'place_order',
  description: 'Place a new order on a Kalshi market.',
  schema: z.object({
    ticker: z.string().describe('Market ticker'),
    action: z.enum(['buy', 'sell']).describe('Buy or sell'),
    side: z.enum(['yes', 'no']).describe('Yes or No side'),
    type: z.enum(['limit', 'market']).describe('Order type'),
    count: countSchema,
    price_cents: priceCentsSchema.optional(),
    expiration_ts: z.number().optional().describe('Order expiration Unix timestamp'),
    client_order_id: z.string().optional().describe('Optional client-provided order ID'),
  }),
  func: async (input) => {
    const market = await fetchMarketForOrder(input.ticker);
    const body: Record<string, unknown> = {
      ticker: input.ticker,
      action: input.action,
      side: input.side,
      type: input.type,
      ...buildOrderPriceCount({
        side: input.side,
        count: input.count,
        priceCents: input.price_cents,
        market,
      }),
    };
    if (input.expiration_ts !== undefined) body.expiration_ts = input.expiration_ts;
    if (input.client_order_id) body.client_order_id = input.client_order_id;

    const data = await callKalshiApi('POST', '/portfolio/orders', { body });
    return formatToolResult(data);
  },
});

export const amendOrder = new DynamicStructuredTool({
  name: 'amend_order',
  description: 'Amend an existing resting order.',
  schema: z.object({
    order_id: z.string().describe('Order ID to amend'),
    ticker: z.string().describe('Market ticker (required to resolve subcent/fractional gates)'),
    side: z.enum(['yes', 'no']).describe('Side of the original order'),
    count: countSchema.optional(),
    price_cents: priceCentsSchema.optional(),
    expiration_ts: z.number().optional().describe('New expiration timestamp'),
  }),
  func: async (input) => {
    const market = await fetchMarketForOrder(input.ticker);
    const body: Record<string, unknown> = {};
    if (input.count !== undefined || input.price_cents !== undefined) {
      Object.assign(
        body,
        buildOrderPriceCount({
          side: input.side,
          count: input.count ?? 1,
          priceCents: input.price_cents,
          market,
        })
      );
      if (input.count === undefined) delete (body as Record<string, unknown>).count_fp;
    }
    if (input.expiration_ts !== undefined) body.expiration_ts = input.expiration_ts;

    const data = await callKalshiApi('POST', `/portfolio/orders/${input.order_id}/amend`, { body });
    return formatToolResult(data);
  },
});

export const cancelOrder = new DynamicStructuredTool({
  name: 'cancel_order',
  description: 'Cancel an existing resting order.',
  schema: z.object({
    order_id: z.string().describe('Order ID to cancel'),
  }),
  func: async (input) => {
    const data = await callKalshiApi('DELETE', `/portfolio/orders/${input.order_id}`);
    return formatToolResult(data);
  },
});

export const cancelOrders = new DynamicStructuredTool({
  name: 'cancel_orders',
  description: 'Cancel multiple resting orders in batch.',
  schema: z.object({
    order_ids: z.array(z.string()).describe('List of order IDs to cancel'),
  }),
  func: async (input) => {
    const body = { order_ids: input.order_ids };
    const data = await callKalshiApi('DELETE', '/portfolio/orders/batched', { body });
    return formatToolResult(data);
  },
});

export const placeBatchOrders = new DynamicStructuredTool({
  name: 'place_batch_orders',
  description: 'Place multiple orders in a single batch request.',
  schema: z.object({
    orders: z
      .array(
        z.object({
          ticker: z.string(),
          action: z.enum(['buy', 'sell']),
          side: z.enum(['yes', 'no']),
          type: z.enum(['limit', 'market']),
          count: countSchema,
          price_cents: priceCentsSchema.optional(),
        })
      )
      .describe('List of orders to place'),
  }),
  func: async (input) => {
    // Dedupe market fetches across the batch.
    const marketCache = new Map<string, import('./types.js').KalshiMarket>();
    const orders = await Promise.all(
      input.orders.map(async (o) => {
        let market = marketCache.get(o.ticker);
        if (!market) {
          market = await fetchMarketForOrder(o.ticker);
          marketCache.set(o.ticker, market);
        }
        const { price_cents, count, ...rest } = o;
        return {
          ...rest,
          ...buildOrderPriceCount({ side: o.side, count, priceCents: price_cents, market }),
        };
      })
    );
    const body = { orders };
    const data = await callKalshiApi('POST', '/portfolio/orders/batched', { body });
    return formatToolResult(data);
  },
});
