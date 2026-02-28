import { useAsyncAction } from "./useAsyncAction.js";
import { loadFundConfig } from "../services/fund.service.js";
import { readPortfolio, readTracker } from "../state.js";
import type { FundConfig, Portfolio, ObjectiveTracker } from "../types.js";

interface FundData {
  config: FundConfig;
  portfolio: Portfolio | null;
  tracker: ObjectiveTracker | null;
}

/**
 * Load fund config, portfolio, and tracker for a given fund name.
 */
export function useFundData(fundName: string) {
  return useAsyncAction<FundData>(
    async () => {
      const config = await loadFundConfig(fundName);
      const portfolio = await readPortfolio(fundName).catch(() => null);
      const tracker = await readTracker(fundName).catch(() => null);
      return { config, portfolio, tracker };
    },
    [fundName],
  );
}
