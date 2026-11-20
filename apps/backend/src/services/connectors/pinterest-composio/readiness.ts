import { composioExecuteTool, type ComposioExecResult, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { IMAGE_PATH_RE } from "@/services/connectors/social-channels";
import { asTenantId, tenantStorage } from "@/services/tenant-client";

export const PINTEREST_MEDIA_BUCKET = "agent-chat-images";
export const PINTEREST_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const PINTEREST_BOARD_PAGE_CAP = 10;
const BOARD_PAGE_SIZE = 250;
const LINK_MAX_BYTES = 1024 * 1024;
const LINK_WALL_MS = 15_000;
export const COMPOSIO_CALL_MS = 30_000;
export const BOARD_LIST_BUDGET_MS = 45_000;
export const PUBLISH_RECHECK_MS = 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SHARED_HOSTS = [
  "myshopify.com",
  "vercel.app",
  "netlify.app",
  "github.io",
  "pages.dev",
  "herokuapp.com",
  "wixsite.com",
  "squarespace.com",
  "webflow.io",
  "framer.website",
  "carrd.co",
  "bigcartel.com",
  "square.site",
  "onrender.com",
];

export type PinterestCheckName = "board" | "media" | "link" | "identity";
export type PinterestCheckStatus = "pass" | "fail" | "unverified" | "skipped";

export type PinterestReadinessCode =
  | "pinterest_not_connected"
  | "pinterest_lookup_failed"
  | "pinterest_no_boards"
  | "pinterest_board_missing"
  | "pinterest_board_secret"
  | "pinterest_media_invalid"
  | "pinterest_link_unreachable"
  | "pinterest_link_unchecked"
  | "pinterest_link_nopin"
  | "pinterest_link_partial"
  | "pinterest_identity_mismatch"
  | "pinterest_identity_unverified"
  | "pinterest_identity_related";

export type PinterestCheck = { status: PinterestCheckStatus; reason_code?: PinterestReadinessCode; reason?: string };

export type PinterestReadiness = {
  ok: boolean;
  checked_at: string;
  checks: Record<PinterestCheckName, PinterestCheck>;
  board: { id: string; name: string; privacy: string | null } | null;
  board_count: number;
  reason_code?: PinterestReadinessCode;
  reason?: string;
};

export const PINTEREST_READINESS_CODES: readonly PinterestReadinessCode[] = [
  "pinterest_not_connected",
  "pinterest_lookup_failed",
  "pinterest_no_boards",
  "pinterest_board_missing",
  "pinterest_board_secret",
  "pinterest_media_invalid",
  "pinterest_link_unreachable",
  "pinterest_link_unchecked",
  "pinterest_link_nopin",
  "pinterest_link_partial",
  "pinterest_identity_mismatch",
  "pinterest_identity_unverified",
  "pinterest_identity_related",
];

export const PINTEREST_READINESS_TEXT: Record<PinterestReadinessCode, string> = {
  pinterest_not_connected:
    "Pinterest is not connected for this workspace, so Zavi cannot publish a pin. Connect Pinterest from the Pinterest channel, then try again.",
  pinterest_lookup_failed:
    "Zavi could not reach your Pinterest account just now to check your boards. Try again in a few minutes.",
  pinterest_no_boards:
    "Your Pinterest account has no boards yet, and every pin has to go on a board. Create a board on Pinterest, then try again.",
  pinterest_board_missing:
    "That board is not on your connected Pinterest account any more. Pick one of your current boards and try again.",
  pinterest_board_secret:
    "That board is secret, so nobody but you would see the pin. Pick a public board, or make this one public on Pinterest.",
  pinterest_media_invalid:
    "The pin image is missing or not one Pinterest accepts. Use a PNG, JPEG or WebP image under 20 MB and try again.",
  pinterest_link_unreachable:
    "The page this pin links to did not open. Check the link works in a browser, then try again.",
  pinterest_link_unchecked:
    "Zavi could not open the page this pin links to, and some sites turn away automated visits. Open the link in a browser before you approve.",
  pinterest_link_nopin:
    "The page this pin links to tells Pinterest not to allow pins from it. Remove the nopin tag from that page or link a different page.",
  pinterest_link_partial:
    "The page this pin links to only partly loaded, so Zavi could not check that it allows pins.",
  pinterest_identity_mismatch:
    "The pin links to a site that is not your company's website. Link a page on your own site.",
  pinterest_identity_unverified:
    "Your company website is not on file, so Zavi could not confirm the link goes to your own site.",
  pinterest_identity_related:
    "The link is on a different address under the same domain as your website, so Zavi could not confirm it is your own site.",
};

export type PinterestBoardSummary = { id: string; name: string; privacy: string | null; description?: string | null; pin_count?: number | null };

export type PinterestReadinessDeps = {
  resolveAccount: (tenantId: string) => Promise<OwnedComposioAccount | null>;
  execute: (a: { tool_slug: string; user_id: string; connected_account_id: string; arguments: Record<string, unknown> }, signal?: AbortSignal) => Promise<ComposioExecResult>;
  storageInfo: (tenantId: string, path: string) => Promise<{ contentType: string | null; size: number | null } | null>;
  fetchText: (
    url: string,
    rootHost: string,
    deadline: number,
    maxBytes: number,
    redirectAllowed?: (host: string) => boolean,
    onStatus?: (status: number) => void,
  ) => Promise<string | null>;
  tenantSite: (tenantId: string) => Promise<string | null>;
  now: () => number;
};

const defaultDeps: PinterestReadinessDeps = {
  resolveAccount: (tenantId) => resolveOwnedComposioAccount(tenantId, "pinterest"),
  execute: composioExecuteTool,
  storageInfo: async (tenantId, path) => {
    const { data, error } = await tenantStorage(asTenantId(tenantId)).from(PINTEREST_MEDIA_BUCKET).info(path);
    if (error || !data) return null;
    const d = data as { contentType?: string; size?: number; metadata?: Record<string, unknown> };
    const meta = d.metadata ?? {};
    const contentType = d.contentType ?? (typeof meta.mimetype === "string" ? meta.mimetype : null);
    const size = typeof d.size === "number" ? d.size : typeof meta.size === "number" ? meta.size : null;
    return { contentType, size };
  },
  fetchText: async (url, rootHost, deadline, maxBytes, redirectAllowed, onStatus) => {
    const [{ safeFetchText }, { guardedFetch }] = await Promise.all([
      import("@/services/onboarding/enrichment/discover"),
      import("@/services/start-card/seed/notice-store"),
    ]);
    const fetchImpl: typeof fetch = onStatus
      ? (async (input: string, init?: RequestInit) => {
          const res = await guardedFetch(input, init);
          onStatus(res.status);
          return res;
        }) as typeof fetch
      : guardedFetch;
    return safeFetchText(url, rootHost, deadline, maxBytes, redirectAllowed, fetchImpl);
  },
  tenantSite: async (tenantId) => (await import("@/services/tools/growth/seo/run")).resolveTenantSite(tenantId),
  now: () => Date.now(),
};

const TIMED_OUT: ComposioExecResult = { ok: false, status: 0, data: null, error: "composio_timeout", outcome_unknown: true };

function settleWithin<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, onTimeout: T): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(onTimeout);
    }, Math.max(0, ms));
  });
  return Promise.race([work(ctrl.signal), late]).finally(() => clearTimeout(timer));
}

