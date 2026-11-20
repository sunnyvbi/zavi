import { listToolkitToolSlugs } from "./catalog";

export const MONEY_TOOLKITS: ReadonlySet<string> = new Set([
  "stripe", "paypal", "square", "razorpay", "braintree", "chargebee", "adyen",
  "wise", "mercury", "brex", "ramp", "quickbooks", "xero", "shopify",
  "metaads", "googleads", "reddit_ads", "tiktok_ads", "linkedin_ads", "pinterest_ads",
  "snapchat", "vibe",
]);
const ADS_TOOLKIT_RE = /(^|_)ads$/;
export function isMoneyToolkit(toolkit: string): boolean {
  const t = toolkit.toLowerCase();
  return MONEY_TOOLKITS.has(t) || ADS_TOOLKIT_RE.test(t);
}
const DELETE_RE = /(^|_)(DELETE|REMOVE|ARCHIVE|DESTROY|PURGE|TRASH|CANCEL|REVOKE|VOID|DETACH|UNSUBSCRIBE|CLEAR|EMPTY)(_|$)/;
const READ_VERB_RE = /^(LIST|GET|FETCH|SEARCH|RETRIEVE|READ|FIND|COUNT|DESCRIBE|LOOKUP|DOWNLOAD)(_|$)/;
const TOOLKIT_READ_VERB_RE: Readonly<Record<string, RegExp>> = {
  mixpanel: /^(QUERY|TOP|TODAYS|AGGREGATE|AGGREGATED|PROFILE_EVENT_ACTIVITY|JQL_QUERY)(_|$)/,
};
const STRONG_WRITE_TOKENS: ReadonlySet<string> = new Set([
  "UPDATE", "UPSERT", "ADD", "PUT", "PATCH", "INSERT", "WRITE", "EDIT", "MODIFY", "MOVE", "MERGE",
  "APPROVE", "REJECT", "CAPTURE", "CONFIRM", "FINALIZE", "PAY", "REFUND", "CHARGE", "TRANSFER",
  "PUBLISH", "SUBMIT", "INVITE", "ASSIGN", "ENABLE", "DISABLE", "STOP", "RUN", "EXECUTE", "TRIGGER",
  "MUTATION", "MUTATE", "UPLOAD", "CLOSE",
]);
const NOUN_OR_WRITE_TOKENS: ReadonlySet<string> = new Set([
  "CREATE", "SET", "SEND", "POST", "COPY", "START", "QUERY", "IMPORT", "EXPORT", "SYNC",
]);
const CONJUNCTIONS: ReadonlySet<string> = new Set(["OR", "AND", "THEN"]);
const TRAILING_READ_VERBS: ReadonlySet<string> = new Set(["GET", "LIST"]);

function hasWriteToken(rest: string): boolean {
  if (DELETE_RE.test(rest)) return true;
  const tokens = rest.split("_").filter(Boolean);
  return tokens.some(
    (t, i) => STRONG_WRITE_TOKENS.has(t) || (NOUN_OR_WRITE_TOKENS.has(t) && i > 0 && CONJUNCTIONS.has(tokens[i - 1])),
  );
}

export type ComposioWriteLabel = "moves_money" | "deletes_data";
export type ComposioDecisionClass = "composio.write" | "composio.moves_money" | "composio.deletes_data" | "composio.shopify_write";
export const COMPOSIO_SHOPIFY_WRITE_CLASS: ComposioDecisionClass = "composio.shopify_write";
export const COMPOSIO_DECISION_CLASSES: ReadonlySet<string> = new Set<ComposioDecisionClass>([
  "composio.write", "composio.moves_money", "composio.deletes_data", COMPOSIO_SHOPIFY_WRITE_CLASS,
]);
export const COMPOSIO_EXECUTE_HANDLER = "composio.execute_tool";
export function isComposioDecisionClass(cls: string | null | undefined): boolean {
  return typeof cls === "string" && cls.startsWith("composio.");
}
export type ComposioClassificationInputs = { destructive: boolean };

const SHOPIFY_GRAPHQL_READ_OPERATIONS: Readonly<Record<string, ReadonlySet<string> | null>> = {
  SHOPIFY_GRAPH_QL_SHOP: null,
  SHOPIFY_GRAPH_QL_PRODUCTS: new Set(["list_products", "get_product", "count_products"]),
  SHOPIFY_GRAPH_QL_ORDERS: new Set(["list_orders", "get_order", "count_orders"]),
};

export function shopifyGraphqlCallIsReadOnly(toolSlug: string, args: unknown): boolean {
  if (!(toolSlug in SHOPIFY_GRAPHQL_READ_OPERATIONS)) return false;
  if (!args || typeof args !== "object" || Array.isArray(args)) return toolSlug === "SHOPIFY_GRAPH_QL_SHOP";
  const input = args as Record<string, unknown>;
  if (input.custom_document !== undefined) return false;
  const operations = SHOPIFY_GRAPHQL_READ_OPERATIONS[toolSlug];
  return operations === null || (typeof input.operation === "string" && operations.has(input.operation));
}

export async function toolkitForTool(tool_slug: string, connected: readonly string[]): Promise<string | null> {
  for (const t of connected) if ((await listToolkitToolSlugs(t)).has(tool_slug)) return t;
  return null;
}

export function composioToolIsRead(
  tool_slug: string,
  toolkit: string,
  annotations: { destructiveHint?: boolean; [k: string]: unknown } | undefined,
): boolean {
  if (toolkit.toLowerCase() === "shopify" && tool_slug in SHOPIFY_GRAPHQL_READ_OPERATIONS) return true;
  if (annotations?.destructiveHint === true) return false;
  const up = tool_slug.toUpperCase();
  const prefix = `${toolkit.toUpperCase()}_`;
  if (!up.startsWith(prefix)) return false;
  const rest = up.slice(prefix.length);
  const m = READ_VERB_RE.exec(rest) ?? TOOLKIT_READ_VERB_RE[toolkit.toLowerCase()]?.exec(rest) ?? null;
  if (m) return !hasWriteToken(rest.slice(m[1].length));
  const tokens = rest.split("_").filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (tokens.length < 2 || !TRAILING_READ_VERBS.has(last)) return false;
  if (NOUN_OR_WRITE_TOKENS.has(tokens[0]) || CONJUNCTIONS.has(tokens[0])) return false;
  return !hasWriteToken(rest);
}

export function classifyComposioWrite(
  a: { toolkit: string; tool_slug: string } & ComposioClassificationInputs,
): { labels: ComposioWriteLabel[]; decision_class: ComposioDecisionClass } {
  const labels: ComposioWriteLabel[] = [];
  if (isMoneyToolkit(a.toolkit)) labels.push("moves_money");
  if (a.destructive === true || DELETE_RE.test(a.tool_slug.toUpperCase())) labels.push("deletes_data");
  const decision_class: ComposioDecisionClass = a.toolkit.toLowerCase() === "shopify"
    ? COMPOSIO_SHOPIFY_WRITE_CLASS
    : labels.includes("moves_money")
      ? "composio.moves_money"
      : labels.includes("deletes_data")
        ? "composio.deletes_data"
        : "composio.write";
  return { labels, decision_class };
}

export function actionWords(tool_slug: string, toolkit: string): string {
  const prefixed = tool_slug.toUpperCase().startsWith(`${toolkit.toUpperCase()}_`);
  const rest = (prefixed ? tool_slug.slice(toolkit.length + 1) : tool_slug).toLowerCase().replace(/_/g, " ").trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : tool_slug;
}
