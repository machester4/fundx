// FMP /stable/company-screener parameter constraints.
// Refresh manually when FMP publishes new values.
// Source: https://site.financialmodelingprep.com/developer/docs/stock-screener-api

export const FMP_EXCHANGES_STARTER = [
  "NASDAQ", "NYSE", "AMEX", "CBOE", "OTC", "PNK", "CNQ",
] as const;

export const FMP_EXCHANGES_PREMIUM_EXTRA = [
  "NEO", "TSXV", "TSX", "LSE",
] as const;

export const FMP_EXCHANGES_ALL = [
  ...FMP_EXCHANGES_STARTER,
  ...FMP_EXCHANGES_PREMIUM_EXTRA,
] as const;

export const FMP_SECTORS = [
  "Basic Materials",
  "Communication Services",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Energy",
  "Financial Services",
  "Healthcare",
  "Industrials",
  "Real Estate",
  "Technology",
  "Utilities",
] as const;

export const UNIVERSE_PRESETS = ["sp500", "nasdaq100", "dow30"] as const;
