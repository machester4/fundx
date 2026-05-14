# Investment Analysis Best Practices for AI Agent Decision-Making

Compiled from CFA Institute curriculum, academic finance research (Fama-French, Jegadeesh-Titman,
Kahneman-Tversky), practitioner wisdom (Howard Marks, Ray Dalio, Nassim Taleb, Charlie Munger,
Cliff Asness/AQR), and quantitative finance literature. Every principle below is actionable —
designed to be embedded into AI agent prompts, skills, and rules.

---

## 1. Systematic Investment Decision Frameworks

### 1.1 The Investment Policy Statement (IPS) as Constitution

Every fund must have a written IPS equivalent (in FundX, this is `fund_config.yaml` + `CLAUDE.md`).
The IPS defines:

- **Return objectives** — specific, measurable targets tied to the fund's life goal
- **Risk tolerance** — maximum drawdown, position limits, volatility budget
- **Constraints** — liquidity needs, time horizon, legal/regulatory, unique circumstances
- **Asset universe** — allowed and forbidden instruments

**Actionable principle:** The AI agent must re-read the IPS at the start of every session. No
decision is valid if it violates the IPS. The IPS is the constitution; the agent is the executor.

### 1.2 Top-Down vs. Bottom-Up Integration

Professional portfolio managers use both approaches simultaneously:

**Top-down (macro to micro):**
1. Economic environment assessment (growth, inflation, monetary policy)
2. Asset class selection (equities, bonds, commodities, cash)
3. Sector/industry allocation
4. Individual security selection

**Bottom-up (micro to macro):**
1. Individual security analysis (valuation, quality, catalysts)
2. Aggregation into sector/industry views
3. Portfolio-level risk assessment
4. Macro consistency check

**Actionable principle:** The AI agent should run BOTH approaches and check for conflicts. If
top-down says "risk-off" but bottom-up finds an "incredible bargain," the agent must explicitly
reconcile: either the macro view is wrong, the bargain is a value trap, or the position deserves
smaller sizing with a wider stop.

### 1.3 The Decision Hierarchy (Priority Order)

When inputs conflict, follow this priority (adapted from CFA Institute portfolio management process):

1. **Hard risk limits** — absolute constraints, never override (max drawdown, max position, etc.)
2. **Fund objective alignment** — does this trade serve the fund's goal?
3. **Market regime appropriateness** — is this the right strategy for the current environment?
4. **Valuation and fundamental merit** — is the price right?
5. **Technical confirmation** — does price action support the thesis?
6. **Timing and execution** — is this the optimal entry point?

**Actionable principle:** If any level 1-3 check fails, the trade is vetoed regardless of how
compelling levels 4-6 appear. This prevents the "it's such a good setup" rationalization from
overriding risk discipline.

### 1.4 The Factor-Based Lens

Academic research (Fama-French five-factor model, Asness et al. "Value and Momentum Everywhere")
has identified persistent return drivers across asset classes and geographies:

| Factor | What It Captures | Academic Evidence |
|--------|-----------------|-------------------|
| **Value** | Cheap vs. expensive (P/E, P/B, EV/EBITDA) | Fama-French (1992, 2015), Asness et al. (2013) |
| **Momentum** | Recent winners vs. losers (3-12 month returns) | Jegadeesh-Titman (1993, 2023 — 30 years of evidence) |
| **Quality/Profitability** | High vs. low profitability (ROE, margins) | Novy-Marx (2013), Fama-French (2015) RMW factor |
| **Low Volatility** | Less volatile stocks outperform on risk-adjusted basis | Baker-Bradley-Wurgler (2011) |
| **Size** | Small caps vs. large caps | Fama-French (1992), weaker in recent decades |

**Key insight from Asness et al. (2013):** Value and momentum are negatively correlated with each
other both within and across asset classes. Combining them produces a smoother return stream than
either alone.

**Actionable principle:** When evaluating a position, the AI agent should explicitly assess which
factors it is exposed to: "This trade is long value + quality (cheap stock with high ROE) but
against momentum (stock is in a downtrend). Factor headwinds from momentum require a catalyst to
overcome, so I need higher conviction (4+) and a specific timeline for the catalyst."

---

## 2. Risk Management Principles

### 2.1 The Asymmetry of Losses (Drawdown Mathematics)

The single most important mathematical fact in portfolio management:

| Drawdown | Required Recovery | Practical Implication |
|----------|------------------|----------------------|
| -5% | +5.3% | Routine — normal market noise |
| -10% | +11.1% | Manageable — one good month |
| -20% | +25.0% | Painful — requires sustained rally |
| -30% | +42.9% | Severe — may take 1-2 years |
| -50% | +100.0% | Devastating — fund objective likely unreachable |
| -75% | +300.0% | Catastrophic — permanent impairment |

**Actionable principle:** The AI agent must carry this table as a core mental model. When
drawdown reaches 50% of the fund's max_drawdown_pct limit, shift to capital preservation mode.
When it reaches 75%, stop all new positions. A 50% drawdown doesn't require a 50% gain to
recover — it requires 100%. This asymmetry makes drawdown prevention more valuable than
return maximization.

### 2.2 Position Sizing Methodologies

#### Fixed Fractional (Most Practical for AI Agents)
Risk a fixed percentage of portfolio per trade (typically 0.5% to 2%).

```
Position size = (Account equity x Risk %) / (Entry price - Stop price)
```

**Van Tharp's R-multiple framework:** Define R as the dollar risk per trade. Every trade outcome
is expressed in R-multiples. A 3R winner means you made 3x your risk. This normalizes performance
across different position sizes and price levels.

