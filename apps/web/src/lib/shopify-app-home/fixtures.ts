import { PRICING_FALLBACK } from "@/lib/marketing/pricing";
import type { AppHomeFixture, ShopifyAppHome } from "./types";

const NOW = "2026-10-29T09:00:00.000Z";
const SYNCED = "2026-10-29T08:48:00.000Z";
const SHOP = "zavi-test-store.myshopify.com";
const SCOPES = ["read_products", "write_products", "read_orders", "read_discounts", "write_discounts"];

const shop = { domain: SHOP, display_name: "Zavi Test Store", connection: "connected" as const, last_synced_at: SYNCED, scopes: SCOPES };

const sales = { value: 4820, unit: "usd" as const, comparison: 12, availability: "live" as const, source: "shopify" as const, measured_at: NOW, note: null };
const orders = { value: 38, unit: "count" as const, comparison: 6, availability: "live" as const, source: "shopify" as const, measured_at: NOW, note: null };

export const PAID_FIXTURE: ShopifyAppHome = {
  shop,
  workspace: { id: "fixture-workspace", display_name: "Zavi Test Store", viewer_role: "owner" },
  status: {
    mode: "working",
    headline: "This week: push The Collection Snowboard: Liquid before first snow",
    detail: "Zavi is running 3 tasks · next post Thu 29 Oct, 9:00 AM",
    channels: [
      { slug: "instagram_organic", label: "Instagram", state: "connected" },
      { slug: "meta_ads", label: "Meta Ads", state: "connected" },
      { slug: "email_marketing", label: "Email", state: "connected" },
      { slug: "google_ads", label: "Google Ads", state: "not_connected" },
    ],
  },
  metrics: {
    window_days: 7,
    sales,
    orders,
    zavi_actions: { value: 14, unit: "count", comparison: null, availability: "live", source: "zavi", measured_at: NOW, note: "9 posts · 1 email · 4 ad edits" },
    ad_spend: { value: 640, unit: "usd", comparison: null, availability: "live", source: "ad_provider", measured_at: NOW, note: "ROAS 2.4 in Meta" },
    shopify_last_synced_at: SYNCED,
  },
  approvals: {
    rows: [
      {
        id: "fixture-approval-ig",
        channel: "instagram_organic",
        title: "Update the winter collection homepage hero",
        consequence: "Marks this manual growth step as complete. It does not change Shopify data.",
        one_click_approvable: true,
        needs_owner_admin: false,
        review_url: "https://www.zaviagent.com/approvals",
        preview_url: null,
      },
      {
        id: "fixture-approval-meta",
        channel: "meta_ads",
        title: "Raise daily budget: “Liquid snowboard – retargeting”",
        consequence: "Changes the Meta Ads budget from $25 to $40 a day. Max extra spend $105 this week.",
        one_click_approvable: false,
        needs_owner_admin: true,
        review_url: "https://www.zaviagent.com/approvals",
        preview_url: null,
      },
      {
        id: "fixture-approval-email",
        channel: "email_marketing",
        title: "Email: “Winter boards are back”",
        consequence: "Sends this email to 412 people on Store subscribers. Each email includes an unsubscribe link.",
        one_click_approvable: false,
        needs_owner_admin: true,
        review_url: "https://www.zaviagent.com/approvals",
        preview_url: "https://www.zaviagent.com/approvals",
      },
    ],
    remaining: 3,
  },
  billing: {
    tier: "pro",
    source: "shopify",
    status: "active",
    period_end: "2026-11-14T00:00:00.000Z",
    credits_total: 96000,
    credits_used: 31200,
    credits_remaining: 64800,
    daily_allowance: PRICING_FALLBACK.freeDailyCredits,
    daily_remaining: PRICING_FALLBACK.freeDailyCredits,
    manage_url: null,
    can_manage: true,
    available_terms: ["monthly", "annual"],
    billing_lock_reason: null,
  },
  pricing: PRICING_FALLBACK,
};

export const FREE_FIXTURE: ShopifyAppHome = {
  shop,
  workspace: { id: "fixture-workspace", display_name: "Zavi Test Store", viewer_role: "owner" },
  status: {
    mode: "drafting_only",
    headline: "Your 30-day growth plan is ready. 4 of 12 steps done.",
    detail: "Zavi waits for you to post or launch anything yourself.",
    channels: [
      { slug: "instagram_organic", label: "Instagram", state: "draft_only" },
      { slug: "meta_ads", label: "Meta Ads", state: "plan_locked", locked_tier: "pro" },
      { slug: "email_marketing", label: "Email", state: "plan_locked", locked_tier: "pro" },
    ],
  },
  metrics: {
    window_days: 7,
    sales,
    orders,
    zavi_actions: { value: 0, unit: "count", comparison: null, availability: "live", source: "zavi", measured_at: NOW, note: "Drafts: 6" },
    ad_spend: { value: null, unit: "usd", comparison: null, availability: "plan_locked", source: "ad_provider", measured_at: null, note: "Needs Meta Ads", locked_tier: "pro" },
    shopify_last_synced_at: SYNCED,
  },
  approvals: { rows: [], remaining: 0 },
  billing: {
    tier: "free",
    source: null,
    status: "active",
    period_end: null,
    credits_total: 0,
    credits_used: 0,
    credits_remaining: 0,
    daily_allowance: PRICING_FALLBACK.freeDailyCredits,
    daily_remaining: PRICING_FALLBACK.freeDailyCredits,
    manage_url: null,
    can_manage: true,
    available_terms: ["monthly", "annual"],
    billing_lock_reason: null,
  },
  pricing: PRICING_FALLBACK,
};

export function fixtureFor(name: AppHomeFixture): ShopifyAppHome {
  return name === "free" ? FREE_FIXTURE : PAID_FIXTURE;
}