function executeWithin(
  deps: PinterestReadinessDeps,
  a: Parameters<PinterestReadinessDeps["execute"]>[0],
  ms: number = COMPOSIO_CALL_MS,
): Promise<ComposioExecResult> {
  return settleWithin((signal) => deps.execute(a, signal), Math.min(ms, COMPOSIO_CALL_MS), TIMED_OUT);
}

function dataOf(r: ComposioExecResult): Record<string, unknown> {
  let d: unknown = r.data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      d = null;
    }
  }
  if (!d || typeof d !== "object") return {};
  const rec = d as Record<string, unknown>;
  if (Array.isArray(rec.items)) return rec;
  for (const inner of [rec.data, rec.response_data]) {
    if (inner && typeof inner === "object" && Array.isArray((inner as Record<string, unknown>).items)) {
      return inner as Record<string, unknown>;
    }
  }
  return rec;
}

function failed(code: PinterestReadinessCode): PinterestCheck {
  return { status: "fail", reason_code: code, reason: PINTEREST_READINESS_TEXT[code] };
}

function unverified(code: PinterestReadinessCode): PinterestCheck {
  return { status: "unverified", reason_code: code, reason: PINTEREST_READINESS_TEXT[code] };
}

const PASS: PinterestCheck = { status: "pass" };
const SKIPPED: PinterestCheck = { status: "skipped" };