**Expectancy = (Win rate x Average win in R) - (Loss rate x Average loss in R)**

An expectancy of 0.4R means for every $1 risked, you expect $0.40 profit over many trades.
Track this metric religiously — it is the single best health indicator for a trading system.

#### Volatility-Based (ATR Method)
Adjust position size inversely to volatility:

```
Risk per share = N x ATR(14)  [where N is typically 2-3]
Position size = (Account equity x Risk %) / Risk per share
```

Higher volatility = smaller position. This automatically reduces exposure in turbulent markets.

#### Kelly Criterion (Academic Optimal, Use Half-Kelly in Practice)

```
Kelly % = (P x B - Q) / B
where P = probability of winning, B = average win / average loss, Q = 1 - P
```

**Critical research finding (Frontiers in Applied Mathematics, 2020):** Full Kelly maximizes
long-term growth but produces unacceptable drawdowns. **Always use half-Kelly or less** — it
captures ~75% of the growth rate with dramatically reduced drawdown severity.

**Practical guidelines from the research:**
- Use 2-year rolling windows for parameter estimation (not longer)
- Rebalance periodically (quarterly or when positions drift >5% from target)
- Apply constraints: no leverage, no short selling for most fund types
- Fractional Kelly (50-75% of full Kelly) for any real portfolio

#### Conviction-Based Sizing (Integrative Approach)

| Conviction | Base % | x Fund Adj | x Regime Mult | Final Range |
|------------|--------|------------|---------------|-------------|
| 1 - Speculative | 1-2% | varies | varies | 0.25-2% |
| 2 - Reasonable | 2-4% | varies | varies | 0.5-4% |
| 3 - Solid | 4-6% | varies | varies | 1-6% |
| 4 - Strong | 6-8% | varies | varies | 1.5-8% |
| 5 - Exceptional | 8-10% | varies | varies | 2-10% |

Always cross-check against half-Kelly. If Kelly says 3% and conviction says 8%, trust Kelly —
conviction is likely overconfident.

**Actionable principle:** The AI agent must calculate position size using at least TWO methods
(conviction-based and either Kelly or ATR-based) and take the SMALLER result. When methods
disagree significantly, that disagreement itself is a signal to reduce size.

### 2.3 Drawdown Budget Management

Inspired by institutional risk budgeting practices:

```
Drawdown budget remaining = max_drawdown_pct - current_drawdown
Regime-adjusted budget = drawdown_budget x regime_multiplier
```

| Budget Consumed | Action |
|----------------|--------|
| 0-25% | Normal operations |
| 25-50% | Reduce new position sizes by 30%, increase selectivity |
| 50-75% | Reduce all sizes by 50%, conviction 4+ only, actively trim |
| 75-100% | No new positions, trim to raise cash, survival mode |
| 100%+ (breached) | Emergency: close weakest positions until back within budget |

**Actionable principle:** The AI agent must calculate drawdown budget remaining at the START of
every session, before any analysis. This is a pre-flight check. If more than 50% of budget is
consumed, the session's primary objective shifts from "find opportunities" to "protect capital."

### 2.4 Correlation as Hidden Concentration

**Dalio's insight:** In normal markets, assets have their usual correlations. In stress markets,
correlations converge toward 1.0 — everything falls together. Diversification benefits disappear
exactly when you need them most.

