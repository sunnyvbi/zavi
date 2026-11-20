import type { LivePricing, TierSlug } from "@/lib/marketing/pricing";

export type ShopConnection = "connected" | "syncing" | "stale" | "reconnect_required";

export type ChannelState = "connected" | "draft_only" | "plan_locked" | "not_connected";

export type AppHomeChannel = { slug: string; label: string; state: ChannelState; locked_tier?: TierSlug };

export type StatusMode = "drafting_only" | "working" | "idle" | "needs_attention";

export type MetricAvailability = "live" | "stale" | "unavailable" | "plan_locked";

export type MetricValue = {
  value: number | null;
  unit: "usd" | "count";
  currency?: string | null;
  comparison: number | null;
  availability: MetricAvailability;
  source: "shopify" | "zavi" | "ad_provider";
  measured_at: string | null;
  note: string | null;
  locked_tier?: TierSlug;
};

export type AppHomeApproval = {
  id: string;
  channel: string | null;
  title: string;
  consequence: string;
  one_click_approvable: boolean;
  needs_owner_admin: boolean;
  review_url: string;
  preview_url: string | null;
};

export type BillingSource = "shopify" | "stripe" | "app_store" | "play_store" | "comp" | null;

export type ShopifyAppHome = {
  shop: {
    domain: string;
    display_name: string | null;
    connection: ShopConnection;
    last_synced_at: string | null;
    scopes: string[];
  };
  workspace: {
    id: string;
    display_name: string;
    viewer_role: "owner" | "admin" | "member" | "viewer";
  };
  status: {
    mode: StatusMode;
    headline: string;
    detail: string | null;
    channels: AppHomeChannel[];
  };
  metrics: {
    window_days: 7;
    sales: MetricValue;
    orders: MetricValue;
    zavi_actions: MetricValue;
    ad_spend: MetricValue;
    shopify_last_synced_at: string | null;
  };
  approvals: {
    rows: AppHomeApproval[];
    remaining: number;
  };
  billing: {
    tier: TierSlug;
    source: BillingSource;
    status: string;
    period_end: string | null;
    credits_total: number;
    credits_used: number;
    credits_remaining: number;
    daily_allowance: number;
    daily_remaining: number;
    manage_url: string | null;
    can_manage: boolean;
    available_terms: readonly ("monthly" | "annual")[];
    billing_lock_reason: "paid_elsewhere" | "grandfathered" | "refund_blocked" | null;
  };
  pricing: LivePricing;
};

export type AppHomeFixture = "paid" | "free" | "setup";
export type ShopifyBillingTerm = "monthly" | "annual";

export type ShopifyConnectionConfirmation = {
  shop: string;
  workspace: {
    display_name: string;
    account_email: string | null;
    role: "owner" | "admin";
  };
  link_only?: boolean;
};

export type ShopifyAppHomeLoadResult =
  | { kind: "setup" }
  | { kind: "link" }
  | { kind: "ready"; data: ShopifyAppHome };

export type AppHomeState =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "link" }
  | { kind: "unavailable" }
  | { kind: "ready"; data: ShopifyAppHome }
  | { kind: "error"; message: string };
