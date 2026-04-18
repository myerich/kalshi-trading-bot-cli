import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callKalshiApi, priceCentsToDollarString } from './api.js';
import { formatToolResult } from '../types.js';

// Shared schema fragments: accept fractional counts and subpenny prices.
// Prices are in cents (1-99); fractional values like 56.5 are allowed for
// subpenny markets (tick_size < 1) and are sent as `dollar_price` strings.
const priceCentsSchema = z
  .number()
  .positive()
  .max(99)
  .describe('Limit price in cents (1-99; fractional like 56.5 allowed for subpenny markets where tick_size<1)');

const countSchema = z
  .number()
  .positive()
  .describe('Number of contracts (whole number; fractional allowed when market.supports_fractional is true)');

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
    const body: Record<string, unknown> = {
      ticker: input.ticker,
      action: input.action,
      side: input.side,
      type: input.type,
      count: input.count,
    };
    if (input.price_cents !== undefined) {
      body.dollar_price = priceCentsToDollarString(input.price_cents);
    }
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
    count: countSchema.optional(),
    price_cents: priceCentsSchema.optional(),
    expiration_ts: z.number().optional().describe('New expiration timestamp'),
  }),
  func: async (input) => {
    const body: Record<string, unknown> = {};
    if (input.count !== undefined) body.count = input.count;
    if (input.price_cents !== undefined) {
      body.dollar_price = priceCentsToDollarString(input.price_cents);
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
    const orders = input.orders.map((o) => {
      const { price_cents, ...rest } = o;
      if (price_cents === undefined) return rest;
      return { ...rest, dollar_price: priceCentsToDollarString(price_cents) };
    });
    const body = { orders };
    const data = await callKalshiApi('POST', '/portfolio/orders/batched', { body });
    return formatToolResult(data);
  },
});
