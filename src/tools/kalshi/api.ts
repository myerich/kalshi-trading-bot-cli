import { createSign, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { auditTrail } from '../../audit/index.js';
import { dlqWriter } from './dlq.js';
import type { KalshiMarket } from './types.js';

const PROD_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const DEMO_BASE_URL = 'https://demo-api.kalshi.co/trade-api/v2';

function getBaseUrl(): string {
  return process.env.KALSHI_USE_DEMO === 'true' ? DEMO_BASE_URL : PROD_BASE_URL;
}

function getPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) {
    return process.env.KALSHI_PRIVATE_KEY;
  }
  if (process.env.KALSHI_PRIVATE_KEY_FILE) {
    return readFileSync(process.env.KALSHI_PRIVATE_KEY_FILE, 'utf-8');
  }
  throw new Error('Kalshi private key not configured. Set KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_FILE.');
}

function getApiKey(): string {
  const key = process.env.KALSHI_API_KEY;
  if (!key) throw new Error('KALSHI_API_KEY not set');
  return key;
}

function buildSignature(method: string, path: string): { timestamp: string; signature: string } {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path;

  const privateKey = getPrivateKey();
  const sign = createSign('SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    },
    'base64'
  );

  return { timestamp, signature };
}

// --- Error class ---

export class KalshiApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly body: string
  ) {
    super(`Kalshi API error: ${statusCode} ${statusText}${body ? ` — ${body}` : ''}`);
    this.name = 'KalshiApiError';
  }
}

// --- Dollar conversion utilities ---

export function toDollarString(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function fromDollarString(dollar: string): number {
  return Math.round(parseFloat(dollar) * 100);
}

/**
 * Serialize cents (possibly fractional, e.g. 56.5) as a 4-decimal dollar
 * string — the format Kalshi accepts in {yes,no}_price_dollars request fields.
 */
export function priceCentsToDollarString(priceCents: number): string {
  return (priceCents / 100).toFixed(4);
}

/**
 * Serialize a contract count as a 2-decimal fixed-point string — the format
 * Kalshi accepts in count_fp. Kalshi rejects fractional counts on the legacy
 * integer `count` field, so we always use count_fp.
 */
export function countToFpString(count: number): string {
  return count.toFixed(2);
}

/**
 * Whether this market accepts subcent prices (step < 1¢).
 * Authoritative source: price_level_structure. linear_cent means whole penny only.
 */
export function supportsSubcent(market: KalshiMarket): boolean {
  return market.price_level_structure !== undefined && market.price_level_structure !== 'linear_cent';
}

/**
 * Whether this market accepts fractional contract counts.
 */
export function supportsFractional(market: KalshiMarket): boolean {
  return market.fractional_trading_enabled === true;
}

/**
 * Build the price/count fields for a Kalshi order body. Always uses the new
 * fixed-point fields (count_fp + {side}_price_dollars) — never the legacy
 * integer `count` or `yes_price`/`no_price`, which reject fractional/subpenny.
 *
 * If `market` is supplied, enforces market-level gates:
 *   - fractional count requires fractional_trading_enabled=true
 *   - subcent price requires price_level_structure != 'linear_cent'
 */
export function buildOrderPriceCount(args: {
  side: 'yes' | 'no';
  count: number;
  priceCents?: number;
  market?: KalshiMarket;
}): Record<string, string> {
  const { side, count, priceCents, market } = args;
  const out: Record<string, string> = {};

  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`Invalid count: ${count}`);
  }
  const isFractional = !Number.isInteger(count);
  if (isFractional && market && !supportsFractional(market)) {
    throw new Error(
      `Market ${market.ticker} does not support fractional contracts (fractional_trading_enabled=false). Use whole contract counts.`
    );
  }
  out.count_fp = countToFpString(count);

  if (priceCents !== undefined) {
    if (!Number.isFinite(priceCents) || priceCents <= 0 || priceCents >= 100) {
      throw new Error(`Invalid price (cents): ${priceCents}`);
    }
    const isSubcent = !Number.isInteger(priceCents);
    if (isSubcent && market && !supportsSubcent(market)) {
      throw new Error(
        `Market ${market.ticker} does not support subcent prices (price_level_structure=linear_cent). Use whole-cent prices.`
      );
    }
    const field = side === 'yes' ? 'yes_price_dollars' : 'no_price_dollars';
    out[field] = priceCentsToDollarString(priceCents);
  }

  return out;
}