**Practical rule (adapted from Bridgewater's risk parity):**
- Two positions with >0.7 correlation count as ONE position for concentration purposes
- In Risk-Off/Crisis regimes, recalculate all portfolio risk assuming correlations = 0.8
- True diversifiers in stress: cash, short-duration treasuries, gold (sometimes)
- A portfolio of 5 "different" tech stocks is actually one concentrated tech bet

**Actionable principle:** Before adding any position, the AI agent must answer: "In a -10% SPY
scenario, how much does the ENTIRE portfolio lose?" If the answer exceeds 60% of the drawdown
budget, do not add the position regardless of its individual merit.

### 2.5 Stop-Loss Discipline

**Research-backed guidelines:**
- Set stops based on ATR (2-3x ATR from entry), not arbitrary percentages
- Wider stops in volatile regimes (reduce shakeout risk) with smaller position sizes
- Never move a stop further from entry — only trail in direction of profit
- Mechanical execution: when hit, close. No "waiting to see if it recovers"

**The stop-loss paradox:** Tight stops reduce per-trade risk but increase the probability of
being stopped out by noise. Wide stops reduce whipsaw but increase per-trade risk. The solution
is ATR-based stops with position size adjusted to keep dollar risk constant.

```
ATR-based stop = Entry price - (N x ATR(14))
Position size = (Portfolio x Risk%) / (Entry - Stop)
```

---

## 3. Behavioral Finance Pitfalls — The AI Agent's Anti-Bias Checklist

### 3.1 The Bias Taxonomy for Investment Decisions

These biases are not theoretical — they are the primary reason intelligent investors lose money.
An AI agent has a structural advantage over humans in detecting these patterns, but only if it
is explicitly programmed to check for them.

#### Cognitive Biases (Information Processing Errors)

| Bias | How It Manifests | Detection Signal | Countermeasure |
|------|-----------------|-----------------|----------------|
| **Anchoring** | Fixated on a past price, target, or valuation that is no longer relevant | "It was at $X before, so..." | Re-derive fair value from CURRENT data only |
| **Confirmation bias** | Only seeking evidence that supports the existing thesis | Bear case is thin or absent | Require equal-length bull and bear cases |
| **Recency bias** | Overweighting recent events vs. long-term base rates | "This time is different because..." | Check 5-year and 10-year base rates for similar setups |
| **Availability bias** | Overweighting vivid or recent examples | Thesis based on one memorable event | Require statistical evidence (N > 20 instances) |
| **Framing** | Decision changes based on how information is presented | "It's only down 5%" vs. "It lost $5,000" | Always express risk in BOTH percentage AND dollar terms |
| **Narrative fallacy** | Creating a compelling story that fits the facts retroactively | Story sounds "too clean" | Identify what data the narrative ignores |

#### Emotional Biases (Feeling-Based Errors)

| Bias | How It Manifests | Detection Signal | Countermeasure |
|------|-----------------|-----------------|----------------|
| **Loss aversion** | Holding losers too long, cutting winners too short | Position below stop but not sold; profitable position sold "to lock in gains" | Mechanical stop-loss execution; let winners run per thesis |
| **FOMO** | Chasing moves after missing the initial entry | "I missed the move but it's still going..." | Missed trades have ZERO cost. Chasing has real cost. |
| **Overconfidence** | Position sizes too large, stops too tight, too many trades | More than 3 trades per session; conviction always 4-5 | Calibration check: review past conviction scores vs. outcomes |
| **Sunk cost** | Averaging down without new thesis evidence | "I'll add more to lower my average cost" | Each add must stand alone as a new trade |
| **Revenge trading** | Increasing risk after a loss to "make it back" | Trade entered within 1 hour of a loss | Mandatory cooling period after losses |
| **Status quo bias** | Holding positions with no current thesis just because "they're already there" | Cannot articulate current thesis for a position | Every position must have a living thesis; no thesis = sell signal |
| **Endowment effect** | Valuing holdings more than equivalent opportunities | "I wouldn't buy it here, but I won't sell either" | The "clean slate" test: if you had cash, would you buy this position at today's price? |

### 3.2 The Pre-Mortem Technique (Gary Klein / Daniel Kahneman)

The most powerful debiasing technique in the research literature. Kahneman called it "the single
best method for improving decisions."

**Process:**
1. Imagine it is 6 months from now and this trade has FAILED SPECTACULARLY
2. Write down the 3 most likely reasons for failure
3. For each reason, assess: (a) how likely is it? (b) can I detect it early? (c) what would I do?
4. If any failure mode is both likely AND undetectable, reduce size or skip

**Actionable principle:** The AI agent must run a pre-mortem before every position-opening trade.
The pre-mortem output should be recorded in the trade journal alongside the thesis. If the agent
cannot imagine how the trade could fail, that is overconfidence — the most dangerous bias of all.

### 3.3 Calibration and Overconfidence Detection

Track prediction accuracy over time:

```
Calibration score = Actual hit rate / Predicted probability
```

- Score of 1.0 = perfectly calibrated
- Score < 0.8 = overconfident (the most common error)
- Score > 1.2 = underconfident (rare but possible)

**Actionable principle:** Every 20 trades, the AI agent must calculate its calibration score.
If overconfident (score < 0.8), automatically reduce all conviction scores by one tier until
calibration improves. If consistently well-calibrated, maintain current approach.

---

## 4. Trade Journal Best Practices

### 4.1 What Professional Traders Record

Based on practitioner research and the R-multiple framework:

**At Entry:**
- Date, time, ticker, side (long/short), quantity, entry price
- R value (dollar risk = entry - stop x shares)
- Thesis in one sentence (not a paragraph — forces clarity)
- Conviction score (1-5) with supporting evidence summary
- Market regime at time of entry
- Catalyst and expected timeline
- Invalidation trigger (specific price, event, or data point)
- Pre-mortem: top 3 failure modes

**At Exit:**
- Exit price, exit date, P&L in $ and %
- R-multiple outcome (P&L / initial R)
- Exit type: hit target, hit stop, discretionary, thesis invalidated
- Process grade (A-F, based on process quality not outcome)
- One specific lesson learned (not "good trade" or "bad luck")
- What would I do differently?

### 4.2 Review Cadence

| Frequency | Focus | Key Questions |
|-----------|-------|---------------|
| **Per-trade** | Execution quality | Did I follow my process? |
| **Daily/Session** | Pattern detection | Am I overtrading? Any revenge trading? |
| **Weekly** | Strategy assessment | Win rate, avg R, expectancy, sector patterns |
| **Monthly** | System health | Is the strategy working in this regime? Calibration score? |
| **Quarterly** | Strategy evolution | What systematic errors am I making? What should change? |

### 4.3 The Learning Loop

**The cycle that compounds knowledge:**
1. **Before trade:** Query journal for similar past trades. What happened? What was learned?
2. **During trade:** Monitor thesis. Is it playing out as expected?
3. **After trade:** Record outcome, grade process, extract lesson
4. **Review:** Identify patterns across trades (common failure modes, best setups)
5. **Adapt:** Update sizing rules, regime responses, or thesis requirements based on evidence

**Key metrics to track over time:**
- Win rate by strategy type and market regime
- Average R-multiple (winning trades vs. losing trades)
- Expectancy trend (improving, declining, stable)
- Largest win and largest loss (is max loss contained?)
- Consecutive loss streaks (triggers for sizing reduction)
- Calibration score (overconfidence detection)
- Hit rate by conviction level (do higher conviction trades actually win more?)

**Actionable principle:** The AI agent must NEVER make a trade without first querying the journal
for same-ticker and similar-setup history. This is the highest-ROI activity in the entire trading
process. Past lessons override current intuition.

---

## 5. Market Regime Analysis

### 5.1 Regime Classification Framework

Based on academic research (Hidden Markov Models, volatility clustering) and practitioner methods
(Bridgewater, AQR):

**The Four-Regime Model:**

| Regime | Volatility | Trend | Breadth | Typical Duration |
|--------|-----------|-------|---------|-----------------|
| **Risk-On** | VIX < 18, falling or stable | Above 50/200 MA | > 60% above 200d | 6-18 months |
| **Transition** | VIX 18-25 or rising fast | Mixed signals | 40-60% | 1-3 months |
| **Risk-Off** | VIX 25-35 | Below 50 MA | < 40% | 2-6 months |
| **Crisis** | VIX > 35, backwardation | Below 200 MA | < 25% | 1-4 months |

### 5.2 Regime Detection Indicators (Practical Implementation)

Rather than complex HMM models, use a composite score from observable indicators:

**Volatility Cluster (weight: 30%)**
- VIX absolute level
- VIX term structure (contango = calm, backwardation = stress)
- VIX 10-day rate of change
- Realized vol vs. implied vol spread

**Trend Cluster (weight: 30%)**
- S&P 500 vs. 50-day and 200-day moving averages
- Percentage of stocks above their own 200-day MA
- Golden/death cross status on major indices
- Advance-decline line trend

**Credit Cluster (weight: 20%)**
- Investment-grade credit spreads (OAS) level and trend
- High-yield spreads level and trend
- TED spread or SOFR-Treasury spread

**Macro Cluster (weight: 20%)**
- Yield curve shape (inverted = warning)
- ISM Manufacturing PMI (above/below 50)
- Leading Economic Index (LEI) trend
- Dollar strength (DXY) — strong dollar stress on EM and commodities

### 5.3 Regime-Dependent Behavior

| Dimension | Risk-On | Transition | Risk-Off | Crisis |
|-----------|---------|------------|----------|--------|
| **Sizing multiplier** | 1.0x | 0.7x | 0.5x | 0.25x |
| **Cash floor** | Fund minimum | +10% | +20% | +40% |
| **Min conviction for new positions** | 2 | 3 | 4 | No new longs |
| **Stop-loss width** | Standard (2x ATR) | Wider (2.5x ATR) | Wider (3x ATR) | Tightest (trail only) |
| **Strategy preference** | Momentum, breakouts | Quality, defense | Hedging, cash | Cash, put protection |
| **Rebalancing urgency** | Low (quarterly) | Medium (monthly) | High (weekly) | Continuous |

**Actionable principle:** The AI agent must classify the regime at the start of EVERY session
using the indicator clusters above. This classification is not advisory — it is a binding
constraint on behavior. If the agent finds itself rationalizing why the regime doesn't apply to
a specific trade, that rationalization IS the regime applying to the trade.

### 5.4 Regime Transition Detection

The most dangerous period is the transition between regimes. Watch for:

- **Risk-On to Transition:** VIX rising from low levels, breadth deteriorating while indices
  hold highs (divergence), credit spreads widening from tight levels
- **Transition to Risk-Off:** 50-day MA death cross, VIX breaking above 25, breadth below 40%
- **Risk-Off to Crisis:** VIX term structure inversion (backwardation), credit spreads blowing
  out, broad selling across all sectors including defensive
- **Crisis to Recovery:** VIX declining from extreme (>40), credit spreads tightening, breadth
  improving from extreme lows, first "breadth thrust" signals

---

## 6. Fundamental Analysis Frameworks

### 6.1 Valuation Methods (Hierarchy of Reliability)

**Tier 1 — Most Reliable (Use as Primary):**
- **EV/EBITDA** — Enterprise Value / EBITDA. Capital-structure neutral, works across sectors.
  Compare to sector median and 5-year historical range.
- **P/FCF** — Price / Free Cash Flow. Cash doesn't lie. More reliable than P/E for companies
  with significant non-cash charges.
- **EV/Revenue** — For high-growth companies where earnings are negative. Compare growth rate
  to valuation premium ("PEG ratio" concept).

**Tier 2 — Complementary (Use to Confirm):**
- **P/E (forward)** — Price / Next 12 months earnings. Widely used but easily manipulated by
  one-time items. Use forward, not trailing.
- **P/B** — Price / Book Value. Best for financials and asset-heavy industries.
- **Dividend yield** — For income-focused funds. Must check payout ratio sustainability.

**Tier 3 — DCF (Use for Deep Analysis Only):**
- Discounted Cash Flow analysis is theoretically correct but practically fragile. Small changes
  in discount rate or terminal growth rate produce wildly different valuations.
- **Rule:** Never present a single DCF value. Always show a range: bear/base/bull scenarios
  with explicit assumptions for each.

### 6.2 Quality Metrics (Evidence-Based)

**Piotroski F-Score (9-point composite, academic CAGR of 23.5%):**
1. Net income > 0 (1 point)
2. Operating cash flow > 0 (1 point)
3. ROA increasing year-over-year (1 point)
4. Cash flow from operations > net income (accrual quality) (1 point)
5. Long-term debt ratio decreasing (1 point)
6. Current ratio increasing (1 point)
7. No new equity issuance (1 point)
8. Gross margin increasing (1 point)
9. Asset turnover increasing (1 point)

Score 8-9 = Strong quality. Score 0-2 = Distress signal. Long 8-9, avoid 0-2.

**Altman Z-Score (bankruptcy predictor, 80-90% accuracy):**
```
Z = 1.2(Working Capital/Total Assets) + 1.4(Retained Earnings/Total Assets)
  + 3.3(EBIT/Total Assets) + 0.6(Market Cap/Total Liabilities)
  + 1.0(Revenue/Total Assets)
```
- Z > 2.99 = Safe zone
- Z 1.81-2.99 = Grey zone
- Z < 1.81 = Distress zone (80-90% probability of bankruptcy within 2 years)

**Actionable principle:** The AI agent should compute (or reference) Piotroski F-Score and
Altman Z-Score for every equity position. A low F-Score (0-3) or low Z-Score (< 1.81) is a
red flag that should either veto the trade or require exceptional conviction (5) with a
tight stop.

### 6.3 Comparative Analysis Framework

For every potential position, compare across three dimensions:

1. **vs. History:** Is the stock cheap/expensive relative to its own 5-year valuation range?
   (e.g., "P/E of 15 vs. 5-year range of 12-22")
2. **vs. Peers:** How does it compare to direct competitors on valuation AND quality?
   (e.g., "cheapest in the sector by EV/EBITDA but lowest margins — is it cheap for a reason?")
3. **vs. Market:** Is the stock's valuation justified by its growth rate relative to the
   broader market? (PEG ratio < 1 is attractive; > 2 is expensive for the growth delivered)

---

## 7. Evidence-Based Technical Analysis

### 7.1 What Academic Research Actually Supports

**Strong evidence (30+ years of academic validation):**
- **Cross-sectional momentum (3-12 months):** Jegadeesh-Titman (1993, 2023). Buying recent
  winners and avoiding recent losers produces significant excess returns. The effect is
  persistent across asset classes and geographies.
- **Long-term mean reversion (3-5 years):** De Bondt-Thaler (1985). Extreme losers over 3-5
  years tend to outperform extreme winners over the subsequent period.
- **Trend following (time-series momentum):** Moskowitz-Ooi-Pedersen (2012). Assets that have
  been trending up (down) tend to continue. Works across equities, bonds, commodities, FX.

**Moderate evidence:**
- **Moving average crossovers:** The 200-day MA as a trend filter has out-of-sample evidence
  dating to the 1800s. Being long when price is above the 200-day MA and in cash below reduces
  drawdowns with modest return sacrifice.
- **Volume confirmation:** Breakouts on above-average volume are more likely to sustain than
  those on low volume. Academic evidence is mixed but practitioner consensus is strong.
- **RSI extremes as mean-reversion signals:** RSI below 30 or above 70 has some predictive
  power, but ONLY when combined with other signals (support/resistance, trend context).

**Weak or no evidence:**
- Most chart patterns (head and shoulders, double tops, etc.) have failed rigorous out-of-sample
  testing. David Aronson's "Evidence-Based Technical Analysis" (2006) found that most patterns
  are data-mined artifacts.
- Fibonacci retracements have no academic support.
- Elliott Wave Theory has no predictive power in rigorous testing.

### 7.2 Practical Technical Framework for AI Agent

Focus on what works:

1. **Trend identification:**
   - Price vs. 50-day and 200-day moving averages
   - Higher highs / higher lows sequence (uptrend) or lower highs / lower lows (downtrend)
   - ADX above 25 = trending market; below 20 = range-bound

2. **Momentum confirmation:**
   - RSI(14) direction (not just level — rising RSI confirms trend)
   - MACD histogram direction (momentum acceleration/deceleration)
   - Rate of change (ROC) for momentum strength

3. **Volume analysis:**
   - Volume on breakout days vs. 20-day average (>1.5x is meaningful)
   - Accumulation/distribution pattern (rising price + rising volume = accumulation)

4. **Key levels:**
   - Prior swing highs/lows as support/resistance
   - Volume profile nodes (where the most volume transacted)
   - Round numbers only when they coincide with technical levels

5. **Divergences (highest-probability signals):**
   - Price making new highs while RSI/MACD makes lower highs = bearish divergence
   - Price making new lows while RSI/MACD makes higher lows = bullish divergence
   - Divergences are WARNINGS, not trade signals — require confirmation

**Actionable principle:** The AI agent should use technical analysis as CONFIRMATION, not as a
primary thesis driver. The sequence is: fundamental/macro thesis first, then check if technicals
confirm. A great fundamental setup with poor technicals should be put on a watchlist, not traded
immediately. Technicals alone (without fundamental support) justify only conviction 1-2 trades.

---

## 8. Portfolio Construction

### 8.1 Modern Portfolio Theory Essentials (and Its Limits)

**Core insight (Markowitz, 1952):** Diversification is the only "free lunch" in investing.
Combining uncorrelated assets reduces portfolio risk without proportionally reducing return.

**Practical application:**
- Target 10-15 positions with low pairwise correlation
- No single position > max_position_pct (fund-specific)
- No single sector > 30% of portfolio
- No single factor exposure > 40% (don't accidentally be all-growth or all-value)

**Limitations the AI agent must know:**
- MPT assumes normal distribution of returns — real returns have fat tails
- Correlation estimates from calm periods UNDERSTATE stress-period correlations
- MPT is single-period — doesn't account for the goal-based, multi-period nature of fund objectives
- Garbage in, garbage out — small errors in expected return estimates produce large allocation errors

### 8.2 Risk Parity Concepts (Adapted from Dalio/Bridgewater)

**Core principle:** Balance risk contribution, not dollar allocation.

Instead of 60% stocks / 40% bonds (which is ~90% equity risk because stocks are 3-4x more
volatile than bonds), allocate so that each asset class contributes equally to portfolio risk.

**Practical for FundX funds:**
- Calculate each position's risk contribution: `weight x volatility x correlation_to_portfolio`
- If one position dominates risk contribution (>30%), it is too large regardless of dollar weight
- In a 5-position portfolio where one stock has 3x the volatility of others, it should have
  roughly 1/3 the dollar weight to contribute equal risk

### 8.3 Maximum Diversification Principle

**The diversification ratio:** Sum of individual position volatilities / Portfolio volatility.
Higher is better — means assets are not moving together.

**Practical checklist before any trade:**
- Does this new position increase or decrease the diversification ratio?
- What is its correlation to existing holdings?
- What is its correlation to the LARGEST existing holding?
- Does it introduce exposure to a NEW risk factor or duplicate an existing one?

### 8.4 Tail Risk Hedging (Taleb/Universa Approach)

**The barbell strategy:**
- 85-90% in safe, liquid assets (cash, short-term treasuries)
- 10-15% in asymmetric bets (deep OTM options, venture-style positions)
- AVOID the "middle" — moderate-risk assets with limited upside and unlimited downside

**Antifragility principles for portfolio construction:**
- The portfolio should BENEFIT from volatility, not just survive it
- Small, defined losses (option premiums, tight stops) in exchange for rare, large gains
- Never expose more than you can afford to lose on any single position
- Redundancy > efficiency — cash "earns nothing" but provides optionality and survival

**Practical application for FundX funds:**
- Runway funds should lean toward the barbell: protect capital (cash/treasuries) with small
  asymmetric bets
- Growth funds can be more concentrated but must maintain tail hedges
- Always ask: "If I am completely wrong about everything, does the fund survive?"

---

## 9. Goal-Based Investing

### 9.1 The Bucket Strategy (CFA-Endorsed Framework)

Based on mental accounting research (Thaler) and CFA curriculum:

**Bucket 1 — Essentials (Highest Priority):**
- Fund immediate needs (1-3 years of expenses for runway funds)
- Asset allocation: cash, money market, short-term bonds
- Target: >95% probability of meeting goal
- NEVER invest this bucket aggressively

**Bucket 2 — Core (Medium Priority):**
- Fund medium-term goals (3-10 year horizon)
- Asset allocation: balanced (60/40 or risk parity)
- Target: >80% probability of meeting goal
- Moderate risk tolerance

**Bucket 3 — Growth (Lower Priority):**
- Fund long-term goals (10+ years) or aspirational targets
- Asset allocation: growth-oriented, higher risk
- Target: >50% probability (acceptable because time heals volatility)
- Can tolerate significant drawdowns

### 9.2 Runway Fund Management

For funds with objective type "runway" (sustain monthly expenses for N months):

**Critical metrics:**
- Months of runway remaining = Total portfolio value / Monthly burn rate
- Cash runway = Cash only / Monthly burn rate (must exceed min_reserve_months)
- Monthly withdrawal rate = Monthly burn / Starting portfolio value

**Decision rules:**
- If cash runway < min_reserve_months: SELL positions to replenish cash (highest priority)
- If cash runway < 2x min_reserve_months: no new trades, focus on income generation
- Monthly withdrawal > 4% annualized (0.33% monthly): unsustainable, must reduce burn or
  increase return target
- Track runway TREND, not just current level: is it growing, stable, or shrinking?

**Withdrawal strategy:**
- Sell from overweight positions first (natural rebalancing)
- Harvest gains tax-efficiently (sell highest-cost-basis lots)
- Maintain 3-6 months cash buffer even while invested
- In drawdowns, reduce withdrawal if possible (extend runway by reducing burn)

### 9.3 Growth Fund Management

For funds with objective type "growth" (multiply capital by target):

**Key principle:** Time is the critical variable. The required return rate determines risk budget:

```
Required annual return = (target_multiple)^(1/years) - 1
```

Example: 2x in 5 years requires ~15% annual return — aggressive but achievable.
Example: 2x in 2 years requires ~41% annual return — extremely aggressive, high risk of failure.

**Decision rules:**
- If required return > 20% annualized: must accept concentrated positions and high volatility
- If required return < 10% annualized: can achieve with diversified, moderate-risk approach
- Track progress quarterly: on pace, behind, or ahead of schedule
- If behind schedule: DO NOT increase risk to "catch up" (this is revenge trading at fund level)
  Instead, reassess whether the target is realistic.

### 9.4 Income Fund Management

For funds with objective type "income" (generate monthly income):

**Key metrics:**
- Current yield = Annual income / Portfolio value
- Yield sustainability = Payout ratio, coverage ratio, dividend growth rate
- Income diversification = Number of income sources, sector concentration

**Decision rules:**
- Yield > 8% is likely unsustainable — investigate payout ratio
- Prefer dividend growth over high current yield (growing 3% yield > static 6% yield long-term)
- Diversify across 10+ income sources to avoid single-stock dividend cuts
- Track actual income received vs. target monthly (not projected, not indicated)

---

## 10. Howard Marks' Meta-Principles (The Most Important Things)

These principles from Marks' memos and "The Most Important Thing" are meta-level — they inform
how ALL the above frameworks should be applied:

### 10.1 Second-Level Thinking
First-level thinking: "It's a good company, let's buy."
Second-level thinking: "It's a good company, but everyone thinks it's great, so it's
overpriced. Let's sell."

**For the AI agent:** Always ask: "What is the market already pricing in? What would have to
happen for this trade to work that ISN'T already expected?"

### 10.2 The Relationship Between Price and Value
"The most important single element in shaping investment risk is the price at which the
investment is acquired. High prices imply high risk, and low prices imply low risk."

**For the AI agent:** Never evaluate a company in isolation from its price. The best company in
the world at the wrong price is a bad investment. Express every thesis in terms of
price-to-value: "This stock is worth $X and is trading at $Y, giving a Z% margin of safety."

### 10.3 Patient Opportunism
"You shouldn't expect to make money without bearing risk, but you shouldn't expect to make money
just for taking risk. You have to sacrifice certainty, but it has to be done skillfully."

**For the AI agent:** Cash is a position. Not trading is a decision. The best trades are the
ones you DON'T make when conditions are unfavorable. The agent should be comfortable sitting in
cash when no opportunities meet the quality bar.

### 10.4 Defensive Investing
"If we avoid the losers, the winners will take care of themselves."

**For the AI agent:** Prioritize not losing money over making money. A 10% gain followed by a
10% loss leaves you at 99% (-1%). Consistency matters more than brilliance. Targeting a high
batting average (many small wins, few losses) beats swinging for home runs.

### 10.5 Knowing What You Don't Know
Macro forecasting is unreliable. "I don't know" is often the best answer.

**For the AI agent:** Be explicit about uncertainty. State confidence levels. Acknowledge what
you don't know. Never present certainty. The agent should regularly say "I don't have enough
information to form a view on X" rather than fabricating a confident-sounding opinion.

---

## 11. Taleb's Antifragility Principles for Portfolio Management

### 11.1 Core Concept
Antifragile systems gain from disorder. The goal is not just robustness (surviving shocks)
but antifragility (benefiting from them).

### 11.2 Application to Fund Management

1. **Convexity over linearity:** Prefer trades with capped downside and unlimited upside.
   Options-like payoffs. Asymmetric risk/reward.

2. **Via negativa:** Improve by removing fragilities rather than adding new positions.
   Ask: "What is the weakest link in this portfolio?" and address it.

3. **Optionality:** Cash, dry powder, and flexibility are always valuable. A portfolio that
   is 100% invested has zero optionality — it cannot capitalize on crashes.

4. **Small losses, big gains:** Accept many small, defined losses (stopped out, expired options)
   in exchange for occasional large gains. This is the opposite of "picking up pennies in front
   of a steamroller."

5. **The barbell in practice:** For any fund, maintain a barbell between safe (cash/treasuries
   above minimum) and asymmetric (positions with 3:1+ risk/reward). Avoid the "mushy middle"
   of moderate positions with moderate risk and moderate return.

---

## 12. Munger's Mental Models for Investment Decision-Making

### 12.1 Inversion
"Invert, always invert." Instead of asking "How do I make money?" ask "How would I lose money?"
and avoid those things.

**For the AI agent:** Before every trade, answer: "What would I do if I wanted to MAXIMIZE
the chance of losing money on this trade?" Then check whether the proposed trade shares any
of those characteristics.

### 12.2 Circle of Competence
Only invest where you (the fund) have an edge or at least adequate understanding.

**For the AI agent:** If the agent cannot explain WHY a company's business model works and
what drives its revenue in 2-3 sentences, the position should be avoided or sized at
minimum (conviction 1).

### 12.3 Margin of Safety
"A great business at a fair price is superior to a fair business at a great price."
But BOTH require a margin of safety — a gap between price and conservative intrinsic value.

**For the AI agent:** Quantify margin of safety for every position: "Fair value estimate is
$X based on [method]. Current price is $Y. Margin of safety = (X-Y)/X = Z%." Minimum
acceptable margin of safety: 15% for blue chips, 30% for small caps and cyclicals.

### 12.4 Lollapalooza Effects
When multiple biases or factors align in the same direction, the effect is much larger than
any single factor would suggest.

**For the AI agent:** When 3+ independent factors align (value + momentum + quality + catalyst),
that's a lollapalooza — increase conviction. When 3+ negative factors align, the risk is much
larger than any single factor suggests — exit immediately.

---

## 13. Summary: The AI Agent's Decision Checklist

Every trading session, the AI agent should follow this sequence:

### Pre-Analysis Phase
- [ ] Read fund IPS (CLAUDE.md, fund_config.yaml)
- [ ] Read current state (portfolio.json, objective_tracker.json, session_log.json)
- [ ] Read memory files for accumulated lessons
- [ ] Calculate drawdown budget remaining
- [ ] Classify current market regime (with supporting data)
- [ ] Check calendar for upcoming events (FOMC, CPI, earnings)

### Analysis Phase
- [ ] Run macro assessment (top-down)
- [ ] Assess individual positions and watchlist (bottom-up)
- [ ] Check for conflicts between top-down and bottom-up views
- [ ] Query trade journal for relevant history
- [ ] Identify the 1-3 highest-quality opportunities

### Decision Phase (For Each Potential Trade)
- [ ] Write thesis in one sentence
- [ ] Build bull case with specific data
- [ ] Build bear case with EQUAL rigor
- [ ] Run pre-mortem (3 failure modes)
- [ ] Check for cognitive biases (anchoring, confirmation, FOMO, etc.)
- [ ] Assess factor exposure (value, momentum, quality)
- [ ] Score conviction (1-5) based on evidence, not feeling
- [ ] Verify decision hierarchy (risk limits > objective > regime > thesis > timing)

### Sizing Phase
- [ ] Calculate position size from conviction x fund adjustment x regime multiplier
- [ ] Cross-check against half-Kelly (if historical data available)
- [ ] Cross-check against ATR-based sizing
- [ ] Take the SMALLER of the methods
- [ ] Verify: post-trade cash > minimum, post-trade concentration < limits
- [ ] Calculate portfolio impact: if all stops hit, total loss = ?

### Execution Phase
- [ ] Hard constraint checklist (universe, mode, size, stop, cash, calendar)
- [ ] Define exact order: symbol, side, quantity, type, stop price
- [ ] Set stop-loss (ATR-based, recorded with order)
- [ ] Log trade in journal with full thesis, pre-mortem, and conviction score

### Reflection Phase
- [ ] Grade each decision A-F (process quality, not outcome)
- [ ] Bias check (which biases, if any, were present?)
- [ ] Update objective tracker
- [ ] Update memory files with new lessons
- [ ] Calculate and report: expectancy, win rate, calibration score
- [ ] Identify focus areas for next session

---

## Sources

### Academic Research
- [Fama-French Five-Factor Model (SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2287202)
- [Jegadeesh-Titman Momentum (SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1919226)
- [Momentum: Evidence and Insights 30 Years Later (SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4602426)
- [Value and Momentum Everywhere — Asness, Moskowitz, Pedersen (SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2174501)
- [Kelly Criterion Practical Implementation (Frontiers)](https://www.frontiersin.org/journals/applied-mathematics-and-statistics/articles/10.3389/fams.2020.577050/full)
- [Kelly Criterion for Investing (Edinburgh)](https://webhomes.maths.ed.ac.uk/mckinnon/blackouts/StochOptFinanceAndEnergySpringer/Chap1_KellyZiemba.pdf)
- [Prospect Theory — Kahneman & Tversky (MIT)](https://web.mit.edu/curhan/www/docs/Articles/15341_Readings/Behavioral_Decision_Theory/Kahneman_Tversky_1979_Prospect_theory.pdf)
- [Piotroski F-Score (Wikipedia)](https://en.wikipedia.org/wiki/Piotroski_F-score)
- [Hierarchical Risk Parity (arXiv)](https://arxiv.org/pdf/2509.03712)
- [Portfolio Optimization with Drawdown Constraints (UPenn)](https://www.cis.upenn.edu/~mkearns/finread/drawdown.pdf)
- [Portfolio Management with Drawdown Measures (CME)](https://www.cmegroup.com/education/files/portfolio-management-with-drawdown-based-measures.pdf)

### Practitioner Sources
- [Howard Marks — "The Best Of" Memo (Oaktree)](https://www.oaktreecapital.com/insights/memo/the-best-of)
- [Howard Marks — "The Indispensability of Risk" (Oaktree)](https://www.oaktreecapital.com/insights/memo/the-indispensability-of-risk)
- [Ray Dalio — The All Weather Story (Bridgewater)](https://www.bridgewater.com/research-and-insights/the-all-weather-story)
- [AQR — Understanding Factor Investing](https://funds.aqr.com/Insights/Strategies/Understanding-Factor-Investing)
- [AQR — Fact, Fiction and Factor Investing (JPM)](https://www.aqr.com/-/media/AQR/Documents/Journal-Articles/AQRJPMQuant23FactFictionandFactorInvesting.pdf)
- [Nassim Taleb — Barbell Strategy (QuantifiedStrategies)](https://www.quantifiedstrategies.com/nassim-taleb-strategy/)
- [Gary Klein — Pre-Mortem Technique](https://www.gary-klein.com/premortem)
- [Van Tharp — Position Sizing and R-Multiples](https://vantharpinstitute.com/van-tharp-teaches-position-sizing-strategies-and-risk-management/)

### CFA Institute
- [Portfolio Management Process (AnalystPrep)](https://analystprep.com/cfa-level-1-exam/portfolio-management/portfolio-management-process/)
- [Goals-Based Planning (CFA Level III)](https://analystprep.com/study-notes/cfa-level-iii/goals-based-planning/)
- [Goals-Based Portfolio Theory (CFA Enterprising Investor)](https://rpc.cfainstitute.org/blogs/enterprising-investor/2022/how-goals-based-portfolio-theory-came-to-be)
- [Basics of Portfolio Planning and Construction (CFA)](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/basics-of-portfolio-planning-and-construction)
- [Liability-Driven Strategies (CFA)](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/liability-driven-index-based-strategies)
- [Evolution of Fundamental Scoring Models (CFA UK)](https://www.cfauk.org/pi-listing/man-machine-the-evolution-of-fundamental-scoring-models-and-ml-implications)

### Market Regime Research
- [Market Regime Detection — LSEG/Refinitiv](https://developers.lseg.com/en/article-catalog/article/market-regime-detection)
- [Classifying Market Regimes (Macrosynergy)](https://macrosynergy.com/research/classifying-market-regimes/)
- [Regime-Switching Factor Investing with HMMs (MDPI)](https://www.mdpi.com/1911-8074/13/12/311)

### Behavioral Finance
- [Behavioral Finance: Theories and Evidence (Cannon)](https://www.cannonfinancial.com/uploads/main/Behavioral_Finance-Theories_Evidence.pdf)
- [Behavioral Finance at Cambridge (Sewell)](http://www.behaviouralfinance.net/behavioural-finance.pdf)
- [Charlie Munger's Mental Models (New Trader U)](https://www.newtraderu.com/2026/02/17/charlie-mungers-10-mental-models-for-building-wealth-in-any-economy/)
