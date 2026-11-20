
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { composioExecuteTool } from "@/services/connectors/composio/api";
import { resolveSendgridAccount, sendgridKeyNeedsPermissions } from "@/services/connectors/email-campaign/sendgrid-account";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { EMAIL_PROVIDERS, EMAIL_TOOL_LABEL, EMAIL_TOOLS, type Audience, type EmailTool, type ProviderCall } from "@/services/connectors/email-campaign/providers";
import { readTestListKeys, testListKey } from "@/services/email-cards/variants";
import { isKeyRejected, keyRejectedText } from "@/services/connectors/email-campaign/provider-errors";
import { listSummaries, listSummariesFor } from "@/services/comms/bulk-outbound/lists";

export const TEST_LIST_ROUTES = [...EMAIL_TOOLS, "zavi_list"] as const;
export type TestListRoute = (typeof TEST_LIST_ROUTES)[number];
export const ROUTE_LABEL: Record<TestListRoute, string> = { ...EMAIL_TOOL_LABEL, zavi_list: "Zavi lists" };

export type ReadLimits = { maxPages: number; routeTimeoutMs: number; callTimeoutMs: number };
export const READ_LIMITS: Readonly<ReadLimits> = { maxPages: 50, routeTimeoutMs: 15_000, callTimeoutMs: 10_000 };

export type SizeLimits = { maxCalls: number; budgetMs: number };
export const LIST_SIZE_LIMITS: Readonly<SizeLimits> = { maxCalls: 10, budgetMs: 3_000 };

export type ReadStatus = "complete" | "partial" | "unreadable" | "not_connected" | "needs_permissions";

export const SENDGRID_NEEDS_PERMISSIONS = "The saved SendGrid key sends one-to-one email but is missing the permissions campaigns need. Paste a key with campaign permissions.";

export type TestListRow = { id: string; name: string; people: number | null; marked: boolean; looks_like_test: boolean; needs_consent?: true; consented_version?: true };
export type RouteLists = { route: TestListRoute; label: string; status: ReadStatus; error: string | null; lists: TestListRow[] };
export type OrphanMark = { route: TestListRoute; list_id: string; reason: "not_found" | "not_checked"; can_unmark: boolean; note: string };
export type TestListsView = { routes: RouteLists[]; orphans: OrphanMark[] };

export function looksLikeTest(name: string): boolean {
  return /(^|[^a-z])(test|tests|testing|seed|internal|qa|sandbox|dummy|staging)([^a-z]|$)/i.test(name);
}

export type ToolCaller = (tenantId: string, tool: EmailTool) => Promise<ProviderCall | null>;

export async function liveToolCaller(tenantId: string, tool: EmailTool): Promise<ProviderCall | null> {
  if (tool === "sendgrid") {
    const sg = await resolveSendgridAccount(tenantId);
    return sg ? sendgridHttpCall(sg.api_key, fetch, READ_LIMITS.callTimeoutMs) : null;
  }
  const acct = await resolveOwnedComposioAccount(tenantId, tool);
  if (!acct) return null;
  return async (tool_slug, args) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), READ_LIMITS.callTimeoutMs);
    try {
      return await composioExecuteTool({ tool_slug, user_id: acct.tenant_id, connected_account_id: acct.connected_account_id, arguments: args }, ctl.signal);
    } finally {
      clearTimeout(timer);
    }
  };
}

export type ToolRead = { status: ReadStatus; lists: Audience[]; error: string | null };

export async function readToolLists(
  tenantId: string,
  tool: EmailTool,
  deps: { caller: ToolCaller; now?: () => number; limits?: Partial<ReadLimits>; size?: SizeLimits },
  stopWhen?: (lists: Audience[]) => boolean,
): Promise<ToolRead> {
  const now = deps.now ?? Date.now;
  const limits = { ...READ_LIMITS, ...(deps.limits ?? {}) };
  const label = EMAIL_TOOL_LABEL[tool];
  let call: ProviderCall | null;
  try {
    call = await deps.caller(tenantId, tool);
  } catch {
    return { status: "unreadable", lists: [], error: `Zavi could not check the ${label} connection right now. Try again in a minute.` };
  }
  if (!call) return { status: "not_connected", lists: [], error: null };
  const started = now();
  const read = await pageToolLists(tool, call, now, started, limits, stopWhen);
  const sizer = EMAIL_PROVIDERS[tool].sizeAudiences;
  if (!deps.size || !sizer || read.lists.length === 0) return read;
  const budget = { maxCalls: deps.size.maxCalls, deadline: Math.min(now() + deps.size.budgetMs, started + limits.routeTimeoutMs), now };
  return { ...read, lists: await sizer(call, read.lists, budget).catch(() => read.lists) };
}

