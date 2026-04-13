# Equity & ETF Screening Strategies — Literature Catalogue

A literature-grounded catalogue of mechanical **screening** methods for equities and
ETFs, organised by factor family. Screening is the step that reduces a broad universe
to a shortlist of candidates; downstream analysis (thesis, risk, sizing) is covered
in `research/investment-analysis-best-practices.md` and in the per-fund skills.

Every strategy section follows a fixed schema: intuition with a citation, executable
screening rules, feasibility in FundX today, which fund types it serves, caveats, and
references. Feasibility is tagged with three levels:

- ✅ **FMP wired** — data is already accessible through endpoints currently used by FundX (`/quote`, `/historical-chart/15min`, `/stock_news`, `/is-the-market-open`).
- ⚠️ **FMP available, not wired** — the data exists in Financial Modeling Prep's API but FundX has no integration yet; requires adding a new fetch in `src/services/market.service.ts` or an MCP tool.
- ❌ **Needs new data source** — not in FMP or Yahoo; requires a new provider (e.g. SEC EDGAR, Quandl, alternative data).

Where a specific statistic is recalled but not verifiable in-session it is marked
inline with `⚠️ verify`. Paper titles and authors are cited only where the attribution
is well-established; uncertain attributions are marked `⚠️ verify attribution`.

---

## 1. Introduction

### 1.1 Screening vs. analysis

A **screen** is a mechanical filter applied to a universe (e.g. Russell 3000) that
returns a shortlist — typically 10–100 names — ranked by one or more signals. A screen
is deterministic, repeatable, and auditable: given the same universe and date, it
must return the same list. Analysis takes those candidates and applies judgement,
thesis construction, catalyst review, and position sizing.

Separating the two matters for three reasons:

1. **Decision hygiene.** Narrative and story bias pollute analysis. A mechanical
   screen gives analysis a pre-committed opportunity set that prevents "I saw this
   stock on CNBC" anchoring.
2. **Turnover discipline.** Screens force an explicit rebalance cadence. Without
   one, holdings drift on ad-hoc stimulus.
3. **Attribution.** When you know exactly which screen surfaced a name, you can
   evaluate which screens actually produce winning candidates over time and which
   just add noise. This is the raw material for fund-level learning.

### 1.2 Biases that break screens

Any screen built on historical data is exposed to three classical biases:

- **Survivorship bias.** If the universe is "S&P 500 today", it excludes every
  company that was delisted, went bankrupt, or was acquired at a loss. A backtest on
  a survivorship-biased universe systematically overstates returns. Use point-in-time
  constituent sets where possible.
- **Look-ahead bias.** Using data that would not have been available on the
  screening date (e.g. restated earnings, late 10-K filings treated as known at
  quarter-end). For fundamentals-based screens, lag reported data by at least one
  quarter plus filing delay.
- **Data snooping / multiple testing.** If you try enough screen variants on the
  same history, one will fit by chance. Combat this with out-of-sample testing,
  Bonferroni-style correction, or by only running variants pre-registered against
  academic priors.

A fourth bias specific to AI-assisted screening: **data-generation bias**. If an
agent cites statistics it "recalls" without pulling them from a tool, the numbers
may be fabricated. Every stat in a live screen must come from a tool call in the
current session, or be clearly marked as unverified.

### 1.3 Data source legend

Throughout this document:

| Source | Coverage | Wired in FundX |
|---|---|---|
| FMP `/quote` | Real-time quote, prev close, change | ✅ |
| FMP `/historical-chart/15min` | Intraday bars | ✅ |
| FMP `/stock_news` | Recent headlines | ✅ |
| FMP `/historical-price-full` | Daily OHLCV (long history) | ⚠️ available |
| FMP `/ratios`, `/key-metrics`, `/income-statement` | Fundamentals | ⚠️ available |
| FMP `/insider-trading`, `/institutional-holder` | Ownership flow | ⚠️ available |
| Yahoo Finance (via `yfinance`) | Fallback quote/fundamentals | ✅ |
| News MCP | Headline + RSS with semantic retrieval | ✅ |
| SEC EDGAR | Filings, 13F, Form 4 | ❌ |

---

## 2. Value

Value investing screens rank securities by how cheaply they trade relative to
fundamentals, on the prior that cheap tends to beat expensive across long horizons.
Fama and French's three-factor model (Fama & French, 1992, *Journal of Finance*)
documented the HML ("high minus low") book-to-market premium that anchors academic
value research.

### Classic multiples (P/E, P/B, EV/EBITDA)

