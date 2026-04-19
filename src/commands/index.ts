import { callKalshiApi, buildOrderPriceCount } from '../tools/kalshi/api.js';
import {
  formatBalance,
  formatPositions,
  formatOrders,
  formatExchangeStatus,
} from './formatters.js';
import { handleThemes, formatThemesHuman } from './themes.js';
import type { ParsedArgs, Subcommand } from './parse-args.js';

function defaultArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    subcommand: 'chat', positionalArgs: [], json: false,
    live: false, refresh: false, report: false, dryRun: false,
    verbose: false, performance: false, resolved: false,
    unresolved: false, parseErrors: [],
    ...overrides,
  };
}
import { handleBacktest, formatBacktestHuman } from './backtest.js';
import { handleAnalyze, formatAnalyzeHuman } from './analyze.js';
import { handlePortfolio, formatPortfolioHuman } from './portfolio.js';
import { reviewPortfolio, formatReviewHuman } from './review.js';
import { handleConfig, formatConfigHuman } from './config.js';
import { buildHelp } from './help.js';
import { fetchMarket, fetchMarketQuote, fetchOpenPositions, fetchRestingOrders, fetchBalance, parseTradeArgs } from './helpers.js';

export interface CommandResult {
  output: string;
  /** If set, run this async function after showing `output` and append the result */
  asyncFollowUp?: () => Promise<string>;
}

export async function handleSlashCommand(input: string): Promise<CommandResult | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  switch (command) {
    case 'help': {
      const result = buildHelp('slash', args[0]);
      return { output: 'error' in result ? result.error : result.text };
    }

    // ─── /portfolio (with subviews) ──────────────────────────────────
    case 'portfolio':
      return handlePortfolioSlash(args[0]);

    // Hidden aliases → /portfolio <subview>
    case 'status':
      return handlePortfolioSlash('status');
    case 'balance':
      return handlePortfolioSlash('balance');
    case 'positions':
      return handlePortfolioSlash('positions');
    case 'orders':
      return handlePortfolioSlash('orders');

    // ─── Trading ─────────────────────────────────────────────────────
    case 'buy':
      return handleTradeCommand('buy', args);
    case 'sell':
      return handleTradeCommand('sell', args);
    case 'cancel':
      return handleCancel(args[0]);

    // ─── /search themes (inline) ─────────────────────────────────────
    // Note: /search <non-themes> is handled in cli.ts via browseController
    case 'themes': {
      const resp = await handleThemes(defaultArgs({ subcommand: 'themes' }));
      return { output: formatThemesHuman(resp.data) };
    }

    // ─── /analyze ────────────────────────────────────────────────────
    case 'analyze':
      return handleAnalyzeCommand(args);

    // ─── /review ─────────────────────────────────────────────────────
    case 'review':
      return handleReviewCommand();

    // ─── /backtest ───────────────────────────────────────────────────
    case 'backtest': {
      // Parse backtest-specific flags from slash command args
      const btArgs: Partial<ParsedArgs> = { subcommand: 'backtest' };
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--resolved') btArgs.resolved = true;
        else if (a === '--unresolved') btArgs.unresolved = true;
        else if (a === '--category') btArgs.category = args[++i];
        else if (a === '--days') { const v = Number(args[++i]); if (Number.isFinite(v) && v > 0) btArgs.days = v; }
        else if (a === '--max-age') { const v = Number(args[++i]); if (Number.isFinite(v) && v > 0) btArgs.maxAge = v; }
        else if (a === '--min-edge') { const v = Number(args[++i]?.replace('%', '')); if (Number.isFinite(v)) btArgs.minEdge = v / 100; }
        else if (a === '--min-volume') { const v = Number(args[++i]); if (Number.isFinite(v) && v >= 0) btArgs.minVolume = v; }
        else if (a === '--min-price') { const v = Number(args[++i]); if (Number.isFinite(v) && v >= 0 && v <= 100) btArgs.minPrice = v; }
        else if (a === '--max-price') { const v = Number(args[++i]); if (Number.isFinite(v) && v >= 0 && v <= 100) btArgs.maxPrice = v; }
        else if (a === '--export') { const v = args[++i]; if (v) btArgs.exportPath = v; }
      }
      const mode = btArgs.resolved ? 'resolved markets' : btArgs.unresolved ? 'open markets' : 'resolved + open markets';
      const daysLabel = btArgs.days ?? 15;
      return {
        output: `Running ${daysLabel}-day backtest on ${mode}...`,
        asyncFollowUp: async () => {
          const resp = await handleBacktest(defaultArgs(btArgs));
          if (!resp.ok || !resp.data) return resp.error?.message ?? 'Backtest failed';
          const text = formatBacktestHuman(resp.data, { minEdge: btArgs.minEdge ?? 0.005 });
          return btArgs.exportPath
            ? `${text}\n\nExported per-market detail to ${btArgs.exportPath}`
            : text;
        },
      };
    }

    case 'config': {
      const resp = await handleConfig(defaultArgs({ subcommand: 'config', positionalArgs: args }));
      if (!resp.ok) {
        const errMsg = (resp as { error?: { message?: string } }).error?.message ?? 'Config error';
        return { output: errMsg };
      }
      return { output: formatConfigHuman(resp.data) };
    }

    default:
      return null;
  }
}


