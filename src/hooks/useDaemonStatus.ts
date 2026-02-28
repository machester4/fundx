import { useAsyncAction } from "./useAsyncAction.js";
import { getDaemonStatus } from "../services/chat.service.js";

/**
 * Check if the daemon process is running.
 */
export function useDaemonStatus() {
  return useAsyncAction(getDaemonStatus);
}
