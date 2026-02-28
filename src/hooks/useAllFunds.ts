import { useAsyncAction } from "./useAsyncAction.js";
import { listFundNames } from "../services/fund.service.js";

/**
 * List all fund names in the workspace.
 */
export function useAllFunds() {
  return useAsyncAction<string[]>(listFundNames);
}
