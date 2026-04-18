import type { ScoredSignal, BacktestResult } from './types.js';

/**
 * Skill score: how much better Octagon is vs the market as a forecaster.
 * Positive = model beats market. Negative = market is better.
 */
export function computeSkillScore(brierOctagon: number, brierMarket: number): number {
  if (brierMarket === 0) return 0;
  return 1 - (brierOctagon / brierMarket);
}

/**
 * Bootstrap confidence interval for a statistic.
 * Resamples `data` with replacement `iterations` times, computes `statFn` on each sample.
 * Returns [lower, upper] at the given confidence level (default 95%).
 */
export function bootstrapCI(
  data: number[],
  statFn: (sample: number[]) => number,
  iterations = 10_000,
  alpha = 0.05,
): [number, number] {
  if (data.length === 0) return [0, 0];
  if (!Number.isFinite(iterations) || !Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`bootstrapCI: iterations must be a finite integer > 0, got ${iterations}`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error(`bootstrapCI: alpha must be a finite number in (0, 1), got ${alpha}`);
  }

  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < data.length; j++) {
      sample.push(data[Math.floor(Math.random() * data.length)]);
    }
    stats.push(statFn(sample));
  }
  stats.sort((a, b) => a - b);

  if (stats.length === 0) return [0, 0];
  const lo = Math.min(Math.max(0, Math.floor((alpha / 2) * stats.length)), stats.length - 1);
  const hi = Math.min(Math.max(0, Math.floor((1 - alpha / 2) * stats.length)), stats.length - 1);
  return [stats[lo], stats[hi]];
}

/**
 * Compute Brier score: ((forecast/100) - (outcome/100))²
 * Both forecast and outcome are on 0-100 scale.
 */
function brier(forecast: number, outcome: number): number {
  return ((forecast / 100) - (outcome / 100)) ** 2;
}

/**
 * Compute all backtest metrics from a unified list of scored signals.
 */
export function computeMetrics(signals: ScoredSignal[], minEdgePp = 0.5): Omit<BacktestResult, 'subscription_notice'> {
  const n = signals.length;
  if (n === 0) {
    return {
      verdict: { summary: 'No markets with Octagon coverage found.', significant: false, profitable: false },
      days: 0,
      events_scored: 0,
      markets_resolved: 0,
      markets_unresolved: 0,
      brier_octagon: 0,
      brier_market: 0,
      skill_score: 0,
      skill_ci: [0, 0],
      edge_signals: 0,
      edge_hit_rate: 0,
      hit_rate_ci: [0, 0],
      flat_bet_pnl: 0,
      flat_bet_roi: 0,
      total_capital: 0,
      signals: [],
    };
  }

  // Brier scores — model vs market, both compared to outcome (market_now)
  const brierOctagonScores = signals.map(s => brier(s.model_prob, s.market_now));
  const brierMarketScores = signals.map(s => brier(s.market_then, s.market_now));
  const brierOctagon = brierOctagonScores.reduce((a, b) => a + b, 0) / n;
  const brierMarket = brierMarketScores.reduce((a, b) => a + b, 0) / n;

  // Skill score with bootstrap CI — resample both
  const skillScore = computeSkillScore(brierOctagon, brierMarket);
  const indices = signals.map((_, i) => i);
  const skillCI = bootstrapCI(indices, (sample) => {
    let sumOctagon = 0;
    let sumMarket = 0;
    for (const idx of sample) {
      sumOctagon += brierOctagonScores[idx];
      sumMarket += brierMarketScores[idx];
    }
    const avgOctagon = sumOctagon / sample.length;
    const avgMarket = sumMarket / sample.length;
    return avgMarket === 0 ? 0 : 1 - (avgOctagon / avgMarket);
  });

  // Edge signals: where |edge| >= minEdgePp AND edge is non-zero
  const edgeSignals = signals.filter(s => s.edge_pp !== 0 && Math.abs(s.edge_pp) >= minEdgePp);
  const edgeCount = edgeSignals.length;

  // Hit rate: did the market move in the direction the model predicted?
  const hits = edgeSignals.filter(s => {
    // Model said YES (edge > 0): hit if market_now > market_then
    // Model said NO (edge < 0): hit if market_now < market_then
    if (s.edge_pp > 0) return s.market_now > s.market_then;
    return s.market_now < s.market_then;
  });
  const hitRate = edgeCount > 0 ? hits.length / edgeCount : 0;

  // Bootstrap hit rate CI
  const hitRateData = edgeSignals.map(s => {
    if (s.edge_pp > 0) return s.market_now > s.market_then ? 1 : 0;
    return s.market_now < s.market_then ? 1 : 0;
  });
  const hitRateCI = bootstrapCI(hitRateData, (sample) => {
    return sample.reduce((a, b) => a + b, 0) / sample.length;
  });

  // P&L and capital-weighted ROI (matches Supabase methodology):
  //   ROI = sum(pnl) / sum(capital) across edge signals.
  const pnl = edgeSignals.reduce((sum, s) => sum + s.pnl, 0);
  const totalCapital = edgeSignals.reduce((sum, s) => sum + s.capital, 0);
  const roi = totalCapital > 0 ? pnl / totalCapital : 0;

  // Counts
  const uniqueEvents = new Set(signals.map(s => s.event_ticker));
  const resolved = signals.filter(s => s.resolved).length;
  const unresolved = signals.filter(s => !s.resolved).length;

  // Verdict
  const significant = skillCI[0] > 0;
  const profitable = pnl > 0;
  let summary: string;
  if (skillScore > 0.05 && significant && profitable) {
    summary = `Model has edge (Skill +${(skillScore * 100).toFixed(1)}% [CI: +${(skillCI[0] * 100).toFixed(1)}%, +${(skillCI[1] * 100).toFixed(1)}%]; ROI +${(roi * 100).toFixed(1)}%)`;
  } else if (skillScore > 0 && !significant) {
    summary = `Inconclusive — need more data (Skill +${(skillScore * 100).toFixed(1)}%, CI includes zero)`;
  } else {
    summary = `No edge detected (Skill ${(skillScore * 100).toFixed(1)}%)`;
  }

  return {
    verdict: { summary, significant, profitable },
    days: 0, // filled by caller
    events_scored: uniqueEvents.size,
    markets_resolved: resolved,
    markets_unresolved: unresolved,
    brier_octagon: brierOctagon,
    brier_market: brierMarket,
    skill_score: skillScore,
    skill_ci: skillCI,
    edge_signals: edgeCount,
    edge_hit_rate: hitRate,
    hit_rate_ci: hitRateCI,
    flat_bet_pnl: pnl,
    flat_bet_roi: roi,
    total_capital: totalCapital,
    signals,
  };
}