function isSecret(privacy: string | null): boolean {
  return (privacy ?? "").toUpperCase() === "SECRET";
}

export type BoardList = { ok: true; boards: PinterestBoardSummary[]; complete: boolean } | { ok: false; code: PinterestReadinessCode };

async function boardById(tenantId: string, deps: PinterestReadinessDeps, account: OwnedComposioAccount, boardId: string, ms: number): Promise<PinterestBoardSummary | null> {
  let r: ComposioExecResult;
  try {
    r = await executeWithin(
      deps,
      {
        tool_slug: "PINTEREST_GET_BOARD",
        user_id: tenantId,
        connected_account_id: account.connected_account_id,
        arguments: { board_id: boardId },
      },
      ms,
    );
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const d = dataOf(r);
  const x = [d.response_data, d.data, d].find(
    (v): v is Record<string, unknown> => !!v && typeof v === "object" && String((v as Record<string, unknown>).id ?? "") === boardId,
  );
  if (!x) return null;
  return { id: boardId, name: String(x.name ?? "") || boardId, privacy: typeof x.privacy === "string" ? x.privacy : null };
}

async function listBoards(tenantId: string, deps: PinterestReadinessDeps, stopAt?: string, budgetMs: number = BOARD_LIST_BUDGET_MS): Promise<BoardList> {
  const deadline = deps.now() + budgetMs;
  const left = () => deadline - deps.now();
  const partial = (boards: PinterestBoardSummary[]): BoardList =>
    boards.length > 0 ? { ok: true, boards, complete: false } : { ok: false, code: "pinterest_lookup_failed" };
  let account: OwnedComposioAccount | null | "timeout";
  try {
    account = await settleWithin<OwnedComposioAccount | null | "timeout">(() => deps.resolveAccount(tenantId), Math.min(left(), COMPOSIO_CALL_MS), "timeout");
  } catch {
    return { ok: false, code: "pinterest_lookup_failed" };
  }
  if (account === "timeout") return { ok: false, code: "pinterest_lookup_failed" };
  if (!account) return { ok: false, code: "pinterest_not_connected" };
  const owned = account;
  const incomplete = async (found: PinterestBoardSummary[], timedOut = false): Promise<BoardList> => {
    if (stopAt && left() > 0 && !found.some((b) => b.id === stopAt)) {
      const direct = await boardById(tenantId, deps, owned, stopAt, Math.max(0, left()));
      if (direct) return { ok: true, boards: [...found, direct], complete: false };
    }
    return timedOut ? partial(found) : { ok: true, boards: found, complete: false };
  };
  const boards: PinterestBoardSummary[] = [];
  let bookmark: string | null = null;
  for (let page = 0; page < PINTEREST_BOARD_PAGE_CAP; page++) {
    if (left() <= 0) return incomplete(boards, true);
    let r: ComposioExecResult;
    try {
      r = await executeWithin(
        deps,
        {
          tool_slug: "PINTEREST_LIST_BOARDS",
          user_id: tenantId,
          connected_account_id: account.connected_account_id,
          arguments: { page_size: BOARD_PAGE_SIZE, ...(bookmark ? { bookmark } : {}) },
        },
        left(),
      );
    } catch {
      return { ok: false, code: "pinterest_lookup_failed" };
    }
    if (r === TIMED_OUT) return incomplete(boards, true);
    if (!r.ok) return { ok: false, code: "pinterest_lookup_failed" };
    const d = dataOf(r);
    if (!Array.isArray(d.items)) return { ok: false, code: "pinterest_lookup_failed" };
    for (const x of d.items as Array<Record<string, unknown>>) {
      const id = x.id === undefined || x.id === null ? "" : String(x.id);
      if (!id) continue;
      boards.push({
        id,
        name: String(x.name ?? "") || id,
        privacy: typeof x.privacy === "string" ? x.privacy : null,
        description: typeof x.description === "string" && x.description ? x.description : null,
        pin_count: typeof x.pin_count === "number" && Number.isFinite(x.pin_count) ? x.pin_count : null,
      });
    }
    const next = typeof d.bookmark === "string" && d.bookmark ? d.bookmark : null;
    if (!next) return { ok: true, boards, complete: true };
    if (stopAt && boards.some((b) => b.id === stopAt)) return { ok: true, boards, complete: false };
    if (next === bookmark) return incomplete(boards);
    bookmark = next;
  }
  return incomplete(boards);
}

export async function listPinterestBoards(
  tenantId: string,
  deps: PinterestReadinessDeps = defaultDeps,
  budgetMs: number = BOARD_LIST_BUDGET_MS,
): Promise<BoardList> {
  return listBoards(tenantId, deps, undefined, budgetMs);
}

export const BOARD_NAME_MAX = 50;
export const BOARD_DESCRIPTION_MAX = 500;
const BOARD_SEARCH_PAGE = 25;

export type CreateBoardResult =
  | { ok: true; board: PinterestBoardSummary }
  | { ok: false; code: "not_connected" | "name_taken" | "refused" | "unconfirmed"; message: string };

const NAME_TAKEN = /already (?:have|has|exists?)|duplicate|name (?:is )?(?:already )?(?:taken|in use)/i;

function vendorText(r: ComposioExecResult): string {
  const parts = [r.error, r.data].map((v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)));
  return parts.join(" ");
}

