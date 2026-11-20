import type { LucideIcon } from "lucide-react";
import type { CampaignMediaChannel, ManagedCampaignDashboard } from "@zavi/shared";
export type CampaignWorkspaceSpec = {
  channel?: CampaignMediaChannel;
  title: string;
  apiBase: string;
  actionReviewPath?: string;
  safetyPath?: string;
  readDashboard: (payload: unknown) => ManagedCampaignDashboard | null;
  metrics: ReadonlyArray<{ field: "spend" | "impressions" | "clicks" | "conversions" | "roas"; label: string; help: string; format: "money" | "count" | "ratio"; icon?: LucideIcon }>;
  headerBalance?: boolean;
  objectives: ReadonlyArray<{
    value: string; label: string; short?: string; bidLabel?: string; bidMicros?: number; automaticStrategy?: string; requiresEvent?: boolean;
    plainGoal?: string; plainBid?: string;
    bidHint?: string; bidIsTarget?: boolean;
  }>;
  controls?: { dailyMinimum: number; platforms: ReadonlyArray<{ value: string; label: string }>; resources: boolean; productFeeds: boolean; previewUnavailableReason?: string };
  creative: {
    label: string; type: string; contextLabel: string; titleLimit: number; bodyLimit: number; tracking: string;
    contextPlain?: string;
  };
  balance: { currency: string; minTopup: number; maxTopup: number; minRefill: number; dailyRefillCap: number; threshold: number; presets: readonly number[] };
  empty: { title: string; body: string };
};