// ─── Portfolio subview handler ──────────────────────────────────────────────

async function handlePortfolioSlash(subview?: string): Promise<CommandResult> {
  const view = subview?.toLowerCase() ?? 'overview';

  try {
    if (view === 'positions') {
      const positions = await fetchOpenPositions();
      return { output: formatPositions(positions) };
    }

    if (view === 'orders') {
      const orders = await fetchRestingOrders();
      return { output: formatOrders(orders) };
    }

    if (view === 'balance') {
      const data = await fetchBalance();
      return { output: formatBalance(data) };
    }

    if (view === 'status') {
      const data = await callKalshiApi('GET', '/exchange/status');
      return { output: formatExchangeStatus(data) };
    }

    // Default: full portfolio overview
    const resp = await handlePortfolio(defaultArgs({ subcommand: 'portfolio' }));
    return { output: formatPortfolioHuman(resp.data) };
  } catch (err) {
    return { output: `Portfolio error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Analyze ────────────────────────────────────────────────────────────────

async function handleAnalyzeCommand(args: string[]): Promise<CommandResult> {
  const ticker = args[0];
  if (!ticker) return { output: 'Usage: /analyze <ticker> [refresh]' };
  const refresh = args[1]?.toLowerCase() === 'refresh';
  try {
    const data = await handleAnalyze(ticker.toUpperCase(), refresh);
    return { output: formatAnalyzeHuman(data) };
  } catch (err) {
    return { output: `Analyze failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Trade command ──────────────────────────────────────────────────────────

async function handleTradeCommand(action: 'buy' | 'sell', args: string[]): Promise<CommandResult> {
  const parsed = parseTradeArgs(args);
  if ('error' in parsed) return { output: parsed.error };

  try {
    let effectivePrice = parsed.price;
    let market;
    if (effectivePrice === undefined) {
      const quoteResult = await fetchMarketQuote(parsed.ticker, action, parsed.side);
      if ('error' in quoteResult) return { output: quoteResult.error };
      effectivePrice = quoteResult.cents;
      market = quoteResult.market;
    } else {
      market = await fetchMarket(parsed.ticker);
    }

    const body: Record<string, unknown> = {
      ticker: parsed.ticker,
      action,
      side: parsed.side,
      type: 'limit',
      ...buildOrderPriceCount({
        side: parsed.side,
        count: parsed.count,
        priceCents: effectivePrice,
        market,
      }),
    };

    const data = await callKalshiApi('POST', '/portfolio/orders', { body });
    const order = data.order as Record<string, unknown> | undefined;
    return {
      output: order
        ? `Order placed. ID: ${order.order_id} | Status: ${order.status}`
        : `Order submitted. Response: ${JSON.stringify(data)}`,
    };
  } catch (err) {
    return { output: `${action} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleReviewCommand(): Promise<CommandResult> {
  try {
    const reviews = await reviewPortfolio();
    return { output: formatReviewHuman(reviews) };
  } catch (err) {
    return { output: `Review failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleCancel(orderId: string | undefined): Promise<CommandResult> {
  if (!orderId) return { output: 'Usage: /cancel <order_id>' };

  try {
    await callKalshiApi('DELETE', `/portfolio/orders/${orderId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.includes('404') ? ' (order not found or already filled)' : '';
    return { output: `Cancel failed: ${msg}${hint}` };
  }
  return { output: `Order ${orderId} canceled.` };
}