export async function createPinterestBoard(
  tenantId: string,
  board: { name: string; description?: string },
  deps: PinterestReadinessDeps = defaultDeps,
): Promise<CreateBoardResult> {
  let account: OwnedComposioAccount | null;
  try {
    account = await deps.resolveAccount(tenantId);
  } catch {
    return { ok: false, code: "unconfirmed", message: "Zavi could not reach your Pinterest account just now. Try again in a few minutes." };
  }
  if (!account) {
    return { ok: false, code: "not_connected", message: "Pinterest is not connected for this workspace. Connect Pinterest, then make the board." };
  }
  const name = board.name.trim().slice(0, BOARD_NAME_MAX);
  const description = board.description?.trim().slice(0, BOARD_DESCRIPTION_MAX);
  let r: ComposioExecResult;
  try {
    r = await executeWithin(deps, {
      tool_slug: "PINTEREST_CREATE_BOARD",
      user_id: tenantId,
      connected_account_id: account.connected_account_id,
      arguments: { name, privacy: "PUBLIC", ...(description ? { description } : {}) },
    });
  } catch {
    r = TIMED_OUT;
  }
  const unconfirmed: CreateBoardResult = {
    ok: false,
    code: "unconfirmed",
    message: "Pinterest did not confirm the board. Reload your boards before trying again, so you do not make it twice.",
  };
  if (!r.ok) {
    if (r.outcome_unknown) return unconfirmed;
    if (r.status === 409 || NAME_TAKEN.test(vendorText(r))) {
      return { ok: false, code: "name_taken", message: "You already have a board with that name. Pick it from the list, or use a different name." };
    }
    const said = typeof r.error === "string" && r.error.trim() && r.error.length <= 200 ? ` Pinterest said: ${r.error.trim()}` : "";
    return { ok: false, code: "refused", message: `Pinterest refused to make this board.${said}` };
  }
  const d = dataOf(r);
  const x = [d.response_data, d.data, d].find(
    (v): v is Record<string, unknown> => !!v && typeof v === "object" && (typeof (v as Record<string, unknown>).id === "string" || typeof (v as Record<string, unknown>).id === "number"),
  );
  if (!x) return unconfirmed;
  const id = String(x.id);
  return { ok: true, board: { id, name: String(x.name ?? "") || name, privacy: typeof x.privacy === "string" ? x.privacy : "PUBLIC" } };
}

