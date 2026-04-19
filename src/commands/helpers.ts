import { callKalshiApi, supportsSubcent } from '../tools/kalshi/api.js';
import type { KalshiMarket, KalshiOrder, KalshiPosition } from '../tools/kalshi/types.js';
import type { KalshiBalanceResponse } from './formatters.js';
import { validateTradeArgs } from './help.js';

function parseSide(val: string | undefined): 'yes' | 'no' | null {
  const v = val?.toLowerCase();
  if (v === 'yes' || v === 'y') return 'yes';
  if (v === 'no' || v === 'n') return 'no';
  return null;
}

export interface ParsedTrade {
  ticker: string;
  count: number;
  price: number | undefined;
  side: 'yes' | 'no';
}

/**
 * Shared trade argument parser for CLI dispatch and slash handler.
 * Accepts: [ticker, count], [ticker, count, price], [ticker, count, yes|no],
 * or [ticker, count, price, yes|no]. The --side flag (from CLI) wins over
 * a positional yes|no when both are present.
 */
export function parseTradeArgs(
  positionals: string[],
  flagSide?: 'yes' | 'no',
): ParsedTrade | { error: string } {
  const [ticker, countStr, ...rest] = positionals;
  if (!ticker || !countStr) {
    return { error: `Usage: <ticker> <count> [price] [yes|no]  (price: 1-99 cents or 0.01-0.99 dollars)` };
  }

  let priceArg: string | undefined;
  let positionalSide: 'yes' | 'no' | null = null;
  if (rest.length >= 2) {
    priceArg = rest[0];
    positionalSide = parseSide(rest[1]);
  } else if (rest.length === 1) {
    const asSide = parseSide(rest[0]);
    if (asSide) positionalSide = asSide;
    else priceArg = rest[0];
  }

  const validated = validateTradeArgs(countStr, priceArg);
  if ('error' in validated) return { error: validated.error };

  const side = flagSide ?? positionalSide ?? 'yes';
  return {
    ticker: ticker.toUpperCase(),
    count: validated.count,
    price: validated.price,
    side,
  };
}

/**
 * Fetch open positions. Matches the behavior of the portfolio_overview tool —
 * unfiltered call to Kalshi, then drop rows with position_fp === "0.00".
 * (Kalshi's `count_filter=position` param filters too aggressively server-side
 * and returns empty arrays for accounts with real open positions.)
 */
export async function fetchOpenPositions(): Promise<KalshiPosition[]> {
  const data = await callKalshiApi('GET', '/portfolio/positions');
  const all = (data.market_positions ?? []) as KalshiPosition[];
  return all.filter((p) => parseFloat(p.position_fp) !== 0);
}

export async function fetchRestingOrders(): Promise<KalshiOrder[]> {
  const data = await callKalshiApi('GET', '/portfolio/orders', { params: { status: 'resting' } });
  return (data.orders ?? []) as KalshiOrder[];
}

export async function fetchBalance(): Promise<KalshiBalanceResponse> {
  return (await callKalshiApi('GET', '/portfolio/balance')) as unknown as KalshiBalanceResponse;
}

/**
 * Parse a market quote from API response. Returns a fractional cent value
 * (e.g. 56.5 for $0.5650) or NaN if no valid quote.
 */
function parseQuoteCents(market: Record<string, unknown>, field: 'yes_ask' | 'yes_bid' | 'no_ask' | 'no_bid'): number {
  const dollarStr = market[`${field}_dollars`] as string | undefined;
  const legacyStr = market[`dollar_${field}`] as string | undefined;

  const d = dollarStr != null ? parseFloat(dollarStr) : legacyStr != null ? parseFloat(legacyStr) : NaN;
  if (Number.isFinite(d) && d > 0) return d * 100;

  const cents = Number(market[field] ?? 0);
  if (Number.isFinite(cents) && cents > 0) return cents;

  return NaN;
}

export async function fetchMarket(ticker: string): Promise<KalshiMarket> {
  const res = await callKalshiApi('GET', `/markets/${ticker}`);
  const market = (res as { market?: unknown }).market ?? res;
  return market as KalshiMarket;
}

/**
 * Fetch the best available quote for a market order, alongside the market
 * object so callers can reuse it for order validation (no extra API round-trip).
 * Returns fractional cents when the market supports subcent pricing, else snaps
 * to whole cents.
 */
export async function fetchMarketQuote(
  ticker: string,
  action: 'buy' | 'sell',
  side: 'yes' | 'no' = 'yes',
): Promise<{ cents: number; market: KalshiMarket } | { error: string }> {
  const market = await fetchMarket(ticker);

  const field = side === 'no'
    ? (action === 'sell' ? 'no_bid' : 'no_ask')
    : (action === 'sell' ? 'yes_bid' : 'yes_ask');
  const cents = parseQuoteCents(market as unknown as Record<string, unknown>, field);

  if (!Number.isFinite(cents) || cents <= 0) {
    const label = action === 'sell' ? 'bid' : 'ask';
    return { error: `No ${label} available for ${ticker} — cannot place market order. Specify a price.` };
  }

  return { cents: supportsSubcent(market) ? cents : Math.round(cents), market };
}
