// S&P 500 constituents fallback. Refresh semi-annually.
// Used when FMP /sp500_constituent is unavailable or not in the user's plan.
//
// TODO: populate full S&P 500 list before production use.
// This seed list covers ~50 confirmed large-cap S&P 500 members (as of early 2026).
// To regenerate: parse https://en.wikipedia.org/wiki/List_of_S%26P_500_companies
// or use FMP /sp500_constituent with a valid API key.
export const SP500_FALLBACK: readonly string[] = [
  // Mega-cap tech
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AVGO", "ORCL",
  // Financials
  "JPM", "BAC", "WFC", "GS", "MS", "BLK", "SCHW", "AXP", "V", "MA",
  // Healthcare
  "UNH", "LLY", "JNJ", "ABBV", "MRK", "ABT", "TMO", "DHR", "PFE", "AMGN",
  // Consumer / Retail
  "WMT", "COST", "HD", "PG", "KO", "PEP", "MCD", "SBUX", "NKE", "TGT",
  // Industrials & Energy
  "XOM", "CVX", "COP", "SLB", "CAT", "DE", "HON", "RTX", "LMT", "GE",
  // Diversified
  "BRK.B", "SPGI", "ICE", "CME", "NEE", "DUK", "SO", "T", "VZ", "CMCSA",
];