async function pageToolLists(
  tool: EmailTool,
  call: ProviderCall,
  now: () => number,
  started: number,
  limits: ReadLimits,
  stopWhen?: (lists: Audience[]) => boolean,
): Promise<ToolRead> {
  const label = EMAIL_TOOL_LABEL[tool];
  const lists: Audience[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < limits.maxPages; page++) {
    if (now() - started > limits.routeTimeoutMs) {
      return lists.length > 0
        ? { status: "partial", lists, error: `${label} has more lists than Zavi could read in time.` }
        : { status: "unreadable", lists, error: `${label} did not answer in time. Try again in a minute.` };
    }
    try {
      const r = await EMAIL_PROVIDERS[tool].listAudiencesPage(call, cursor);
      lists.push(...r.lists);
      if (stopWhen?.(lists)) return { status: "partial", lists, error: null };
      if (!r.next) return { status: "complete", lists, error: null };
      if (r.next === cursor) return { status: "partial", lists, error: `${label} kept answering the same page.` };
      cursor = r.next;
    } catch (e) {
      const error = isKeyRejected(e) ? keyRejectedText(label) : `${label} could not be read right now. Try again in a minute.`;
      return lists.length > 0 ? { status: "partial", lists, error } : { status: "unreadable", lists, error };
    }
  }
  return { status: "partial", lists, error: `${label} has more lists than Zavi reads here.` };
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type GmailSender = { status: "connected" | "not_connected" | "unreadable" };

export async function readGmailSender(
  tenantId: string,
  resolve: (tenantId: string, toolkit: string) => Promise<unknown> = resolveOwnedComposioAccount,
  timeoutMs: number = READ_LIMITS.callTimeoutMs,
): Promise<GmailSender> {
  const unreadable: GmailSender = { status: "unreadable" };
  return withTimeout(
    (async (): Promise<GmailSender> => {
      try {
        return { status: (await resolve(tenantId, "gmail")) ? "connected" : "not_connected" };
      } catch {
        return unreadable;
      }
    })(),
    timeoutMs,
    unreadable,
  );
}

export type ReadDeps = {
  caller: ToolCaller;
  marks: (tenantId: string) => Promise<ReadonlySet<string>>;
  zaviLists: (tenantId: string) => Promise<Array<{ id: string; name: string; people: number | null; needs_consent?: true; consented_version?: true }>>;
  sendgridNeedsPermissions?: (tenantId: string) => Promise<boolean>;
  now?: () => number;
  limits?: Partial<ReadLimits>;
  size?: SizeLimits;
};

export function zaviListsFor(canSeeDatabaseAddresses: boolean): ReadDeps["zaviLists"] {
  return async (tenantId) =>
    listSummariesFor(await listSummaries(tenantId), canSeeDatabaseAddresses).map((l) => ({ id: l.id, name: l.name, people: l.active?.sendable ?? null, ...(!l.active || l.needs_consent ? { needs_consent: true as const } : {}), ...(l.active && l.needs_consent ? { consented_version: true as const } : {}) }));
}

export const LIVE_READ_DEPS: ReadDeps = {
  caller: liveToolCaller,
  marks: readTestListKeys,
  zaviLists: zaviListsFor(true),
  sendgridNeedsPermissions: (tenantId) => sendgridKeyNeedsPermissions(tenantId),
};

const ORPHAN_NOTE = {
  removable: "Not found in the account connected now. Reconnecting the account this list was in could let a real email reach it again.",
  pending: "Zavi could not read every list here, so it may still be there. You can remove the mark once the read completes.",
  zavi: "This list was archived or removed.",
} as const;

export async function readTestLists(tenantId: string, depsIn: Partial<ReadDeps> = {}): Promise<TestListsView> {
  const deps = { ...LIVE_READ_DEPS, ...depsIn };
  const limits = { ...READ_LIMITS, ...(deps.limits ?? {}) };
  const marks = await deps.marks(tenantId);
  const row = (route: TestListRoute, a: { id: string; name: string; people: number | null; needs_consent?: true; consented_version?: true }): TestListRow => ({
    id: a.id,
    name: a.name,
    people: a.people,
    marked: marks.has(testListKey(route, a.id)),
    looks_like_test: looksLikeTest(a.name),
    ...(a.needs_consent ? { needs_consent: true as const } : {}),
    ...(a.consented_version ? { consented_version: true as const } : {}),
  });

  const toolRoutes = EMAIL_TOOLS.map(async (tool): Promise<RouteLists> => {
    const r = await withTimeout(
      (async (): Promise<ToolRead> => {
        const read = await readToolLists(tenantId, tool, { caller: deps.caller, now: deps.now, limits, size: deps.size ?? LIST_SIZE_LIMITS });
        if (tool !== "sendgrid" || read.status !== "not_connected" || !deps.sendgridNeedsPermissions) return read;
        const partialKey = await deps.sendgridNeedsPermissions(tenantId).catch(() => false);
        return partialKey ? { status: "needs_permissions", lists: [], error: SENDGRID_NEEDS_PERMISSIONS } : read;
      })(),
      limits.routeTimeoutMs + limits.callTimeoutMs,
      { status: "unreadable" as ReadStatus, lists: [], error: `${EMAIL_TOOL_LABEL[tool]} took too long to answer.` },
    );
    return { route: tool, label: ROUTE_LABEL[tool], status: r.status, error: r.error, lists: r.lists.map((a) => row(tool, { id: a.id, name: a.name, people: a.member_count })) };
  });
  const zaviUnreadable: RouteLists = { route: "zavi_list", label: ROUTE_LABEL.zavi_list, status: "unreadable", error: "Your Zavi lists could not be read right now. Try again in a minute.", lists: [] };
  const zavi = withTimeout(
    (async (): Promise<RouteLists> => {
      try {
        const lists = await deps.zaviLists(tenantId);
        return { route: "zavi_list", label: ROUTE_LABEL.zavi_list, status: "complete", error: null, lists: lists.map((l) => row("zavi_list", l)) };
      } catch {
        return zaviUnreadable;
      }
    })(),
    limits.routeTimeoutMs,
    zaviUnreadable,
  );
  const routes = await Promise.all([...toolRoutes, zavi]);

  const orphans: OrphanMark[] = [];
  for (const key of marks) {
    const at = key.indexOf(":");
    const route = key.slice(0, at) as TestListRoute;
    const listId = key.slice(at + 1);
    const r = routes.find((x) => x.route === route);
    if (!r || r.lists.some((l) => l.id === listId)) continue;
    const complete = r.status === "complete";
    orphans.push({
      route,
      list_id: listId,
      reason: complete ? "not_found" : "not_checked",
      can_unmark: complete,
      note: !complete ? ORPHAN_NOTE.pending : route === "zavi_list" ? ORPHAN_NOTE.zavi : ORPHAN_NOTE.removable,
    });
  }
  return { routes, orphans };
}

export type SetResult = { ok: true; changed: boolean; marked: boolean } | { ok: false; code: string; message: string };

export const SET_MESSAGES: Record<string, string> = {
  bad_list: "That list is not one Zavi knows.",
  not_authorized: "Only an owner or admin can change test lists.",
  list_not_found: "That list was not found in the account connected now.",
  could_not_check: "Zavi could not read every list here, so the mark stays for now. Try again in a minute.",
  not_connected: "That tool is not connected, so Zavi cannot check the list. Reconnect it first.",
  channel_missing: "Email campaigns is not set up for this workspace yet.",
};

export type WriteDeps = {
  caller: ToolCaller;
  zaviReadable: (tenantId: string) => Promise<void>;
  rpc: (tenantId: string, args: { p_actor_user_id: string; p_key: string; p_marked: boolean }) => Promise<Record<string, unknown>>;
  now?: () => number;
  limits?: Partial<ReadLimits>;
};

export const LIVE_WRITE_DEPS: WriteDeps = {
  caller: liveToolCaller,
  zaviReadable: async (tenantId) => {
    await listSummaries(tenantId);
  },
  rpc: async (tenantId, args) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "set_email_test_list", args);
    if (error) throw new Error("set_email_test_list failed");
    return (data ?? {}) as Record<string, unknown>;
  },
};

