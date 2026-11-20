
import { apiFetch } from "@/lib/api";
import { X_TABLE_IDS } from "./xTableIds";
import type { ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "./legacyChannelActions";
import { DEFAULT_RANGES } from "./google-ads/types";
import { xPanelSections } from "./xStagedPosts";

import type { XAttention, XChecklistSignal, XPayload } from "./XAgentDashboard";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

export { X_TABLE_IDS };

export function xTables(_payload: unknown, _onChanged?: () => void): ExtraTableData[] {
  return [];
}

export function xChrome(payload: unknown): ChannelChrome | null {
  const d = (payload ?? null) as XPayload | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.connected !== "boolean") return null;
  const budget = d.read_budget;
  const allowance =
    budget && budget.cap > 0
      ? budget.remaining === 0
        ? "No reads left today"
        : `${budget.remaining} of ${budget.cap} reads left today`
      : null;
  const handle = d.handle ?? d.account_name ?? null;
  return {
    connected: d.connected,
    readNote: [
      d.account_read_at && Number.isFinite(Date.parse(d.account_read_at))
        ? `Last account read ${new Date(d.account_read_at).toLocaleString()}`
        : "No confirmed account read yet",
      allowance,
    ].filter(Boolean).join(" · "),
    ranges: d.ranges?.length ? d.ranges : DEFAULT_RANGES,
    period: d.period ?? null,
    account: handle ? { name: handle, sub: allowance ?? "" } : null,
    problem:
      d.read && d.read.read === false && d.read.error_code
        ? {
            text: "Zavi could not read your X account just now, so these numbers are from the last read that worked.",
            reconnect: d.read.error_code === "x_token_revoked",
          }
        : null,
    plan: null,
  };
}

export { stagedCardsFromPayload as xStagedCards } from "./xStagedPosts";
