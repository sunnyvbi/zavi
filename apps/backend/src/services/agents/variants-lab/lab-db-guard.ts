
import { AsyncLocalStorage } from "node:async_hooks";

export const LAB_READ_RPCS: ReadonlySet<string> = new Set([
  "_social_publish_enabled",
  "ad_budget_month_view",
  "agent_feedback_summary",
  "app_active_tenant",
  "channel_budget_allows",
  "channel_credits_30d",
  "code_symbol_query",
  "disabled_member_emails",
  "effective_autonomy",
  "email_allowlist_entries",
  "first_build_free_eligible",
  "get_channel_settings",
  "free_edit_state",
  "get_prototype_link_by_slug",
  "get_public_shared_page",
  "is_fleet_halted",
  "is_own_inbox_address",
  "is_tenant_member_email",
  "list_email_allowlist",
  "list_email_member_disabled",
  "mac_worker_can_access",
  "memory_nearest_neighbors",
  "memory_search_hybrid",
  "memory_search_hybrid_v2",
  "memory_search_lex_or",
  "public_live_stats",
  "schema_invariants_ok",
  "tenant_member_emails",
  "comms_is_suppressed",
  "comms_is_unsubscribed",
  "comms_rolling_24h_count",
  "eligible_self_heal_signatures",
  "fundraising_list_investors",
  "get_action_outcome_signal",
  "get_buffer_connection",
  "get_growth_bet_outcomes",
  "get_latest_ad_snapshot",
  "get_native_funnel",
  "get_perf_dashboard_snapshot",
  "get_secret",
  "get_tabs_session",
  "get_team_member_detail",
  "get_user_prefs",
  "is_email_suppressed",
  "lineage_tree_stats",
  "list_agents_for_tenant",
  "list_team_members",
  "list_tenant_commands",
  "resolve_decision_actors",
  "resolve_email_recipient",
  "resolve_slack_approver",
  "resolve_slack_owner_dm",
  "site_by_hostname",
  "site_by_repo",
]);

export const LAB_CARD_RPCS: ReadonlySet<string> = new Set([
  "lab_card_parity",
  "lab_card_seed",
  "lab_record_channel_run_actions",
  "lab_open_channel_actions",
  "lab_card_clear",
]);

const SLACK_READ_METHOD =
  /^(?:auth\.test|team\.info|bots\.info|conversations\.(?:history|replies|info|list|members)|users\.(?:info|list|lookupByEmail|profile\.get|conversations)|files\.info|reactions\.get|search\.[a-z]+|emoji\.list)$/;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const NON_ROTATING_REFRESH_HOSTS = new Set(["oauth2.googleapis.com", "accounts.google.com", "www.googleapis.com"]);

export function isRefreshTokenGrant(rawUrl: string, body: unknown): boolean {
  const re = /grant_type["']?\s*[:=]\s*["']?refresh_token\b/i;
  if (re.test(rawUrl)) return true;
  if (typeof body === "string") return re.test(body);
  if (body instanceof URLSearchParams) return body.get("grant_type") === "refresh_token";
  return false;
}

export const LAB_DB_BLOCK_PREFIX = "variants lab: prod write blocked";

export function labBlockedTarget(
  rawUrl: string,
  method: string,
  supabaseHost: string,
  body?: unknown,
): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const m = method.toUpperCase();
  const host = u.hostname.toLowerCase();
  if (isRefreshTokenGrant(rawUrl, body) && !NON_ROTATING_REFRESH_HOSTS.has(host)) return `oauth_refresh:${host}`;
  if (host === "inn.gs" || host.endsWith(".inn.gs") || host === "inngest.com" || host.endsWith(".inngest.com")) {
    return "inngest";
  }
  if (host === "hooks.slack.com" || host.endsWith(".hooks.slack.com")) return "slack:webhook";
  if (host === "slack.com" || host.endsWith(".slack.com")) {
    const api = /^\/api\/([A-Za-z.]+)/.exec(u.pathname);
    if (api) return SLACK_READ_METHOD.test(api[1]) ? null : `slack:${api[1]}`;
    return READ_METHODS.has(m) ? null : `slack:${u.pathname}`;
  }
  if (host !== supabaseHost.toLowerCase()) return null;
  if (READ_METHODS.has(m)) return null;
  const rpc = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)\/?$/.exec(u.pathname);
  if (rpc) return m === "POST" && (LAB_READ_RPCS.has(rpc[1]) || LAB_CARD_RPCS.has(rpc[1])) ? null : `rpc:${rpc[1]}`;
  const table = /^\/rest\/v1\/([A-Za-z0-9_]+)/.exec(u.pathname);
  if (table) return `${m.toLowerCase()}:${table[1]}`;
  const svc = /^\/(storage|auth|functions|graphql)\/v1\/?([^?]*)/.exec(u.pathname);
  if (svc) return `${svc[1]}:${svc[2].split("/").slice(0, 2).join("/") || "/"}`;
  return `${m.toLowerCase()}:${u.pathname}`;
}

const columnLog = new AsyncLocalStorage<string[]>();

export async function withLabDbWriteLog<T>(fn: (log: string[]) => Promise<T>): Promise<T> {
  const log: string[] = [];
  return columnLog.run(log, () => fn(log));
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function methodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  return (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : undefined) ?? "GET").toUpperCase();
}

export function makeLabGuardedFetch(opts: {
  supabaseUrl: string;
  baseFetch: typeof fetch;
  onBlocked?: (target: string) => void;
}): typeof fetch {
  const host = new URL(opts.supabaseUrl).hostname;
  const guarded = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = labBlockedTarget(urlOf(input), methodOf(input, init), host, init?.body);
    if (target) {
      columnLog.getStore()?.push(target);
      (opts.onBlocked ?? ((t: string) => console.warn(`[variants-lab] ${LAB_DB_BLOCK_PREFIX} (${t})`)))(target);
      return Promise.reject(new Error(`${LAB_DB_BLOCK_PREFIX} (${target})`));
    }
    return opts.baseFetch(input, init);
  };
  return guarded as typeof fetch;
}

export function blockSendgridClient(ClientClass: { prototype: { request: unknown } }): void {
  ClientClass.prototype.request = function blockedRequest(_data: unknown, cb?: (err: Error) => void) {
    const err = new Error(`${LAB_DB_BLOCK_PREFIX} (sendgrid)`);
    columnLog.getStore()?.push("sendgrid");
    console.warn(`[variants-lab] ${err.message}`);
    if (typeof cb === "function") cb(err);
    return Promise.reject(err);
  };
}

export const LAB_DELETED_OUTBOUND_ENV = ["PRAXIS_ALERTS_SLACK_WEBHOOK"] as const;
