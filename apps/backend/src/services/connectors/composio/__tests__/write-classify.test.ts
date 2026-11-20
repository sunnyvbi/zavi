import { describe, it, expect, vi } from "vitest";
vi.mock("../catalog", () => ({
  listToolkitToolSlugs: async (k: string) =>
    new Set(
      ({
        google_analytics: ["GOOGLE_ANALYTICS_RUN_REPORT"],
        googlecalendar: ["GOOGLECALENDAR_CREATE_EVENT"],
        stripe: ["STRIPE_CREATE_REFUND"],
        gmail: ["GMAIL_SEND_EMAIL"],
        acme: ["WIDGETCO_DELETE_ITEM"],
      } as Record<string, string[]>)[k] ?? [],
    ),
}));
import { toolkitForTool, classifyComposioWrite, actionWords, composioToolIsRead, shopifyGraphqlCallIsReadOnly } from "../write-classify";

describe("toolkitForTool (catalog membership, not prefix)", () => {
  it("maps by the toolkit's real tool list; unconnected or unknown → null", async () => {
    expect(await toolkitForTool("GOOGLE_ANALYTICS_RUN_REPORT", ["google_analytics", "googlecalendar"])).toBe("google_analytics");
    expect(await toolkitForTool("GOOGLECALENDAR_CREATE_EVENT", ["googlecalendar"])).toBe("googlecalendar");
    expect(await toolkitForTool("STRIPE_CREATE_REFUND", ["gmail"])).toBeNull();
    expect(await toolkitForTool("STRIPE_NOT_A_REAL_TOOL", ["stripe"])).toBeNull();
  });
  it("a tool whose name carries no connected prefix is owned by the toolkit whose list holds it", async () => {
    expect(await toolkitForTool("WIDGETCO_DELETE_ITEM", ["acme"])).toBe("acme");
  });
});

describe("classifyComposioWrite for Shopify", () => {
  it("files every Shopify write under the owner-only, never-auto Shopify class with the money label", () => {
    expect(classifyComposioWrite({ toolkit: "shopify", tool_slug: "SHOPIFY_GRAPH_QL_PRODUCTS", destructive: false }))
      .toEqual({ labels: ["moves_money"], decision_class: "composio.shopify_write" });
    expect(classifyComposioWrite({ toolkit: "shopify", tool_slug: "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", destructive: true }))
      .toEqual({ labels: ["moves_money", "deletes_data"], decision_class: "composio.shopify_write" });
  });
});