**Intuition.** Prices reflect expectations; cheap multiples mean expectations are
low. On average, low-multiple names mean-revert upward over multi-year horizons,
though individual cheap names can be cheap because they deserve to be. Fama–French
(1992) is the canonical reference for the book-to-market effect; subsequent work
(Asness, Moskowitz & Pedersen, 2013, *Journal of Finance*, "Value and Momentum
Everywhere") extended the result across asset classes and geographies.

**Screening rules.**
- Inputs: trailing P/E, P/B, EV/EBITDA; sector classification.
- Filters (priority order):
  1. Positive trailing earnings (exclude loss-makers unless deliberately targeting deep value).
  2. Rank within sector — cross-sector comparisons are mostly noise because multiples embed capital intensity and growth.
  3. Keep bottom quintile (bottom 20%) on the chosen multiple within each sector.
  4. Liquidity floor: average daily dollar volume > $5M (adjust to fund size).
- Ranking: composite z-score across the three multiples within sector; lower = cheaper.
- Rebalance: quarterly. Multiples change slowly; monthly churn adds cost without edge.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Requires integrating
`/ratios` and `/key-metrics` endpoints.

**Serves fund types:** accumulation (DCA into persistently cheap positions), custom,
and the value sleeve of growth funds that want a "cheap growth" filter.

**Caveats.** Value has had extended drawdowns (notably 2017–2020) where growth
crushed it. Sector concentration — value screens routinely over-weight financials
and energy. "Value trap" risk: the cheapest decile contains structurally impaired
businesses whose multiples never recover.

**References:** Fama & French (1992); Asness, Moskowitz & Pedersen (2013).

### Piotroski F-Score

**Intuition.** Cheap stocks beat the market on average, but within the cheap bucket,
companies with improving fundamentals outperform those with deteriorating
fundamentals. Joseph Piotroski (2000, *Journal of Accounting Research*, "Value
Investing: The Use of Historical Financial Statement Information to Separate Winners
from Losers in Value Stocks") documented that a simple 9-point financial-health
score, applied within high-book-to-market stocks, generated substantial excess
returns.

**Screening rules.**
- Inputs: income statement, balance sheet, and cash flow statement — current and prior year.
- Filters: restrict to the top book-to-market quintile first, then score each name on nine binary tests (1 if condition met, 0 otherwise):
  1. Net income > 0 (current year).
  2. Operating cash flow > 0.
  3. Return on assets improved year-over-year.
  4. Operating cash flow > net income (quality of earnings).
  5. Long-term debt ratio decreased year-over-year.
  6. Current ratio increased year-over-year.
  7. No new share issuance (shares outstanding not up).
  8. Gross margin improved year-over-year.
  9. Asset turnover improved year-over-year.
- Ranking: sum the nine scores. Keep F-Score ≥ 7 (strong); avoid F-Score ≤ 2 (weak).
- Rebalance: annually, after full-year filings are available (lag ~90 days after fiscal year-end).

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Needs `/income-statement`,
`/balance-sheet-statement`, `/cash-flow-statement` integration.

**Serves fund types:** accumulation, custom, runway (the high-F-Score subset is
notably more defensive than raw value).

**Caveats.** F-Score is computed once a year; it's a slow screen. It assumes
accurate, un-restated filings — use as-reported, not restated. Small-cap bias:
Piotroski's original sample skewed to micro-cap where effect sizes are largest.

**References:** Piotroski (2000).

### Greenblatt Magic Formula

**Intuition.** Joel Greenblatt (2005, *The Little Book That Beats the Market*)
proposed a two-variable screen: rank stocks by (1) earnings yield = EBIT / Enterprise
Value, and (2) return on capital = EBIT / (Net Working Capital + Net Fixed Assets).
Sum the ranks; buy the top 20–30. The formula is "cheap + quality" distilled.

**Screening rules.**
- Inputs: EBIT, enterprise value (market cap + net debt), net working capital, net fixed assets.
- Filters:
  1. Exclude financials and utilities (ratios distort for them).
  2. Market cap > $100M (Greenblatt's own guideline for individual investors; adjust for liquidity).
  3. Exclude foreign ADRs unless explicitly desired.
- Ranking:
  - Rank 1 = highest earnings yield.
  - Rank 2 = highest return on capital.
  - Composite = Rank 1 + Rank 2. Lower total = better.
- Rebalance: annually, with tax-lot awareness (sell losers before 1-year mark, winners after, per Greenblatt's original guidance).

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Same data dependency
as classic multiples plus balance-sheet items.

**Serves fund types:** accumulation, growth (as a "cheap quality" sleeve), custom.

**Caveats.** Simplicity is both virtue and risk — the formula has no sector or
regime filter and will over-weight whichever cluster happens to be cheap. Live
performance since the book's publication has been less spectacular than the
back-test ⚠️ verify — factor crowding is the usual suspect.

**References:** Greenblatt (2005).

### Graham deep value / net-nets

**Intuition.** Benjamin Graham's most mechanical screen (Graham, 1949, *The
Intelligent Investor*): buy stocks trading below net current asset value (NCAV),
defined as current assets minus total liabilities. The implied assumption is that
the business could be liquidated for more than its market cap. In modern markets
these are extremely rare, biased toward micro-cap and often impaired, but the
screen still surfaces occasional distressed opportunities.

**Screening rules.**
- Inputs: current assets, total liabilities, shares outstanding, market cap.
- Filters:
  1. Market cap < NCAV × 0.67 (classic 2/3 discount).
  2. Current ratio > 1.5 (avoid businesses in active liquidation stress).
  3. Positive operating cash flow in trailing twelve months.
  4. Market cap > $20M (below this, spreads are prohibitive).
- Ranking: largest discount to NCAV first.
- Rebalance: quarterly; these names are volatile and the pool changes fast.

**Feasibility in FundX today:** ⚠️ FMP available, not wired; balance sheet required.

**Serves fund types:** custom (niche). Not appropriate for runway (drawdown risk)
or income.

**Caveats.** Extreme illiquidity; position sizing must reflect that. Many names are
permanently impaired — treat each as a specific-situation analysis, not a basket.
The screen produces near-empty results in bull markets.

**References:** Graham (1949); Oppenheimer, H. (1986), *Financial Analysts Journal*,
"Ben Graham's Net Current Asset Values: A Performance Update".

### Shiller CAPE (index-level)

**Intuition.** The cyclically-adjusted price-to-earnings ratio (CAPE, or P/E10),
popularised by Robert Shiller (Shiller, 2000, *Irrational Exuberance*), divides a
broad index's price by the 10-year average of inflation-adjusted earnings. High CAPE
has historically been associated with lower subsequent 10-year real returns. CAPE is
not a stock screen — it's a regime input that tells a screen how aggressive to be.

**Screening rules (as a regime filter).**
- Inputs: S&P 500 CAPE (published monthly by Shiller / Yale).
- Filters: define three regimes:
  - CAPE < 16: below-average — growth screens get full weight, value screens tilt smaller.
  - CAPE 16–24: average — neutral weighting.
  - CAPE > 30: rich — defensive/low-vol/quality screens get additional weight; momentum gets tightened stops.
- Rebalance: monthly (CAPE moves slowly).

**Feasibility in FundX today:** ❌ Needs new data source (Shiller publishes a CSV;
could be scraped or fetched monthly).

**Serves fund types:** all — regime input, not a stock screen.

**Caveats.** CAPE has been "elevated" since ~2013 ⚠️ verify and has given few tradeable
signals across the 2010s. Single-country, single-metric regime inputs can be gamed by
fitting history. Use CAPE as one input among several, not as a single switch.

**References:** Shiller (2000); Campbell & Shiller (1988), *Review of Financial
Studies*, "The Dividend-Price Ratio and Expectations of Future Dividends and
Discount Factors".

---

## 3. Momentum

Momentum is the empirical regularity that past winners tend to keep winning over
horizons of 3–12 months and past losers keep losing. Jegadeesh and Titman (1993,
*Journal of Finance*, "Returns to Buying Winners and Selling Losers") is the
foundational paper; Asness, Moskowitz and Pedersen (2013) established the effect
across asset classes.

### Cross-sectional 12-1 momentum

**Intuition.** Rank stocks by their 12-month total return, skipping the most recent
month to avoid short-term reversal. Buy the top decile, hold 1–3 months, rotate.
The "skip one month" convention is empirically important — Jegadeesh (1990) showed
that the last month tends to mean-revert.

**Screening rules.**
- Inputs: 13 months of daily total returns (need dividend-adjusted prices).
- Filters:
  1. Liquidity floor: average daily dollar volume > $10M.
  2. Price floor: > $5 per share (penny-stock noise).
  3. Exclude names with extreme single-day moves > 20% in the ranking window (avoid merger arbitrage noise) ⚠️ verify magnitude threshold.
- Ranking: cumulative return from month t-12 to t-1 (skip the last month). Top decile = "winners".
- Rebalance: monthly. Holding period 1–3 months; the effect decays beyond 6 months.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Requires daily
historical-price-full with dividend adjustment.

**Serves fund types:** growth (primary), accumulation (as entry timing within a
pre-selected universe).

**Caveats.** Momentum crashes. Daniel & Moskowitz (2016, *Journal of Financial
Economics*, "Momentum Crashes") documented severe momentum drawdowns following bear
market bottoms — when the market turns, prior losers snap back hardest. Stop-loss
and regime filters (see section 10) mitigate but don't eliminate. High turnover →
transaction cost drag.

**References:** Jegadeesh & Titman (1993); Asness, Moskowitz & Pedersen (2013);
Daniel & Moskowitz (2016).

### Time-series momentum / trend-following

**Intuition.** Rather than ranking across a cross-section, ask whether each asset's
own recent return is positive. If yes, hold; if no, go to cash or short. Moskowitz,
Ooi and Pedersen (2012, *Journal of Financial Economics*, "Time Series Momentum")
established the effect at the asset-class level; it's the engine of most CTA /
managed-futures strategies.

**Screening rules (applied per-instrument, not cross-sectional).**
- Inputs: daily closes, 252 days minimum.
- Signal: asset's trailing 12-month return excess of risk-free > 0 → in; else → out.
- Alternative signals:
  - 200-day moving average: price > 200DMA → in; price < 200DMA → out.
  - Dual moving average crossover (e.g., 50DMA vs 200DMA): golden cross → in; death cross → out.
- Rebalance: monthly or weekly depending on noise tolerance.

**Feasibility in FundX today:** ⚠️ FMP available, not wired for daily history. ETF
trend filters at the index level (SPY, QQQ) are a cheap regime overlay.

**Serves fund types:** runway (as a risk-off trigger — exit risk assets below
200DMA), growth, accumulation.

**Caveats.** Whipsaw in range-bound markets. Trend signals give up early gains at
turns because confirmation requires several bars. Per-asset trend overlays on
equities are correlated — diversification benefit is lower than on a multi-asset
basket.

**References:** Moskowitz, Ooi & Pedersen (2012); Faber (2007), "A Quantitative
Approach to Tactical Asset Allocation", *Journal of Wealth Management*.

### IBD-style Relative Strength (RS)

**Intuition.** William O'Neil's CAN SLIM methodology (O'Neil, 1988, *How to Make
Money in Stocks*) operationalised momentum as a relative-strength rank from 1 to 99
(percentile vs the universe). O'Neil's guidance: only buy RS ≥ 80, prefer RS ≥ 90.
This is essentially cross-sectional momentum with an accessible presentation layer.

**Screening rules.**
- Inputs: 12-month total return (or weighted: 40% last 3 months, 20% each prior quarter, per IBD's weighting ⚠️ verify weighting).
- Filters:
  1. RS ≥ 80 within the broad-market universe (e.g. Russell 3000).
  2. Price > $15 (O'Neil's heuristic to avoid low-priced noise).
  3. Paired with earnings acceleration — CAN SLIM wants EPS growth ≥ 25% YoY.
- Ranking: RS rank descending.
- Rebalance: weekly (O'Neil's own cadence was aggressive).

**Feasibility in FundX today:** ⚠️ Partial. RS calculation needs daily history
(not wired). Earnings growth needs fundamentals (not wired).

**Serves fund types:** growth (canonical).

**Caveats.** Tightly coupled to bull markets. O'Neil's system has explicit sell
rules (8% hard stop, position-level) that must be respected or the system breaks.
Not a standalone screen — it's one pillar of CAN SLIM.

**References:** O'Neil (1988).

### Earnings momentum (SUE, estimate revisions)

**Intuition.** Post-earnings-announcement drift (PEAD): stocks that beat earnings
keep outperforming for weeks after the announcement, and stocks that miss keep
underperforming. The Standardised Unexpected Earnings (SUE) measure normalises the
surprise by its historical volatility. Bernard and Thomas (1989, *Journal of
Accounting Research*) is the canonical PEAD paper. Estimate-revision momentum — the
path of analyst estimates rather than a single print — is a smoother signal
(Chan, Jegadeesh & Lakonishok, 1996, *Journal of Finance*).

**Screening rules.**
- Inputs: last 8 quarters of actual EPS and analyst consensus; current quarter's
  consensus path over the past 90 days.
- Filters:
  1. Most recent quarter SUE > +1 standard deviation (positive surprise).
  2. Forward EPS estimate revised up by ≥ 3% in the last 30 days.
  3. No negative pre-announcement (pre-announcement warns of mean reversion).
- Ranking: composite of SUE z-score and 30-day estimate revision percentage.
- Rebalance: event-driven — names enter on earnings day, hold 4–8 weeks, then exit.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Requires earnings
history and analyst estimates (FMP `/earnings-surprises`, `/analyst-estimates`).

**Serves fund types:** growth (primary), income (as a quality confirmation rather
than a primary screen).

**Caveats.** Event-driven → concentrated in earnings seasons. Estimates can be
"managed" — set low for easy beat — so extreme-beat names sometimes underperform.
PEAD magnitude has shrunk since the 1990s ⚠️ verify, consistent with factor
crowding.

**References:** Bernard & Thomas (1989); Chan, Jegadeesh & Lakonishok (1996).

---

## 4. Quality

Quality factors identify businesses with durable economic characteristics —
profitability, stability, balance-sheet strength — that support longer-term
compounding. Unlike value, which buys cheap regardless of business quality, quality
buys good regardless of price. The two combine powerfully.

### Gross profitability (Novy-Marx)

**Intuition.** Robert Novy-Marx (2013, *Journal of Financial Economics*, "The Other
Side of Value: The Gross Profitability Premium") showed that gross profits divided
by total assets predicts future returns about as strongly as book-to-market — but in
the opposite direction relative to value signals. High gross profitability is a
simpler, more robust quality proxy than net-income-based metrics, because gross
profits are less distorted by accruals and discretionary items.

**Screening rules.**
- Inputs: gross profit (revenue minus COGS), total assets.
- Filters:
  1. Exclude financials and real-estate (different cost structure).
  2. Gross profitability = Gross Profit / Total Assets.
- Ranking: top quintile of gross profitability within sector.
- Rebalance: annually (stable across quarters).

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Needs `/income-statement`
and `/balance-sheet-statement`.

**Serves fund types:** growth (quality sleeve), runway (stable-compounder screen),
income (overlay on dividend names to avoid yield traps).

**Caveats.** Gross profitability is noisy in cyclicals because gross margin compresses
near cycle peaks. Mixing gross profitability with value (Novy-Marx's original pairing)
is empirically the strongest combination; standalone it's weaker.

**References:** Novy-Marx (2013).

### Accruals & earnings quality

**Intuition.** Sloan (1996, *The Accounting Review*, "Do Stock Prices Fully Reflect
Information in Accruals and Cash Flows About Future Earnings?") showed that
companies with high accruals — meaning reported earnings exceed operating cash flow
— systematically underperform. High accruals flag aggressive revenue recognition or
working-capital build; low accruals flag conservative accounting.

**Screening rules.**
- Inputs: net income, operating cash flow.
- Filter: accruals = (Net Income − Operating Cash Flow) / Average Total Assets.
- Keep: lowest accruals decile (best earnings quality). Exclude top decile (red flag).
- Rebalance: annually.

**Feasibility in FundX today:** ⚠️ FMP available, not wired.

**Serves fund types:** runway, accumulation, income (accrual red flags correlate
with dividend cuts).

**Caveats.** The accruals effect has weakened since Sloan published ⚠️ verify, and
is stronger in small-cap than large-cap. Works best as an exclusion filter (avoid
top decile) rather than a selection filter (buy bottom decile).

**References:** Sloan (1996).

### Asness QMJ (Quality Minus Junk)

**Intuition.** Asness, Frazzini and Pedersen (AQR working paper, "Quality Minus
Junk", 2019 version) constructed a multi-dimensional quality composite: high
profitability + high growth in profitability + high safety (low beta, low leverage,
low volatility) + high payout to shareholders. Quality defined this way has earned
a persistent premium and, critically, diversifies value.

**Screening rules.**
- Inputs: profitability metrics (gross profit/assets, ROA, ROE), growth in
  profitability (year-over-year deltas), safety (beta, leverage, earnings volatility),
  payout (buybacks + dividends / net income).
- Filter: z-score each sub-component within sector, sum to composite quality score.
- Ranking: top quintile of composite Q-score.
- Rebalance: quarterly.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. This is one of the
more data-hungry screens — needs fundamentals plus price history for beta/vol.

**Serves fund types:** runway (safety component heavy), growth (profitability
component heavy), income (payout component heavy). Quality is the factor that most
naturally cuts across fund types.

**Caveats.** Composite construction is subjective — different weightings produce
different portfolios. Quality can underperform sharply in "junk rallies" (low-quality
leveraged names flying off the lows, e.g. Q2 2020).

**References:** Asness, Frazzini & Pedersen (2019, AQR working paper; journal
version in *Review of Accounting Studies*, 2019).

### Balance-sheet strength

**Intuition.** A simpler quality lens: companies that can survive a bad year tend to
compound over decades. The defensive screen here is explicit — limit leverage, require
liquidity, avoid interest-coverage fragility.

**Screening rules.**
- Inputs: total debt, total equity, current assets, current liabilities, EBIT,
  interest expense.
- Filters (all required):
  1. Debt/Equity < 1 (sector-adjusted — utilities and REITs are exempt).
  2. Current ratio > 1.5.
  3. Interest coverage (EBIT / interest expense) > 5.
  4. Positive free cash flow in each of the last 3 years.
- Ranking: composite safety score (z-score sum of the above).
- Rebalance: annually.

**Feasibility in FundX today:** ⚠️ FMP available, not wired.

**Serves fund types:** runway (canonical), income (protects against dividend cuts),
custom.

**Caveats.** Strong balance sheets can mean under-utilised capital; the screen
biases away from companies that aggressively use leverage, which in stable
industries can be rational. Pair with profitability filters to avoid "safe and
mediocre" businesses.

**References:** Altman (1968), *Journal of Finance*, "Financial Ratios, Discriminant
Analysis and the Prediction of Corporate Bankruptcy" — the Z-Score is a standard
bankruptcy-proximity composite and a useful exclusion filter.

---

## 5. Low-Volatility / Defensive

The low-volatility anomaly is the finding that low-vol stocks have historically
earned returns comparable to or exceeding the market with substantially lower risk —
violating the CAPM prediction that higher beta should mean higher return. This is
one of the most robust cross-sectional patterns in equity returns.

### Min-vol / low-vol

**Intuition.** Clarke, de Silva and Thorley (2006, *Journal of Portfolio Management*,
"Minimum-Variance Portfolios in the U.S. Equity Market") constructed minimum-variance
portfolios from the S&P 500 and found returns comparable to the cap-weighted index
with ~25% lower volatility ⚠️ verify. The Frazzini-Pedersen BAB paper (below)
provides a theoretical argument: leverage constraints make investors overpay for
high-beta stocks, leaving a premium in low-beta names.

**Screening rules.**
- Inputs: 252 days of daily returns.
- Signal: trailing 1-year realised volatility (standard deviation of daily returns, annualised).
- Filter: bottom quintile of volatility within the universe.
- Ranking: lowest vol first, within sector to avoid over-concentration in utilities/staples.
- Rebalance: quarterly.

**Feasibility in FundX today:** ⚠️ FMP available, not wired (daily history needed).
Alternatively, use low-vol ETFs (USMV, SPLV) as a proxy bucket — these are
tradeable via `/quote`.

**Serves fund types:** runway (canonical), income (pairs with dividend screens),
accumulation.

**Caveats.** Low-vol underperforms in rip-your-face rallies (e.g. Q2 2020, tech
2023). It often concentrates in utilities, staples, and REITs — rate-sensitive
sectors that can all move together when yields spike.

**References:** Clarke, de Silva & Thorley (2006); Ang, Hodrick, Xing & Zhang (2006,
*Journal of Finance*, "The Cross-Section of Volatility and Expected Returns").

### BAB / Beta anomaly (Frazzini-Pedersen)

**Intuition.** Frazzini and Pedersen (2014, *Journal of Financial Economics*,
"Betting Against Beta") extended the low-vol finding: after adjusting for leverage,
low-beta assets earn higher risk-adjusted returns than high-beta assets across asset
classes. The signal is beta-rank rather than raw vol.

**Screening rules.**
- Inputs: beta estimated over 252 days vs a market index (SPY).
- Signal: ex-ante beta = correlation × (stock vol / market vol).
- Filter: bottom quintile of beta, excluding names with beta < 0.1 (those are
  usually thinly traded or have data issues).
- Ranking: lowest beta within sector.
- Rebalance: quarterly.

**Feasibility in FundX today:** ⚠️ FMP available, not wired.

**Serves fund types:** runway (risk-off overlay), income.

**Caveats.** Betas are unstable — small-cap betas especially so. Beta screens and
low-vol screens produce overlapping but not identical portfolios; pick one, don't
double-count.

**References:** Frazzini & Pedersen (2014).

### Max-drawdown screens

**Intuition.** For fund types with hard capital-preservation objectives (runway),
the statistic that matters is not volatility but drawdown. Two assets with identical
vol can have very different drawdown profiles; left-tail risk is what runway
funds cannot tolerate.

**Screening rules.**
- Inputs: 3–5 years of daily prices.
- Signal: maximum drawdown over the lookback window = 1 − min(price_t / max(price_{t-k} for k ≤ t)).
- Filter: exclude names with max drawdown > 40% in the lookback.
- Alternative: conditional VaR (expected loss in worst 5% of days) < 3% daily ⚠️ verify threshold.
- Rebalance: semi-annually.

**Feasibility in FundX today:** ⚠️ FMP available, not wired.

**Serves fund types:** runway (canonical), income.

**Caveats.** Historic drawdown doesn't predict future drawdown as well as volatility
does — drawdowns are cluster-dependent and regime-specific. Use as an exclusion
filter, not a ranking signal.

**References:** Calmar ratio (Young, 1991); general risk-management literature.

### Dividend aristocrats

**Intuition.** The "Dividend Aristocrats" list (S&P 500 constituents that have
raised dividends every year for 25+ years) is a crude but effective quality-plus-
income screen. The 25-year hurdle mechanically excludes anyone who has cut in a
recession.

**Screening rules.**
- Inputs: 25 years of dividend history per stock.
- Filters:
  1. Member of S&P 500 (or qualifying large-cap index).
  2. Unbroken streak of 25 consecutive annual dividend increases.
  3. Payout ratio < 80% (sustainability check; the official Aristocrats list doesn't enforce this but should).
- Ranking: payout ratio ascending (more room to grow), or yield descending within screen.
- Rebalance: annually — the list changes slowly.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Long dividend history
is the constraint; alternatively track the NOBL ETF.

**Serves fund types:** income (primary), runway.

**Caveats.** Selection by survival — the current list is survivor-biased. Ex-post
aristocrats are not ex-ante great picks; companies enter the list only after the
25-year track record is complete. Highly concentrated in industrials, staples,
and financials. Dividend-cut shock risk (e.g. banks in 2008) is real.

**References:** Standard & Poor's methodology documentation; academic literature
on dividend predictability is more mixed than the branding suggests.

---

## 6. Size & Liquidity

### Small-cap premium (SMB) with caveats

**Intuition.** Banz (1981, *Journal of Financial Economics*) documented that small
stocks beat large stocks on a risk-adjusted basis. Fama and French canonised this as
SMB ("small minus big"). The premium has been weaker and more debated since
publication; subsequent research (Asness, Frazzini, Israel, Moskowitz & Pedersen,
2018, *Financial Analysts Journal*, "Size Matters, If You Control Your Junk")
argues the size premium is real but only after filtering out "junk" small-caps —
the bottom end of quality ruins the average.

**Screening rules.**
- Inputs: market cap; fundamentals for quality overlay.
- Filters:
  1. Market cap in the 20th–50th percentile of the broad universe (small but not micro).
  2. Quality overlay: positive TTM operating income, positive FCF, F-Score ≥ 5.
  3. Price > $5, ADV > $2M.
- Ranking: composite of market-cap-rank (smaller = better, within the bounded range) + quality-rank.
- Rebalance: quarterly.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Approximate via
small-cap ETFs (IWM, IJR) when fund type allows ETF proxies.

**Serves fund types:** growth, accumulation (especially if fund's target is broad
equity exposure), custom.

**Caveats.** Higher vol and higher transaction cost. Small-caps have gone through
multi-year periods of pure underperformance (notably 2014–2019 in the US). SMB
returns are heavily concentrated in January historically ⚠️ verify.

**References:** Banz (1981); Asness, Frazzini, Israel, Moskowitz & Pedersen (2018).

### Illiquidity premium

**Intuition.** Amihud (2002, *Journal of Financial Markets*, "Illiquidity and Stock
Returns: Cross-Section and Time-Series Effects") documented that less liquid stocks
earn a return premium, compensating investors for bearing trading-cost risk. Amihud's
measure: daily |return| / daily dollar volume, averaged.

**Screening rules.**
- Inputs: daily returns and daily dollar volume.
- Signal: Amihud illiquidity measure = mean over window of |r_t| / DollarVolume_t.
- Filter: top third of illiquidity within a market-cap bucket (size-controlled).
- Rebalance: quarterly.

**Feasibility in FundX today:** ⚠️ FMP available, not wired.

**Serves fund types:** custom (niche). Not suitable for fast-rebalancing strategies
or small individual fund sizes where the trading costs outweigh the premium.

**Caveats.** Illiquidity cuts both ways — your own trading costs rise. For FundX-
scale portfolios (individual investor, $10k–$500k), the premium is likely eaten by
slippage and spread.

**References:** Amihud (2002); Pástor & Stambaugh (2003), *Journal of Political
Economy*, "Liquidity Risk and Expected Stock Returns".

### Market-cap floors for FundX position sizing

**Intuition.** Not a factor screen — an infrastructure rule. Any fund at any size
should cap position size as a fraction of the target stock's average daily volume,
so that entry and exit don't move the market against the fund. This is a screening
filter because it determines which tickers are tradeable at all.

**Screening rules.**
- Inputs: 30-day average daily dollar volume (ADV).
- Filter: position size ≤ 1% of ADV at target weight (aggressive), ≤ 0.25% (conservative).
- For FundX fund sizes:
  - $10k–$50k fund: almost no liquidity constraint; avoid sub-$2M ADV.
  - $50k–$500k fund: ADV > $5M recommended.
  - $500k–$5M fund: ADV > $25M recommended.

**Feasibility in FundX today:** ✅ Partial via `/quote` (which returns volume,
though not 30-day average). Robust version requires `/historical-price-full`.

**Serves fund types:** all — sizing prerequisite.

**Caveats.** Volume concentrates at open/close; intraday ADV alone misstates
available liquidity. For thinly traded names, check bid-ask spread too (FMP quote
includes bid/ask on some tiers).

**References:** Kyle (1985), *Econometrica*, "Continuous Auctions and Insider
Trading" — classic market-impact reference.

---

## 7. Income-Specific Screens

Income screens select for cash distributions to shareholders. The entire family
faces one overriding risk: yield traps — high yields resulting from falling prices
of distressed businesses that subsequently cut. Every income screen needs
sustainability gates.

### Dividend yield with sustainability gates

**Intuition.** Raw dividend yield has a reasonable long-run premium (Fama & French
"DIV" factor; numerous dividend-tilt indices) but only once the high-yield trap is
removed. The sustainability gates below are the mechanical version of "check if
the dividend will still be there next year".

**Screening rules.**
- Inputs: trailing 12-month dividends, TTM earnings, TTM free cash flow, debt ratios,
  5-year dividend history.
- Filters (priority order):
  1. Yield > 3% (below this, the factor premium isn't meaningful).
  2. Payout ratio (dividends / net income) < 70%.
  3. FCF coverage (FCF / dividends) > 1.5.
  4. No dividend cut in the last 10 years.
  5. Debt/Equity < 1.5 (sector-adjusted).
  6. Market cap > $1B (liquidity and credit quality).
- Ranking: yield descending within filtered set.
- Rebalance: semi-annually.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Dividend history and
fundamentals.

**Serves fund types:** income (canonical), runway (secondary — income as
distributions, not total return).

**Caveats.** Sector concentration in utilities, REITs, and financials. Rate-
sensitivity: every rate shock that widens bond spreads hits this bucket. Some
high-FCF-coverage names still cut dividends for strategic reasons (e.g. redirecting
to buybacks); the screen doesn't see strategic intent.

**References:** Fama & French (1988), "Dividend yields and expected stock returns",
*Journal of Financial Economics*.

### Dividend growth (CCC-style)

**Intuition.** Dividend growth — not just yield — correlates with business quality
and tends to beat raw yield on a total-return basis over multi-decade spans. The
"Champions, Contenders, Challengers" (CCC) list, maintained by DRIPinvesting.org,
groups stocks by consecutive years of dividend increases (25+, 10+, 5+). Focus on
Contenders (10–24 years) rather than Champions to avoid the "already a household
name" premium.

**Screening rules.**
- Inputs: 10+ years of dividend history, payout ratio, 5-year dividend CAGR.
- Filters:
  1. Consecutive years of dividend increases ≥ 10.
  2. 5-year dividend CAGR > 5% AND > inflation.
  3. Payout ratio < 70%.
  4. Yield > 1.5% (exclude sub-yielding growers where the dividend is a formality).
- Ranking: (5-year dividend CAGR + current yield) × payout-ratio penalty.
- Rebalance: annually.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Alternatively, track
the NOBL / VIG / SDY ETFs as proxies.

**Serves fund types:** income, accumulation (long-horizon compounding), custom.

**Caveats.** Long dividend-growth streaks can coexist with stagnant businesses
(e.g. utility that raises 2% annually forever). The CAGR filter above mitigates
this. In a recession, even "aristocrat" track records break — 2020 saw several.

**References:** Goldman Sachs / S&P research on dividend growers ⚠️ verify; academic
coverage is sparse because the strategy is practitioner-driven.

### REITs & sector-specific income

**Intuition.** REITs are a distinct income sleeve. By law they must distribute ≥ 90%
of taxable income, so standard payout ratios look artificially high. The sustainability
gate changes: measure payout against adjusted funds from operations (AFFO), not net
income.

**Screening rules.**
- Inputs: FFO, AFFO, dividend, debt/total assets, occupancy (for equity REITs), rate
  sensitivity proxies.
- Filters:
  1. Yield > 4% (REITs trade at higher average yield than the market).
  2. AFFO payout ratio < 85%.
  3. Debt / total assets < 50%.
  4. 5-year AFFO per share growth > 0.
- Ranking: AFFO yield (= AFFO / price) descending.
- Rebalance: semi-annually.

**Feasibility in FundX today:** ❌ FFO / AFFO are not standard FMP endpoints
(computed from specific line items with sector-specific adjustments). Requires
REIT-specific data source.

**Serves fund types:** income (diversifier), custom.

**Caveats.** Rate sensitivity is extreme — 10Y yield moves directly translate to
REIT price moves. Different REIT subsectors (residential, industrial, retail,
healthcare, data center) have different drivers and should be screened separately.

**References:** Green Street Advisors research (industry-standard REIT valuation);
Nareit's investor materials.

---

## 8. Technical & Event-Driven Screens

Technical screens use price and volume; event-driven screens use catalysts. Both
sit closer to execution than academic factors — they have shorter holding periods,
higher turnover, and require tighter risk management. They are less academically
anchored than the prior sections; some effects (PEAD, insider buying) have peer-
reviewed foundations, others (VCP, breakout systems) are primarily practitioner
literature.

### 52-week-high / new-high screens

**Intuition.** George and Hwang (2004, *Journal of Finance*, "The 52-Week High and
Momentum Investing") showed that proximity to 52-week highs is a strong momentum
signal — stronger than raw 12-1 momentum in their sample. The intuition: near a
52-week high, reference-dependent investors anchor to the recent high, creating
sticky supply that resolves upward.

**Screening rules.**
- Inputs: 252-day high price, current price.
- Signal: Current / 52W-High ratio.
- Filter: ratio ≥ 0.95 (within 5% of 52-week high). Stricter: equal to 52-week high today.
- Combine with:
  1. Price > 200DMA (avoid bear-market bounces that happen to print a new "52-week" high off a low base).
  2. Volume confirmation: 50-day average volume trending up.
- Rebalance: weekly.

**Feasibility in FundX today:** ⚠️ FMP available, not wired (daily history).

**Serves fund types:** growth, accumulation (as a pullback-to-strength entry trigger).

**Caveats.** Near 52-week highs, entries are fragile — one bad earnings print
takes the name back 20%. Requires explicit stop discipline.

**References:** George & Hwang (2004).

### Minervini VCP (Volatility Contraction Pattern)

**Intuition.** Mark Minervini (Minervini, 2013, *Trade Like a Stock Market Wizard*)
operationalised a specific breakout pattern: a prior strong uptrend, followed by a
series of tighter and tighter pullbacks on declining volume, resolving in a breakout
on expanding volume. The VCP is a visual pattern that can be partially mechanised.

**Screening rules.**
- Inputs: daily OHLCV, 200 days minimum.
- Filters (all required):
  1. Price > 150DMA > 200DMA (established uptrend).
  2. 200DMA trending up for ≥ 1 month.
  3. Current price within 25% of 52-week high.
  4. Price > 30% above 52-week low.
  5. Base formation: sequence of 2–4 pullbacks, each shallower than the previous, spanning 7–65 days.
  6. Volume in the pullbacks declining; breakout on volume ≥ 150% of 50-day average.
- Ranking: quality of base (tightness of final contraction).
- Rebalance: daily scan.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Pattern recognition
requires careful algorithmic implementation — mechanically spotting "tighter
pullbacks" is non-trivial.

**Serves fund types:** growth (canonical — Minervini is a momentum / growth-stock
trader).

**Caveats.** Pattern-recognition screens are brittle. Minervini's own success
depends heavily on discretionary pattern reading and on a very tight stop discipline
(typically 7–8% max loss per trade). Running the screen mechanically without the
stop discipline usually fails.

**References:** Minervini (2013).

### Mean-reversion (RSI, Bollinger)

**Intuition.** At short horizons (1–5 days), prices exhibit negative serial
correlation — oversold bounces, overbought fades. Lo and MacKinlay (1990, *Review of
Financial Studies*) showed systematic short-term reversals at the stock level; the
effect is largest in small-caps and when markets are volatile.

**Screening rules.**
- Inputs: daily closes, 20 days minimum.
- Signals:
  - RSI(2) < 10 = oversold; RSI(2) > 90 = overbought. (Connors' short-term version.)
  - Close below lower Bollinger Band (20, 2) = oversold.
- Filter: oversold signal AND price > 200DMA (only fade dips within uptrends).
- Exit: RSI(2) > 50 OR 5 trading days elapsed.
- Rebalance: daily.

**Feasibility in FundX today:** ⚠️ FMP available, not wired for daily.

**Serves fund types:** accumulation (opportunistic entries), custom.

**Caveats.** Mean-reversion dies in strong-trending bear markets — "oversold" stays
oversold for weeks. The 200DMA filter is essential. Short holding period → high
turnover → tax-inefficient.

**References:** Lo & MacKinlay (1990); Connors & Alvarez (2009), *Short Term Trading
Strategies That Work* — practitioner reference for RSI(2).

### PEAD (Post-Earnings-Announcement Drift)

**Intuition.** See 3.4 (earnings momentum) — PEAD is the same effect, screened here
as an event-driven entry trigger rather than a monthly ranking.

**Screening rules.**
- Inputs: earnings calendar, consensus estimates, actual results, post-earnings price action.
- Signal: stock beats EPS by ≥ 5% AND gaps up ≥ 3% on earnings day on volume ≥ 200% of 50-day average.
- Entry: at or near post-earnings close (or next day's open).
- Exit: 4–8 weeks, or trailing stop.

**Feasibility in FundX today:** ⚠️ FMP available, not wired. Needs earnings
calendar + surprise data.

**Serves fund types:** growth, accumulation.

**Caveats.** Earnings-day gaps sometimes reverse entirely by end of week ("gap fade").
The screen must wait for gap confirmation rather than bidding into the gap.

**References:** Bernard & Thomas (1989).

### Insider buying / cluster buying

**Intuition.** Seyhun (1986, *Journal of Financial Economics*, "Insiders' Profits,
Costs of Trading, and Market Efficiency") and subsequent work showed that insider
purchases — particularly open-market buys by multiple officers — predict
outperformance. Sales are noisy signal (insiders sell for many reasons); buys are
informative.

**Screening rules.**
- Inputs: Form 4 filings (SEC EDGAR).
- Filters:
  1. ≥ 2 insiders buying within 30 days (cluster).
  2. Purchases are open-market, not option exercises or gifts.
  3. Aggregate dollar amount > $500k.
  4. At least one buyer is C-level (CEO, CFO) or chairman.
- Ranking: aggregate dollar amount and insider seniority.
- Rebalance: weekly (new filings).

**Feasibility in FundX today:** ⚠️ FMP `/insider-trading` endpoint exists but is
not wired. Alternatively scrape SEC EDGAR directly (cost: complexity).

**Serves fund types:** growth, accumulation, custom.

**Caveats.** Insiders can be wrong; cluster-buying into falling-knife situations is
common. Pair with trend confirmation (price not in clear downtrend).

**References:** Seyhun (1986); Lakonishok & Lee (2001), *Review of Financial Studies*,
"Are Insider Trades Informative?".

### Institutional flow (13F)

**Intuition.** Quarterly 13F filings reveal large-holder positions. Changes in those
positions — especially from top-performing managers — have modest predictive power.
Gompers and Metrick (2001, *Quarterly Journal of Economics*) documented institutional
ownership effects on price.

**Screening rules.**
- Inputs: 13F filings (45-day lag after quarter-end).
- Signal: ≥ 3 "high-conviction" managers (pre-defined list — e.g. Tiger Cubs, select
  large value funds) initiating or adding ≥ 25% to a position.
- Filter: market cap > $2B (13F data on micro-caps is noisy).

**Feasibility in FundX today:** ❌ 13F data requires SEC EDGAR integration or a
paid provider (WhaleWisdom, 13F.info).

**Serves fund types:** custom (niche).

**Caveats.** 45-day lag — the trade is stale by disclosure. Good managers can be
wrong; selection of "high-conviction managers" is a research task of its own.

**References:** Gompers & Metrick (2001).

---

## 9. Multi-Factor Composites

Single factors work on average but drawdown independently. Combining factors with
low correlation produces smoother return streams and reduces the drawdown cost of
any one factor failing. The key design question is how to combine.

### Value + Momentum + Quality (the canonical triple)

**Intuition.** Asness et al. (2013, 2019) across multiple papers show value,
momentum, and quality have low pairwise correlation and each has a persistent
premium. A portfolio tilted on all three simultaneously outperforms single-factor
portfolios on a risk-adjusted basis.

**Construction approaches.**

*Rank-sum method* (simplest):
- For each stock, compute percentile rank within universe on: value signal (e.g. book-to-market), momentum signal (12-1), quality signal (gross profitability).
- Composite = mean of the three ranks.
- Hold top decile of composite.

*Z-score method* (sensitivity to extremes):
- Standardise each signal to z-score within universe.
- Composite = weighted sum. Equal weights is a reasonable default; risk-parity weighting by each signal's historical volatility is better.

*Intersection method* (stricter):
- Require top quintile on all three simultaneously.
- Produces smaller baskets; more concentrated.

**Feasibility in FundX today:** ⚠️ FMP available, not wired (fundamentals needed).

**Serves fund types:** growth, accumulation, custom.

**Caveats.** "Integrated" construction (ranking on a single composite z-score) tends
to beat "portfolio combination" (buying three separate factor baskets and stapling
them together). See Asness, Frazzini & Pedersen (2013), "Leverage Aversion and Risk
Parity" ⚠️ verify title.

**References:** Asness, Moskowitz & Pedersen (2013); Fitzgibbons, Friedman, Pomorski
& Serban (2017), *Financial Analysts Journal*, "Long-Only Style Investing".

### QMJ × Momentum

**Intuition.** Quality and momentum have the lowest correlation among major factor
pairs ⚠️ verify magnitude. The combination captures two separate premia; the QMJ
component dampens momentum's crashes at turning points.

**Construction.** As above but with just two signals. Works particularly well as a
runway-compatible growth sleeve: quality floor plus trend overlay.

**Feasibility / fund types / caveats:** As in the triple above, with lower data
requirements (no value signal).

### Factor rotation by regime

**Intuition.** Factor premia are regime-dependent. Value dominates in low-growth,
high-inflation environments; momentum dominates in trending bull markets; quality
dominates in late-cycle and recession. A naive rotation model weights factors
dynamically based on macro state.

**Screening rules.**
- Regime indicators: yield-curve slope (10Y − 3M), ISM PMI, trailing 6-month S&P
  return, unemployment-rate trend.
- Rotation table (illustrative — exact weights should be backtested per portfolio):
  - Early-cycle recovery (PMI rising, curve steepening): tilt momentum + size.
  - Mid-cycle expansion: equal-weight value + momentum + quality.
  - Late-cycle (curve flattening, PMI declining): tilt quality + low-vol.
  - Recession: heavy defensive tilt — quality + low-vol + dividend aristocrats.

**Feasibility in FundX today:** ❌ Macro data (yield curve, PMI) not currently
wired. FRED API integration would be the standard add.

**Serves fund types:** all — works as a top-level weighting overlay across any
factor portfolio.

**Caveats.** Regime classification is notoriously late — by the time the regime is
clearly identified, the rotation is often half-done. Keep regime-driven weight
changes small (e.g. ±20% tilt) rather than binary on/off.

**References:** Asness, Ilmanen, Israel & Moskowitz (2015), *Financial Analysts
Journal*, "Investing With Style".

---

## 10. Regime-Conditional Screening

Whereas factor rotation (§9) asks "which factor works in this regime", regime
conditioning asks "should any screen be running aggressively right now, or should
the fund be defensive regardless of factor selection". This is the macro overlay.

### Regime indicators

Three families, used together rather than separately:

**Trend-based.**
- SPY or ACWI price vs 200DMA: above = risk-on, below = risk-off.
- 200DMA slope: positive = bull regime, negative = bear regime.
- % of S&P 500 names above their 200DMA (market breadth).

**Volatility-based.**
- VIX level and 1-month change.
- VIX term structure: VIX9D / VIX ratio > 1 = near-term stress.

**Macro-based.**
- 10Y − 3M yield-curve slope; inversion is a recession prior.
- Credit spreads (HY OAS, IG OAS) expanding = risk-off.
- CAPE percentile vs history (see 2.5).

### How screens shift across regimes

A working playbook:

| Regime | Momentum | Value | Quality | Low-vol | Income | Cash weight |
|---|---|---|---|---|---|---|
| Risk-on, low vol | Full | Neutral | Neutral | Under | Neutral | 0–5% |
| Risk-on, high vol | Half | Neutral | Over | Neutral | Neutral | 5–15% |
| Transition (mixed signals) | Half | Under | Over | Over | Neutral | 15–30% |
| Risk-off | Off | Under | Full | Full | Over | 30–60% |

("Full" = target allocation to that factor; "Half" = 50% of target; "Off" = exit.)

**Feasibility in FundX today:** ⚠️ Partial. VIX and SPY prices accessible via
`/quote`. Yield curve, credit spreads, breadth require new data sources.

**Serves fund types:** all — regime is a top-down overlay.

**Caveats.** Regime definitions fit history cleanly and out-of-sample less cleanly.
Keep regime rules small in number and mechanical — discretionary interpretation
defeats the point.

**References:** Ilmanen (2011), *Expected Returns*; Faber (2007).

---

## 11. Mapping to FundX Fund Types

Which screens primarily serve each FundX objective type. A screen can serve
multiple fund types; the table marks the **primary** association plus secondary
uses (`~`).

| Screen | runway | growth | accumulation | income | custom |
|---|---|---|---|---|---|
| Classic multiples | ~ | ~ | ✓ | | ✓ |
| Piotroski F-Score | ✓ | ~ | ✓ | | ✓ |
| Magic Formula | | ✓ | ✓ | | ✓ |
| Deep value / net-nets | | | ~ | | ✓ |
| CAPE (regime) | ✓ | ✓ | ✓ | ✓ | ✓ |
| 12-1 momentum | | ✓ | ~ | | ✓ |
| Time-series trend | ✓ | ✓ | ✓ | | ✓ |
| IBD RS | | ✓ | | | ✓ |
| SUE / earnings revisions | | ✓ | | ~ | ✓ |
| Gross profitability | ✓ | ✓ | | ~ | ✓ |
| Accruals quality | ✓ | | ~ | ✓ | ✓ |
| QMJ composite | ✓ | ✓ | | ~ | ✓ |
| Balance-sheet strength | ✓ | | | ✓ | ✓ |
| Min-vol / low-vol | ✓ | | ~ | ~ | ✓ |
| BAB / beta anomaly | ✓ | | | ~ | ✓ |
| Max-drawdown filter | ✓ | | | ~ | ✓ |
| Dividend aristocrats | ~ | | | ✓ | ✓ |
| Small-cap + quality | | ✓ | ✓ | | ✓ |
| Illiquidity premium | | | | | ~ |
| ADV position cap | ✓ | ✓ | ✓ | ✓ | ✓ |
| Dividend yield + gates | | | | ✓ | ✓ |
| Dividend growth (CCC) | ~ | | ~ | ✓ | ✓ |
| REITs | | | | ✓ | ~ |
| 52-week high | | ✓ | ~ | | ✓ |
| Minervini VCP | | ✓ | | | ~ |
| Mean-reversion (RSI) | | ~ | ✓ | | ✓ |
| PEAD | | ✓ | ~ | | ✓ |
| Insider buying | | ✓ | ~ | | ✓ |
| 13F flow | | ~ | | | ~ |
| V+M+Q triple | | ✓ | ✓ | | ✓ |
| QMJ × Momentum | ✓ | ✓ | | | ✓ |
| Regime overlay | ✓ | ✓ | ✓ | ✓ | ✓ |

Reading this table:
- **runway** has many secondary uses but primary screens cluster in quality, low-vol,
  balance-sheet strength, and regime overlays.
- **growth** leans on momentum + quality + technical/event-driven.
- **accumulation** benefits from value (persistent cheapness) plus mean-reversion
  entry timing.
- **income** is a tight cluster: dividend yield with gates, dividend growth, REITs,
  dividend aristocrats — all gated by quality overlays.
- **custom** is marked everywhere because custom funds can plausibly use any
  screen; the fund config dictates which.

---

## 12. Feasibility Matrix — Current FundX Data Stack

Tag legend: ✅ wired today, ⚠️ FMP/Yahoo endpoint exists but not integrated in
FundX, ❌ needs new data source.

| Screen | Data need | Feasibility | Notes |
|---|---|---|---|
| Classic multiples | Fundamentals (`/ratios`, `/key-metrics`) | ⚠️ | Add to `market.service.ts` |
| Piotroski F-Score | Full financial statements | ⚠️ | `/income-statement`, `/balance-sheet-statement`, `/cash-flow-statement` |
| Magic Formula | EBIT + EV components | ⚠️ | Same as multiples + balance sheet |
| Deep value (NCAV) | Balance sheet | ⚠️ | Rare matches; low priority |
| CAPE (regime) | S&P 500 CAPE series | ❌ | Monthly CSV from Shiller/Yale; or FRED |
| 12-1 momentum | Daily total returns, 13 months | ⚠️ | `/historical-price-full` with dividend adjustment |
| Time-series trend | Daily close, 252 days | ⚠️ | Same endpoint; also use SPY/QQQ as index proxies |
| IBD RS | Daily returns + EPS growth | ⚠️ | Price history + fundamentals |
| SUE / revisions | Earnings surprise + estimates | ⚠️ | `/earnings-surprises`, `/analyst-estimates` |
| Gross profitability | Income statement + balance sheet | ⚠️ | Standard fundamentals |
| Accruals quality | Net income + OCF | ⚠️ | Standard fundamentals |
| QMJ composite | Broad fundamentals + price history | ⚠️ | Data-hungry |
| Balance-sheet strength | Balance sheet + interest expense | ⚠️ | Standard fundamentals |
| Min-vol / low-vol | Daily returns, 252 days | ⚠️ | Or use low-vol ETF proxies (USMV, SPLV) ✅ |
| BAB / beta | Daily returns vs index | ⚠️ | Compute from `/historical-price-full` |
| Max-drawdown | Daily closes, multi-year | ⚠️ | Same endpoint |
| Dividend aristocrats | 25-year dividend history | ⚠️ | Or track NOBL ETF ✅ |
| Small-cap + quality | Market cap + fundamentals | ⚠️ | Or IWM/IJR proxies ✅ |
| Illiquidity (Amihud) | Daily returns + dollar volume | ⚠️ | Computed from historical |
| ADV position cap | Average daily dollar volume | ⚠️ | Needs historical (current `/quote` volume is insufficient) |
| Dividend yield + gates | Dividends + fundamentals | ⚠️ | Standard |
| Dividend growth (CCC) | 10-year dividend history | ⚠️ | Or VIG/SDY proxies ✅ |
| REITs | FFO / AFFO | ❌ | Not standard in FMP; may compute approximately |
| 52-week high | Daily closes | ⚠️ | `/historical-price-full` |
| Minervini VCP | Daily OHLCV + pattern recog | ⚠️ | Computation heavy |
| Mean-reversion RSI | Daily closes | ⚠️ | Standard |
| PEAD | Earnings + post-earn prices | ⚠️ | `/earnings-calendar` + intraday |
| Insider buying | Form 4 | ⚠️ | `/insider-trading` endpoint |
| 13F flow | 13F filings | ❌ | SEC EDGAR or paid |
| Regime overlay | VIX, yield curve, credit spreads | ⚠️/❌ | VIX ✅, yield curve ❌ (FRED) |

**Summary.** The single largest unlock for FundX screening is integrating FMP's
fundamentals and daily history endpoints. With those two additions, the majority of
screens above become accessible. Regime-conditional overlays need a macro data
source (FRED is standard, free, and well-documented).

---

## 13. Pitfalls & Meta-Rules

The literature contains more failed screens than successful ones. Before adding any
screen to production, check it against these meta-rules.

### Multiple testing and data snooping

Every screen you test reduces your effective significance. If you test 20 variants,
expect one to look good at the 5% level even if none have real edge. Mitigations:

- Pre-register screens against a paper. Screens that implement a published effect
  are less vulnerable than screens fit to the same data.
- Out-of-sample: if the paper is from 2005, test on 2006–2015 and 2016+ separately.
  Large in-sample / out-of-sample gap is a warning sign.
- Bonferroni-style correction when comparing many variants on the same series.

### Factor crowding

A factor that has been public and tradeable for 20+ years has been arbitraged by
hedge funds and quant ETFs. The premium remaining is often a fraction of the
original. Signs of crowding:

- Decreasing magnitude of factor returns post-publication (e.g. accruals post-1996).
- Correlated drawdowns across multiple factor ETFs during stress (2016 "quant quake",
  August 2007 liquidation).
- Factor return correlations rising over time.

Mitigation: favour factors with a structural story (regulatory constraint, behavioural
bias that won't arbitrage away) over purely empirical factors.

### Turnover cost

High-turnover screens (weekly rebalance, momentum, mean-reversion) can be destroyed
by slippage and taxes. Rule of thumb: a screen that backtests 5% alpha with 200%
annual turnover leaves roughly 2–3% net after costs for a retail-scale portfolio
⚠️ verify magnitude. Always include a cost model.

### Regime risk

Every factor has its bad regime. Value underperformed 2017–2020; momentum crashed
March 2020 and Q1 2009; low-vol sold off in Q1 2022 with rate shocks. The question
is not whether a screen will have a bad period (it will) but whether the fund's
objective can survive it.

- **Runway** cannot absorb a 30% drawdown. Screens with historical max drawdowns
  > 20% in a single factor-crash event should be excluded.
- **Growth** can absorb drawdowns but needs them to mean-revert; if the factor has a
  prolonged (5+ year) underperformance period, the fund objective may not hold.

### Survivorship & restatement

Current constituent lists are survivor-biased. Always test screens on point-in-time
data, or at minimum acknowledge the bias and discount backtests accordingly. Use
as-reported financials, not restated — even though FMP and most providers serve
restated by default.

### AI-specific: tool-grounding

An AI agent running a screen must pull its inputs from tool calls in-session — never
recall prices, ratios, or statistics from training. Any number not directly
retrieved must be flagged as unverified. See FundX's anti-hallucination rules in
`CLAUDE.md`.

---

## 14. References

Numbered; used in-line as `[n]`. Attribution accuracy is a first-class requirement
of this document — uncertain citations are marked `⚠️ verify attribution`.

1. Altman, E. I. (1968). "Financial Ratios, Discriminant Analysis and the Prediction of Corporate Bankruptcy." *Journal of Finance*.
2. Amihud, Y. (2002). "Illiquidity and Stock Returns: Cross-Section and Time-Series Effects." *Journal of Financial Markets*.
3. Ang, A., Hodrick, R. J., Xing, Y., & Zhang, X. (2006). "The Cross-Section of Volatility and Expected Returns." *Journal of Finance*.
4. Asness, C. S., Frazzini, A., & Pedersen, L. H. (2019). "Quality Minus Junk." *Review of Accounting Studies*.
5. Asness, C. S., Frazzini, A., Israel, R., Moskowitz, T. J., & Pedersen, L. H. (2018). "Size Matters, If You Control Your Junk." *Journal of Financial Economics*.
6. Asness, C. S., Ilmanen, A., Israel, R., & Moskowitz, T. J. (2015). "Investing With Style." *Financial Analysts Journal*.
7. Asness, C. S., Moskowitz, T. J., & Pedersen, L. H. (2013). "Value and Momentum Everywhere." *Journal of Finance*.
8. Banz, R. W. (1981). "The Relationship between Return and Market Value of Common Stocks." *Journal of Financial Economics*.
9. Bernard, V. L., & Thomas, J. K. (1989). "Post-Earnings-Announcement Drift: Delayed Price Response or Risk Premium?" *Journal of Accounting Research*.
10. Campbell, J. Y., & Shiller, R. J. (1988). "The Dividend-Price Ratio and Expectations of Future Dividends and Discount Factors." *Review of Financial Studies*.
11. Chan, L. K. C., Jegadeesh, N., & Lakonishok, J. (1996). "Momentum Strategies." *Journal of Finance*.
12. Clarke, R., de Silva, H., & Thorley, S. (2006). "Minimum-Variance Portfolios in the U.S. Equity Market." *Journal of Portfolio Management*.
13. Connors, L., & Alvarez, C. (2009). *Short Term Trading Strategies That Work*. TradingMarkets.
14. Daniel, K., & Moskowitz, T. J. (2016). "Momentum Crashes." *Journal of Financial Economics*.
15. Faber, M. T. (2007). "A Quantitative Approach to Tactical Asset Allocation." *Journal of Wealth Management*.
16. Fama, E. F., & French, K. R. (1988). "Dividend yields and expected stock returns." *Journal of Financial Economics*.
17. Fama, E. F., & French, K. R. (1992). "The Cross-Section of Expected Stock Returns." *Journal of Finance*.
18. Fitzgibbons, S., Friedman, J., Pomorski, L., & Serban, L. (2017). "Long-Only Style Investing." *Financial Analysts Journal* ⚠️ verify attribution.
19. Frazzini, A., & Pedersen, L. H. (2014). "Betting Against Beta." *Journal of Financial Economics*.
20. George, T. J., & Hwang, C.-Y. (2004). "The 52-Week High and Momentum Investing." *Journal of Finance*.
21. Gompers, P. A., & Metrick, A. (2001). "Institutional Investors and Equity Prices." *Quarterly Journal of Economics*.
22. Graham, B. (1949). *The Intelligent Investor*. Harper & Brothers.
23. Greenblatt, J. (2005). *The Little Book That Beats the Market*. Wiley.
24. Ilmanen, A. (2011). *Expected Returns: An Investor's Guide to Harvesting Market Rewards*. Wiley.
25. Jegadeesh, N. (1990). "Evidence of Predictable Behavior of Security Returns." *Journal of Finance*.
26. Jegadeesh, N., & Titman, S. (1993). "Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency." *Journal of Finance*.
27. Kyle, A. S. (1985). "Continuous Auctions and Insider Trading." *Econometrica*.
28. Lakonishok, J., & Lee, I. (2001). "Are Insider Trades Informative?" *Review of Financial Studies*.
29. Lo, A. W., & MacKinlay, A. C. (1990). "When Are Contrarian Profits Due to Stock Market Overreaction?" *Review of Financial Studies*.
30. Minervini, M. (2013). *Trade Like a Stock Market Wizard*. McGraw-Hill.
31. Moskowitz, T. J., Ooi, Y. H., & Pedersen, L. H. (2012). "Time Series Momentum." *Journal of Financial Economics*.
32. Novy-Marx, R. (2013). "The Other Side of Value: The Gross Profitability Premium." *Journal of Financial Economics*.
33. O'Neil, W. J. (1988). *How to Make Money in Stocks*. McGraw-Hill.
34. Oppenheimer, H. R. (1986). "Ben Graham's Net Current Asset Values: A Performance Update." *Financial Analysts Journal*.
35. Pástor, L., & Stambaugh, R. F. (2003). "Liquidity Risk and Expected Stock Returns." *Journal of Political Economy*.
36. Piotroski, J. D. (2000). "Value Investing: The Use of Historical Financial Statement Information to Separate Winners from Losers." *Journal of Accounting Research*.
37. Seyhun, H. N. (1986). "Insiders' Profits, Costs of Trading, and Market Efficiency." *Journal of Financial Economics*.
38. Shiller, R. J. (2000). *Irrational Exuberance*. Princeton University Press.
39. Sloan, R. G. (1996). "Do Stock Prices Fully Reflect Information in Accruals and Cash Flows About Future Earnings?" *The Accounting Review*.
40. Young, T. W. (1991). "Calmar Ratio: A Smoother Tool." *Futures*.

---

## Appendix: Out-of-Scope Notes

### Crypto

This document excludes crypto screens. If a Phase 2 screening system extends to
crypto, factor families that translate reasonably include: momentum (time-series
and cross-sectional at the token level), low-vol (screens out memecoins), and
liquidity (DEX depth as the Amihud analogue). On-chain metrics (active addresses,
fee revenue, stablecoin flows) are a distinct family with no direct equity
equivalent.

### Options

Also excluded. The two income-adjacent strategies worth noting for future scoping:
covered-call candidate screens (low-vol names with liquid weekly/monthly options,
moderate implied vol), and cash-secured-put screens (quality names with defined
entry price below market). Both require options chain data (not in FMP's free
tier).

### Closing note

Phase 2 — deciding what to implement — should start by asking which 3–5 screens
from this catalogue would most change FundX's decision quality today. The
feasibility matrix in §12 makes clear that fundamentals and daily-history
integration are the highest-leverage infrastructure additions.