export async function searchPinterestBoards(
  tenantId: string,
  query: string,
  deps: PinterestReadinessDeps = defaultDeps,
): Promise<BoardList> {
  let account: OwnedComposioAccount | null;
  try {
    account = await deps.resolveAccount(tenantId);
  } catch {
    return { ok: false, code: "pinterest_lookup_failed" };
  }
  if (!account) return { ok: false, code: "pinterest_not_connected" };
  let r: ComposioExecResult;
  try {
    r = await executeWithin(deps, {
      tool_slug: "PINTEREST_SEARCH_OWN_CONTENT",
      user_id: tenantId,
      connected_account_id: account.connected_account_id,
      arguments: { resource_type: "boards", query: query.trim(), page_size: BOARD_SEARCH_PAGE },
    });
  } catch {
    return { ok: false, code: "pinterest_lookup_failed" };
  }
  if (!r.ok) return { ok: false, code: "pinterest_lookup_failed" };
  const d = dataOf(r);
  if (!Array.isArray(d.items)) return { ok: false, code: "pinterest_lookup_failed" };
  const boards: PinterestBoardSummary[] = [];
  for (const x of d.items as Array<Record<string, unknown>>) {
    const id = x.id === undefined || x.id === null ? "" : String(x.id);
    if (!id) continue;
    boards.push({ id, name: String(x.name ?? "") || id, privacy: typeof x.privacy === "string" ? x.privacy : null });
  }
  return { ok: true, boards, complete: typeof d.bookmark !== "string" || !d.bookmark };
}

export const PREFILL_TIMEOUT_MS = 3000;