describe("composioToolIsRead (explicit read-verb allowlist, every toolkit)", () => {
  it("treats only the pinned Shopify GraphQL read surfaces as reads and validates mixed product operations", () => {
    expect(composioToolIsRead("SHOPIFY_GRAPH_QL_PRODUCTS", "shopify", { destructiveHint: true })).toBe(true);
    expect(composioToolIsRead("SHOPIFY_GRAPH_QL_ORDERS", "shopify", {})).toBe(true);
    expect(composioToolIsRead("SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", "shopify", { readOnlyHint: true })).toBe(false);
    expect(shopifyGraphqlCallIsReadOnly("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "list_products" })).toBe(true);
    expect(shopifyGraphqlCallIsReadOnly("SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "delete_product" })).toBe(false);
    expect(shopifyGraphqlCallIsReadOnly("SHOPIFY_GRAPH_QL_ORDERS", { operation: "list_orders" })).toBe(true);
    expect(shopifyGraphqlCallIsReadOnly("SHOPIFY_GRAPH_QL_ORDERS", { operation: "list_orders", custom_document: "mutation { x }" })).toBe(false);
  });
  it("reads only by leading read verb with no mutating token and no destructiveHint", () => {
    expect(composioToolIsRead("GMAIL_FETCH_EMAILS", "gmail", {})).toBe(true);
    expect(composioToolIsRead("STRIPE_LIST_CHARGES", "stripe", {})).toBe(true);
    expect(composioToolIsRead("GMAIL_SEND_EMAIL", "gmail", { readOnlyHint: true })).toBe(false);
    expect(composioToolIsRead("STRIPE_CAPTURE_PAYMENT_INTENT", "stripe", { readOnlyHint: true })).toBe(false);
    expect(composioToolIsRead("LINEAR_RUN_QUERY_OR_MUTATION", "linear", { readOnlyHint: true })).toBe(false);
    expect(composioToolIsRead("NOTION_QUERY_DATABASE", "notion", {})).toBe(false);
    expect(composioToolIsRead("HUBSPOT_GET_OR_CREATE_CONTACT", "hubspot", {})).toBe(false);
    expect(composioToolIsRead("ACME_GET_AND_DELETE_ITEM", "acme", {})).toBe(false);
    expect(composioToolIsRead("NOTION_GET_PAGE", "notion", { destructiveHint: true })).toBe(false);
    expect(composioToolIsRead("ACME_SYNC_ACCOUNT", "acme", {})).toBe(false);
  });
  it("matches the read verb at the verb position after the TOOLKIT_ prefix, never as a substring", () => {
    expect(composioToolIsRead("GMAIL_THREAD_MOVE", "gmail", { readOnlyHint: true })).toBe(false);
    expect(composioToolIsRead("GMAIL_THREAD_GET", "gmail", {})).toBe(true);
    expect(composioToolIsRead("ACME_READER_ENABLE", "acme", {})).toBe(false);
    expect(composioToolIsRead("ACME_GETAWAY_BOOK", "acme", {})).toBe(false);
    expect(composioToolIsRead("ACME_UNREAD_ALL", "acme", {})).toBe(false);
    expect(composioToolIsRead("ACME_READ_MESSAGE", "acme", {})).toBe(true);
    expect(composioToolIsRead("GMAIL_LIST_THREADS", "gmail", {})).toBe(true);
  });
  it("mixpanel: every live report tool is a read (they were approval cards the agent never got results from)", () => {
    for (const slug of [
      "MIXPANEL_AGGREGATED_EVENT_PROPERTY_VALUES", "MIXPANEL_AGGREGATE_EVENT_COUNTS", "MIXPANEL_AGGREGATE_EVENTS",
      "MIXPANEL_GET_ALL_PROJECTS", "MIXPANEL_JQL_QUERY", "MIXPANEL_LIST_COHORTS", "MIXPANEL_LIST_FUNNELS",
      "MIXPANEL_PROFILE_EVENT_ACTIVITY", "MIXPANEL_QUERY_FREQUENCY_REPORT", "MIXPANEL_QUERY_FUNNEL",
      "MIXPANEL_QUERY_INSIGHT", "MIXPANEL_QUERY_NUMERIC_AVERAGE", "MIXPANEL_QUERY_NUMERIC_SEGMENTATION",
      "MIXPANEL_QUERY_NUMERIC_SUM", "MIXPANEL_QUERY_PROFILES", "MIXPANEL_QUERY_RETENTION_REPORT",
      "MIXPANEL_QUERY_SEGMENTATION", "MIXPANEL_TODAYS_TOP_EVENTS", "MIXPANEL_TOP_EVENT_PROPERTIES",
      "MIXPANEL_TOP_EVENT_PROPERTY_VALUES", "MIXPANEL_TOP_EVENTS",
    ]) expect(composioToolIsRead(slug, "mixpanel", { readOnlyHint: true }), slug).toBe(true);
  });
  it("mixpanel: a write-shaped slug is still a write, and the extra verbs are mixpanel-only", () => {
    expect(composioToolIsRead("MIXPANEL_IMPORT_EVENTS", "mixpanel", {})).toBe(false);
    expect(composioToolIsRead("MIXPANEL_DELETE_PROFILE", "mixpanel", {})).toBe(false);
    expect(composioToolIsRead("MIXPANEL_QUERY_AND_DELETE_PROFILES", "mixpanel", {})).toBe(false);
    expect(composioToolIsRead("MIXPANEL_PROFILE_UPDATE", "mixpanel", {})).toBe(false);
    for (const slug of ["MIXPANEL_PROFILE_UNION", "MIXPANEL_PROFILE_APPEND", "MIXPANEL_PROFILE_UNSET", "MIXPANEL_PROFILE_ENGAGE"])
      expect(composioToolIsRead(slug, "mixpanel", { readOnlyHint: true }), slug).toBe(false);
    expect(composioToolIsRead("MIXPANEL_TOP_EVENTS", "mixpanel", { destructiveHint: true })).toBe(false);
    expect(composioToolIsRead("NOTION_QUERY_DATABASE", "notion", {})).toBe(false);
    expect(composioToolIsRead("POSTHOG_TOP_EVENTS", "posthog", {})).toBe(false);
  });
  it("read names that contain a write verb as a NOUN are reads (live catalog, 2026-10-22)", () => {
    for (const [slug, kit] of [
      ["INSTAGRAM_GET_POST_INSIGHTS", "instagram"], ["INSTAGRAM_GET_POST_COMMENTS", "instagram"],
      ["REDDIT_ADS_GET_PRODUCT_SET", "reddit_ads"], ["GMAIL_LIST_SEND_AS", "gmail"],
      ["SENTRY_GET_ORGANIZATION_BY_ID_OR_SLUG", "sentry"], ["SENTRY_RETRIEVE_PROJECT_KEYS_BY_ORG_AND_PROJECT", "sentry"],
      ["GOOGLE_ANALYTICS_LIST_EVENT_CREATE_RULES", "google_analytics"], ["GOOGLEDRIVE_GET_CHANGES_START_PAGE_TOKEN", "googledrive"],
      ["SENTRY_RETRIEVE_SAVED_DISCOVER_QUERY_FOR_ORGANIZATION", "sentry"],
    ]) expect(composioToolIsRead(slug, kit, {}), slug).toBe(true);
  });
  it("DOWNLOAD is a read verb", () => {
    expect(composioToolIsRead("GOOGLEDRIVE_DOWNLOAD_FILE", "googledrive", {})).toBe(true);
    expect(composioToolIsRead("TIKTOK_ADS_DOWNLOAD_REPORT_TASK", "tiktok_ads", {})).toBe(true);
    expect(composioToolIsRead("ACME_DOWNLOAD_AND_DELETE_FILE", "acme", {})).toBe(false);
  });
  it("a noun-or-write word right after OR/AND/THEN is still a write", () => {
    for (const slug of ["ACME_GET_OR_CREATE_ITEM", "ACME_FETCH_AND_SEND_REPORT", "ACME_LIST_THEN_POST_SUMMARY", "ACME_GET_OR_SET_FLAG"])
      expect(composioToolIsRead(slug, "acme", {}), slug).toBe(false);
  });
  it("every generic write verb is a write anywhere in a read name", () => {
    for (const v of ["UPDATE", "ADD", "PUT", "PATCH", "INSERT", "WRITE", "EDIT", "MOVE", "MERGE", "APPROVE", "REJECT", "CLOSE", "ASSIGN", "ENABLE", "DISABLE", "RUN", "EXECUTE", "TRIGGER", "PAY", "REFUND", "CHARGE", "TRANSFER", "PUBLISH", "SUBMIT", "INVITE", "UPLOAD", "MUTATE", "STOP", "REMOVE", "ARCHIVE", "CANCEL", "REVOKE"])
      expect(composioToolIsRead(`ACME_GET_ITEM_${v}`, "acme", {}), v).toBe(false);
  });
  it("resource_method names ending in GET/LIST are reads; a write-verb resource is not", () => {
    for (const [slug, kit] of [
      ["GOOGLECALENDAR_EVENTS_LIST", "googlecalendar"], ["GOOGLECALENDAR_CALENDAR_LIST_GET", "googlecalendar"],
      ["GOOGLESHEETS_VALUES_GET", "googlesheets"], ["GOOGLESHEETS_BATCH_GET", "googlesheets"], ["HEYGEN_V1_AVATAR_LIST", "heygen"],
    ]) expect(composioToolIsRead(slug, kit, {}), slug).toBe(true);
    for (const slug of ["ACME_SET_GET", "ACME_CREATE_LIST", "ACME_POST_GET", "ACME_OR_GET", "ACME_ITEM_UPDATE_GET", "ACME_GET"])
      expect(composioToolIsRead(slug, "acme", {}), slug).toBe(slug === "ACME_GET");
    expect(composioToolIsRead("GOOGLECALENDAR_EVENTS_MOVE", "googlecalendar", {})).toBe(false);
    expect(composioToolIsRead("GOOGLECALENDAR_EVENTS_LIST", "googlecalendar", { destructiveHint: true })).toBe(false);
  });
  it("a slug without the toolkit's prefix is never a read (fail closed)", () => {
    expect(composioToolIsRead("WIDGETCO_GET_ITEM", "acme", {})).toBe(false);
    expect(composioToolIsRead("GET_ITEM", "acme", {})).toBe(false);
  });
});

describe("classifyComposioWrite (labels fail toward labelling; dual risk explicit)", () => {
  it("any write on a money toolkit = Moves money", () => {
    const c = classifyComposioWrite({ toolkit: "stripe", tool_slug: "STRIPE_UPDATE_CUSTOMER", destructive: false });
    expect(c.labels).toEqual(["moves_money"]);
    expect(c.decision_class).toBe("composio.moves_money");
  });
  it("delete-ish verbs or destructiveHint = Deletes data", () => {
    expect(classifyComposioWrite({ toolkit: "notion", tool_slug: "NOTION_ARCHIVE_PAGE", destructive: false }).labels).toEqual(["deletes_data"]);
    expect(classifyComposioWrite({ toolkit: "notion", tool_slug: "NOTION_UPDATE_PAGE", destructive: true }).decision_class).toBe("composio.deletes_data");
  });
  it("both → both labels carried; class = moves_money (the owner-only class either way)", () => {
    const c = classifyComposioWrite({ toolkit: "stripe", tool_slug: "STRIPE_DELETE_CUSTOMER", destructive: false });
    expect(c.labels).toEqual(["moves_money", "deletes_data"]);
    expect(c.decision_class).toBe("composio.moves_money");
  });
  it("any write on an ad toolkit = Moves money; reads stay reads", () => {
    for (const [toolkit, tool_slug] of [
      ["reddit_ads", "REDDIT_ADS_CREATE_CAMPAIGN"],
      ["reddit_ads", "REDDIT_ADS_UPDATE_CAMPAIGN"],
      ["tiktok_ads", "TIKTOK_ADS_CREATE_SMART_PLUS_CAMPAIGN"],
      ["metaads", "METAADS_UPDATE_AD_SET"],
      ["googleads", "GOOGLEADS_CREATE_CAMPAIGN"],
      ["snapchat", "SNAPCHAT_CREATE_CAMPAIGN"],
      ["vibe", "VIBE_PUBLISH_CAMPAIGN"],
      ["amazon_ads", "AMAZON_ADS_CREATE_CAMPAIGN"],
    ]) {
      expect(classifyComposioWrite({ toolkit, tool_slug, destructive: false }).decision_class).toBe("composio.moves_money");
    }
    expect(composioToolIsRead("REDDIT_ADS_GET_A_REPORT", "reddit_ads", {})).toBe(true);
    expect(composioToolIsRead("TIKTOK_ADS_CREATE_SMART_PLUS_CAMPAIGN", "tiktok_ads", {})).toBe(false);
  });
  it("a 'leads' toolkit is not an ad toolkit", () => {
    expect(classifyComposioWrite({ toolkit: "aeroleads", tool_slug: "AEROLEADS_ADD_PROSPECT", destructive: false }).decision_class).toBe("composio.write");
  });
  it("plain write", () => {
    expect(classifyComposioWrite({ toolkit: "gmail", tool_slug: "GMAIL_SEND_EMAIL", destructive: false }))
      .toEqual({ labels: [], decision_class: "composio.write" });
  });
});

describe("actionWords", () => {
  it("strips the toolkit prefix and sentence-cases", () => {
    expect(actionWords("STRIPE_CREATE_REFUND", "stripe")).toBe("Create refund");
    expect(actionWords("WIDGETCO_DELETE_ITEM", "acme")).toBe("Widgetco delete item");
  });
});
