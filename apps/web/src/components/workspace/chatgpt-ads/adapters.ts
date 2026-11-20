import type { ChatgptAdsDashboard } from "@zavi/shared";
import type { ChannelChrome } from "../agent/legacyChannelActions";
import { DEFAULT_RANGES } from "../agent/google-ads/types";
export const asDashboard = (p: unknown): ChatgptAdsDashboard | null => p && typeof p === "object" && (p as ChatgptAdsDashboard).source === "chatgpt_ads_api" ? p as ChatgptAdsDashboard : null;
export const chatgptAccountReadable = (p: unknown): boolean => {
  const d = asDashboard(p);
  return !!d && !d.error_code && !!d.account_read && d.account_read.status !== "unavailable";
};
export function chatgptChrome(p: unknown): ChannelChrome | null {
  const d = asDashboard(p); if (!d) return null;
  return { connected: chatgptAccountReadable(p), ranges: DEFAULT_RANGES, period: d.period, account: null, plan: null, problem: d.warning ? { text: d.warning, reconnect: false } : null };
}
export { money, count, percent } from "../actions/managed-campaigns/format";