export async function connectedPinterestUsername(
  tenantId: string,
  deps: PinterestReadinessDeps = defaultDeps,
  timeoutMs: number = PREFILL_TIMEOUT_MS,
): Promise<string | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      console.warn("[pinterest-prefill] profile read timed out");
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([readPinterestUsername(tenantId, deps, ctrl.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function readPinterestUsername(tenantId: string, deps: PinterestReadinessDeps, signal: AbortSignal): Promise<string | null> {
  try {
    const account = await deps.resolveAccount(tenantId);
    if (!account || signal.aborted) return null;
    const r = await deps.execute(
      {
        tool_slug: "PINTEREST_GET_PROFILE",
        user_id: tenantId,
        connected_account_id: account.connected_account_id,
        arguments: {},
      },
      signal,
    );
    if (!r.ok) {
      if (!signal.aborted) console.warn(`[pinterest-prefill] profile read refused: ${r.status}`);
      return null;
    }
    const data = dataOf(r);
    const wrapped = data.response_data ?? data.data;
    const profile = wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
      ? wrapped as Record<string, unknown>
      : data;
    const username = profile.username;
    return typeof username === "string" && username.trim() ? username.trim() : null;
  } catch (e) {
    console.warn(`[pinterest-prefill] profile read failed: ${(e as Error).message}`);
    return null;
  }
}

function boardCheck(list: BoardList, boardId: string | undefined): { check: PinterestCheck; board: PinterestBoardSummary | null; count: number } {
  if (!list.ok) {
    const check = list.code === "pinterest_lookup_failed" ? unverified(list.code) : failed(list.code);
    return { check, board: null, count: 0 };
  }
  const count = list.boards.length;
  if (boardId) {
    const board = list.boards.find((b) => b.id === boardId) ?? null;
    if (!board) {
      if (count === 0 && list.complete) return { check: failed("pinterest_no_boards"), board: null, count };
      return { check: list.complete ? failed("pinterest_board_missing") : unverified("pinterest_lookup_failed"), board: null, count };
    }
    if (isSecret(board.privacy)) return { check: failed("pinterest_board_secret"), board, count };
    return { check: PASS, board, count };
  }
  if (count === 0) {
    return { check: list.complete ? failed("pinterest_no_boards") : unverified("pinterest_lookup_failed"), board: null, count };
  }
  if (list.boards.every((b) => isSecret(b.privacy))) {
    return { check: list.complete ? failed("pinterest_board_secret") : unverified("pinterest_lookup_failed"), board: null, count };
  }
  return { check: PASS, board: null, count };
}

async function mediaCheck(tenantId: string, path: string, deps: PinterestReadinessDeps): Promise<PinterestCheck> {
  if (!path.startsWith(`${tenantId}/`) || !IMAGE_PATH_RE.test(path)) return failed("pinterest_media_invalid");
  let info: { contentType: string | null; size: number | null } | null;
  try {
    info = await deps.storageInfo(tenantId, path);
  } catch {
    return failed("pinterest_media_invalid");
  }
  if (!info) return failed("pinterest_media_invalid");
  const type = (info.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) return failed("pinterest_media_invalid");
  if (typeof info.size !== "number" || info.size <= 0 || info.size > PINTEREST_MAX_IMAGE_BYTES) return failed("pinterest_media_invalid");
  return PASS;
}

function parseHttps(link: string): URL | null {
  try {
    const u = new URL(link);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function bareHost(h: string): string {
  return h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export function hasNopinMeta(html: string): boolean {
  const active = html
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<(script|style|template|noscript)\b[\s\S]*?(<\/\1\s*>|$)/gi, "");
  for (const tag of active.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/(?<![\w-])name\s*=\s*(["']?)pinterest\1(?=[\s/>])/i.test(tag)) continue;
    const content = tag.match(/(?<![\w-])content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (content && /nopin/i.test(content[2] ?? content[3] ?? content[4] ?? "")) return true;
  }
  return false;
}

const GONE_STATUSES = new Set([404, 410]);

async function linkCheck(link: string, deps: PinterestReadinessDeps): Promise<PinterestCheck> {
  const u = parseHttps(link);
  if (!u) return failed("pinterest_link_unreachable");
  const host = bareHost(u.hostname);
  const apex = onSharedHost(host) ? null : await registrableOf(host);
  const redirectAllowed = apex
    ? (h: string) => {
        const b = bareHost(h);
        return b === apex || b.endsWith(`.${apex}`);
      }
    : undefined;
  const last = { status: 0 };
  let html: string | null;
  try {
    html = await deps.fetchText(u.toString(), host, deps.now() + LINK_WALL_MS, LINK_MAX_BYTES, redirectAllowed, (s) => {
      last.status = s;
    });
  } catch {
    html = null;
  }
  if (html === null) return GONE_STATUSES.has(last.status) ? failed("pinterest_link_unreachable") : unverified("pinterest_link_unchecked");
  if (hasNopinMeta(html)) return failed("pinterest_link_nopin");
  return /<\/head\s*>|<body\b/i.test(html) ? PASS : unverified("pinterest_link_partial");
}

function onSharedHost(host: string): boolean {
  const zaviSites = (process.env.PRAXIS_PRODUCT_DOMAIN ?? "zaviagent.com").trim().toLowerCase();
  return [...SHARED_HOSTS, zaviSites].some((s) => host === s || host.endsWith(`.${s}`));
}

async function registrableOf(host: string): Promise<string | null> {
  try {
    return (await import("@/services/onboarding/enrichment/domain-match")).eTldPlusOne(host);
  } catch {
    return null;
  }
}

export type SiteRelation = "same" | "related" | "different";

export function siteRelation(linkHost: string, siteHost: string, registrable: (host: string) => string): SiteRelation {
  const a = bareHost(linkHost);
  const b = bareHost(siteHost);
  if (!a || !b) return "different";
  if (a === b) return "same";
  if (onSharedHost(a) || onSharedHost(b)) return "different";
  if (a.endsWith(`.${b}`)) return "same";
  return registrable(a) === registrable(b) ? "related" : "different";
}

export function sameSiteIdentity(linkHost: string, siteHost: string, registrable: (host: string) => string): boolean {
  return siteRelation(linkHost, siteHost, registrable) === "same";
}

async function identityCheck(tenantId: string, link: string, deps: PinterestReadinessDeps): Promise<PinterestCheck> {
  const u = parseHttps(link);
  if (!u) return failed("pinterest_identity_mismatch");
  let site: string | null;
  try {
    site = await deps.tenantSite(tenantId);
  } catch {
    site = null;
  }
  if (!site) return unverified("pinterest_identity_unverified");
  let siteHost: string;
  try {
    siteHost = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname;
  } catch {
    return unverified("pinterest_identity_unverified");
  }
  let registrable: (host: string) => string;
  try {
    registrable = (await import("@/services/onboarding/enrichment/domain-match")).eTldPlusOne;
  } catch {
    return unverified("pinterest_identity_unverified");
  }
  const relation = siteRelation(u.hostname, siteHost, registrable);
  if (relation === "same") return PASS;
  return relation === "related" ? unverified("pinterest_identity_related") : failed("pinterest_identity_mismatch");
}

const ORDER: PinterestCheckName[] = ["board", "media", "link", "identity"];

export async function resolvePinterestPublishReadiness(
  tenantId: string,
  pin?: { board_id?: string; image_path?: string; link?: string },
  opts?: { only?: readonly PinterestCheckName[]; deps?: Partial<PinterestReadinessDeps>; deadlineMs?: number },
): Promise<PinterestReadiness> {
  const deps: PinterestReadinessDeps = { ...defaultDeps, ...(opts?.deps ?? {}) };
  const wants = (n: PinterestCheckName) => !opts?.only || opts.only.includes(n);
  const checks: Record<PinterestCheckName, PinterestCheck> = { board: SKIPPED, media: SKIPPED, link: SKIPPED, identity: SKIPPED };
  let board: PinterestBoardSummary | null = null;
  let board_count = 0;
  try {
    const boardId = pin?.board_id ? String(pin.board_id) : undefined;
    const budget = opts?.deadlineMs ?? BOARD_LIST_BUDGET_MS;
    const capped = <T>(work: Promise<T>, onTimeout: T): Promise<T> =>
      opts?.deadlineMs === undefined ? work : settleWithin(() => work, budget, onTimeout);
    const boardTimeout = { check: unverified("pinterest_lookup_failed"), board: null, count: 0 };
    const [boardResult, media, link, identity] = await Promise.all([
      wants("board") ? capped(listBoards(tenantId, deps, boardId, budget).then((l) => boardCheck(l, boardId)), boardTimeout) : Promise.resolve(null),
      wants("media") && pin?.image_path ? capped(mediaCheck(tenantId, pin.image_path, deps), unverified("pinterest_lookup_failed")) : Promise.resolve(SKIPPED),
      wants("link") && pin?.link ? capped(linkCheck(pin.link, deps), unverified("pinterest_link_unchecked")) : Promise.resolve(SKIPPED),
      wants("identity") && pin?.link ? capped(identityCheck(tenantId, pin.link, deps), unverified("pinterest_identity_unverified")) : Promise.resolve(SKIPPED),
    ]);
    if (boardResult) {
      checks.board = boardResult.check;
      board = boardResult.board;
      board_count = boardResult.count;
    }
    checks.media = media;
    checks.link = link;
    checks.identity = identity;
  } catch {
    checks.board = unverified("pinterest_lookup_failed");
  }
  const firstFail =
    ORDER.map((n) => checks[n]).find((c) => c.status === "fail") ??
    (checks.board.status === "unverified" ? checks.board : undefined);
  return {
    ok: !firstFail,
    checked_at: new Date(deps.now()).toISOString(),
    checks,
    board,
    board_count,
    ...(firstFail ? { reason_code: firstFail.reason_code, reason: firstFail.reason } : {}),
  };
}