// --- Retry logic ---

interface RetryContext {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 120_000;
const JITTER_FACTOR = 0.2;

function isRetryable(error: unknown): boolean {
  if (!(error instanceof KalshiApiError)) return false;
  if (error.statusCode === 429) return true;
  if (error.statusCode >= 500) return true;
  return false;
}

function computeDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = base * JITTER_FACTOR * (2 * Math.random() - 1);
  return Math.max(0, base + jitter);
}

async function withRetry<T>(fn: () => Promise<T>, context: RetryContext): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        if (attempt > 0 && error instanceof KalshiApiError) {
          // Exhausted retries — write to DLQ
          dlqWriter.append({
            method: context.method,
            path: context.path,
            body: context.body,
            error: error.message,
            attempts: attempt + 1,
          });
          auditTrail.log({
            type: 'DLQ_ENTRY',
            method: context.method,
            path: context.path,
            error: error.message,
            attempts: attempt + 1,
          });
        }
        throw error;
      }

      const apiError = error as KalshiApiError;
      const delay = computeDelay(attempt);

      auditTrail.log({
        type: 'API_RETRY',
        method: context.method,
        path: context.path,
        attempt: attempt + 1,
        max_retries: MAX_RETRIES,
        status_code: apiError.statusCode,
        delay_ms: Math.round(delay),
      });

      logger.warn(
        `[Kalshi API] ${apiError.statusCode} on ${context.method} ${context.path}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

// --- Public API ---

export interface KalshiApiResponse {
  [key: string]: unknown;
}

export async function callKalshiApi(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options?: {
    params?: Record<string, string | number | boolean | string[] | undefined>;
    body?: Record<string, unknown>;
  }
): Promise<KalshiApiResponse> {
  return withRetry(
    async () => {
      const baseUrl = getBaseUrl();

      // Build URL with query params
      const url = new URL(`${baseUrl}${path}`);
      if (options?.params) {
        for (const [key, value] of Object.entries(options.params)) {
          if (value !== undefined && value !== null) {
            if (Array.isArray(value)) {
              value.forEach((v) => url.searchParams.append(key, String(v)));
            } else {
              url.searchParams.append(key, String(value));
            }
          }
        }
      }

      // Sign the request using only the path (no query string)
      // Kalshi signature covers: timestamp + method + path (without query params)
      const pathWithQuery = url.pathname;
      const { timestamp, signature } = buildSignature(method, pathWithQuery);

      const headers: Record<string, string> = {
        'KALSHI-ACCESS-KEY': getApiKey(),
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json',
      };

      const fetchOptions: RequestInit = { method, headers };

      if (options?.body && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
        fetchOptions.body = JSON.stringify(options.body);
      }

      const response = await fetch(url.toString(), fetchOptions);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new KalshiApiError(response.status, response.statusText, text);
      }

      // 204 No Content — DELETE operations often return this
      if (response.status === 204) {
        return {};
      }

      return response.json();
    },
    { method, path, body: options?.body }
  );
}

/**
 * Fetch all pages of a cursor-paginated endpoint.
 */
export async function fetchAllPages<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  dataKey: string,
  maxPages = 10,
  onProgress?: (info: { fetchedItems: number; page: number; maxPages: number }) => void
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const response = await callKalshiApi('GET', path, {
      params: cursor ? { ...params, cursor } : params,
    });

    const data = response[dataKey] as T[] | undefined;
    if (!data || data.length === 0) break;

    results.push(...data);
    cursor = response.cursor as string | undefined;
    page++;
    onProgress?.({ fetchedItems: results.length, page, maxPages });
    if (!cursor) break;
  }

  return results;
}