const refuse = (code: string): SetResult => ({ ok: false, code, message: SET_MESSAGES[code] ?? "That could not be changed." });

export async function setTestList(
  tenantId: string,
  actorUserId: string,
  route: TestListRoute,
  listId: string,
  marked: boolean,
  depsIn: Partial<WriteDeps> = {},
): Promise<SetResult> {
  const deps = { ...LIVE_WRITE_DEPS, ...depsIn };
  if (!(TEST_LIST_ROUTES as readonly string[]).includes(route) || !/^[A-Za-z0-9_-]{1,128}$/.test(listId)) return refuse("bad_list");
  if (route === "zavi_list") {
    listId = listId.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(listId)) return refuse("bad_list");
  }
  if (route !== "zavi_list") {
    const found = (lists: Audience[]) => lists.some((l) => l.id === listId);
    const r = await readToolLists(tenantId, route, { caller: deps.caller, now: deps.now, limits: deps.limits }, marked ? found : undefined);
    const present = found(r.lists);
    if (marked) {
      if (!present) return refuse(r.status === "not_connected" ? "not_connected" : r.status === "complete" ? "list_not_found" : "could_not_check");
    } else if (r.status !== "complete") {
      return refuse(r.status === "not_connected" ? "not_connected" : "could_not_check");
    }
  } else if (!marked) {
    try {
      await deps.zaviReadable(tenantId);
    } catch {
      return refuse("could_not_check");
    }
  }
  const out = await deps.rpc(tenantId, { p_actor_user_id: actorUserId, p_key: testListKey(route, listId), p_marked: marked });
  if (out.ok !== true) return refuse(typeof out.code === "string" ? out.code : "bad_list");
  return { ok: true, changed: out.changed === true, marked };
}
