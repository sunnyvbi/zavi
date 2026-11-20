import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";
import { tenantClient, type TenantId } from "@/services/tenant-client";

export const SITE_EDITS_APP_PREFIX = "site:";
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function siteEditsAppId(siteId: string): string {
  return `${SITE_EDITS_APP_PREFIX}${siteId.trim().toLowerCase()}`;
}

export function isSiteEditsAppId(appId: unknown): boolean {
  return typeof appId === "string" && appId.trim().toLowerCase().startsWith(SITE_EDITS_APP_PREFIX);
}

export function siteIdFromEditsApp(appId: unknown): string | null {
  if (typeof appId !== "string" || !appId.startsWith(SITE_EDITS_APP_PREFIX)) return null;
  const id = appId.slice(SITE_EDITS_APP_PREFIX.length);
  return SITE_ID_RE.test(id) ? id : null;
}

export type SiteEditRow = {
  id: string;
  selector: string;
  patch: Record<string, unknown> | null;
  removed: boolean;
  updated_at: string;
};

type Facets = {
  text?: unknown;
  segments?: unknown;
  style?: unknown;
  attrs?: unknown;
};

const STYLE_PROPERTY: Record<string, string> = {
  color: "text color",
  backgroundColor: "background color",
  fontSize: "font size",
  fontFamily: "font family",
  fontWeight: "font weight",
  fontStyle: "font style",
  textDecoration: "text decoration",
  textAlign: "text alignment",
};

const ATTR_LABEL: Record<string, string> = { href: "link target (href)", src: "image source (src)" };
const MAX_OLD_TEXT = 300;

function quote(value: string, max?: number): string {
  const t = max && value.length > max ? `${value.slice(0, max - 1)}…` : value;
  return JSON.stringify(t);
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function describeSiteEdit(row: Pick<SiteEditRow, "selector" | "patch" | "removed">): string | null {
  const patch = record(row.patch) as Facets & { before?: unknown };
  const before = record(patch.before) as Facets;
  const target = `\`${row.selector}\``;
  const oldText = str(before.text)?.trim();
  if (row.removed) {
    return oldText
      ? `${target} (currently reads ${quote(oldText, MAX_OLD_TEXT)}): remove this element from the page.`
      : `${target}: remove this element from the page.`;
  }
  const parts: string[] = [];
  const text = str(patch.text);
  if (text !== null) {
    parts.push(
      oldText
        ? `change its text from ${quote(oldText, MAX_OLD_TEXT)} to ${quote(text)}`
        : `change its text to ${quote(text)}`,
    );
  }
  if (Array.isArray(patch.segments)) {
    const oldRuns = Array.isArray(before.segments) ? before.segments : [];
    const runs: string[] = [];
    patch.segments.forEach((next, i) => {
      if (typeof next !== "string") return;
      const prior = str(oldRuns[i]);
      runs.push(
        prior !== null
          ? `text run ${i + 1} from ${quote(prior.trim(), MAX_OLD_TEXT)} to ${quote(next.trim())}`
          : `text run ${i + 1} to ${quote(next.trim())}`,
      );
    });
    if (runs.length > 0) parts.push(`change ${runs.join(", ")}`);
  }
  const style = record(patch.style);
  const oldStyle = record(before.style);
  for (const [key, value] of Object.entries(style)) {
    if (typeof value !== "string") continue;
    const label = STYLE_PROPERTY[key] ?? key;
    const prior = str(oldStyle[key]);
    parts.push(prior ? `set its ${label} to ${value} (was ${prior})` : `set its ${label} to ${value}`);
  }
  const attrs = record(patch.attrs);
  const oldAttrs = record(before.attrs);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== "string") continue;
    const label = ATTR_LABEL[key] ?? key;
    const prior = str(oldAttrs[key]);
    parts.push(prior ? `change its ${label} from ${quote(prior)} to ${quote(value)}` : `set its ${label} to ${quote(value)}`);
  }
  if (parts.length === 0) return null;
  return `${target}: ${parts.join("; ")}.`;
}

export const SITE_EDITS_MESSAGE_LIMIT = 4000;
const SITE_EDITS_HEADER =
  "Apply these exact edits the founder made with the visual editor in the site preview. Change only the elements listed, only in the way described, and keep everything else as it is. Each element is named by its CSS selector in the rendered page; find the source code that renders it and make the change there so it is permanent.";

export function cleanRefineText(text: string): string {
  return sanitizeFetchedContent(text);
}

export function siteEditsRefineMessage(
  rows: ReadonlyArray<SiteEditRow>,
  limit: number = SITE_EDITS_MESSAGE_LIMIT,
): { message: string; included: SiteEditRow[] } {
  const header = cleanRefineText(SITE_EDITS_HEADER);
  const lines: string[] = [];
  const included: SiteEditRow[] = [];
  let length = header.length;
  for (const row of rows) {
    const described = describeSiteEdit(row);
    if (!described) continue;
    const line = cleanRefineText(`${lines.length + 1}. ${described}`);
    if (length + 1 + line.length > limit) continue;
    lines.push(line);
    included.push(row);
    length += 1 + line.length;
  }
  if (included.length === 0) return { message: "", included };
  return { message: [header, ...lines].join("\n"), included };
}

export async function loadSiteEditRows(tid: TenantId, appId: string): Promise<SiteEditRow[] | { error: string }> {
  const { data, error } = await tenantClient(tid)
    .from("website_edits")
    .select("id, selector, patch, removed, updated_at")
    .eq("app_id", appId)
    .order("updated_at", { ascending: true });
  if (error) return { error: error.message };
  return (data ?? []) as SiteEditRow[];
}

export async function clearAppliedSiteEdits(
  tid: TenantId,
  appId: string,
  rows: ReadonlyArray<Pick<SiteEditRow, "id" | "updated_at">>,
): Promise<{ cleared: number; error?: string }> {
  const tc = tenantClient(tid);
  const results = await Promise.all(
    rows.map((r) =>
      tc.from("website_edits").delete().eq("app_id", appId).eq("id", r.id).eq("updated_at", r.updated_at).select("id"),
    ),
  );
  const failed = results.find((r) => r.error);
  const cleared = results.reduce((n, r) => n + (Array.isArray(r.data) ? r.data.length : 0), 0);
  return failed?.error ? { cleared, error: failed.error.message } : { cleared };
}
