export interface BacktestOpts {
  days: number;               // lookback period in days (default 30)
  resolvedOnly: boolean;
  unresolvedOnly: boolean;
  category?: string;
  minEdge: number;            // fractional (0-1 scale), converted to pp by caller (e.g., 0.005 → 0.5pp)
  exportPath?: string;
}

/** A single scored market signal — unified type for both resolved and unresolved. */
export interface ScoredSignal {
  event_ticker: string;
  market_ticker: string;
  series_category: string;
  model_prob: number;         // 0-100 (Octagon model % from N days ago)
  market_then: number;        // 0-100 (Kalshi trading price N days ago, from Octagon snapshot)
  market_now: number;         // 0-100 (settlement for resolved, current price for unresolved)
  resolved: boolean;
  edge_pp: number;            // model_prob - market_then
  pnl: number;               // computed P&L for this signal ($ per $1 face value)
  capital: number;           // $ capital deployed per $1 face value: kp/100 for YES edges, (100-kp)/100 for NO edges
  edge_bucket: string;        // absolute-edge bucket label e.g. "0-5%", "5-10%", ..., "90%+"
  confidence_score: number;
  close_time: string;
}

export interface BacktestResult {
  verdict: { summary: string; significant: boolean; profitable: boolean };
  days: number;
  events_scored: number;
  markets_resolved: number;
  markets_unresolved: number;
  brier_octagon: number;
  brier_market: number;
  skill_score: number;
  skill_ci: [number, number];
  edge_signals: number;
  edge_hit_rate: number;
  hit_rate_ci: [number, number];
  flat_bet_pnl: number;
  flat_bet_roi: number;       // capital-weighted: sum(pnl) / sum(capital) across edge signals
  total_capital: number;      // sum of capital across edge signals (ROI denominator)
  signals: ScoredSignal[];
  subscription_notice?: string;
}
