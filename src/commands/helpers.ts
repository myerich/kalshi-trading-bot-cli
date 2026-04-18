import { callKalshiApi, supportsSubcent } from '../tools/kalshi/api.js';
import type { KalshiMarket } from '../tools/kalshi/types.js';

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
