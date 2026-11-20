
import { createHash } from "node:crypto";
import { z } from "zod";
import { asTenantId, staffCrossTenantClient, tenantClient, tenantRpc } from "@/services/tenant-client";
import { buildRequestFromObjective } from "@/services/agents/build-sessions";
import { cleanSiteName, siteShownName } from "@/services/sites/label";
import { resolveSiteName } from "@/services/sites/site-name";
import { validateCompanyName } from "@/services/provisioning/tenant-slug";

export const SITE_NAME_FIX_KEY = "site-name-fix";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SiteNameFixArgs = { site_id: string; name?: string };

export const siteNameFixSchema = z.object({
  site_id: z.string().trim().regex(UUID_RE, "site_id must be a site uuid").transform((s) => s.toLowerCase()),
  name: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().max(200, "name: 200 characters at most").optional(),
  ),
});

export type NameSite = {
  id: string;
  tenant_id: string;
  label: string;
  hostname: string;
  status: string;
  name: string | null;
  root_conductor_run_id: string | null;
};

export type NameRun = { objective: string | null; goal_graph: unknown };

export type SetNameOutcome = "updated" | "already_applied" | "stale_preview" | "not_found";

export type SiteNameFixDeps = {
  readSite: (site_id: string) => Promise<NameSite | null>;
  readRun: (tenant_id: string, run_id: string) => Promise<NameRun | null>;
  readWorkspaceName: (tenant_id: string) => Promise<string | null>;
  setName: (tenant_id: string, site_id: string, expected: string | null, name: string) => Promise<SetNameOutcome>;
};

export class SiteNameFixError extends Error {
  constructor(
    readonly code: "not_found" | "schema_missing" | "invalid_name" | "no_name" | "nothing_to_change" | "list_changed" | "confirm_mismatch",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const MISSING_CODES = new Set(["42703", "PGRST204", "PGRST202", "42883"]);
const SCHEMA_MISSING = () =>
  new SiteNameFixError("schema_missing", "Site names are not in this database yet (migrations 20261010170000 and 20261011130000). Deploy them first.", 409);

async function readSiteDefault(site_id: string): Promise<NameSite | null> {
  const sb = staffCrossTenantClient("admin script site-name-fix: staff repairs a customer's site display name");
  const { data, error } = await sb
    .from("sites")
    .select("id, tenant_id, label, hostname, status, name, root_conductor_run_id")
    .eq("id", site_id)
    .maybeSingle();
  if (error) {
    if (MISSING_CODES.has(String(error.code ?? ""))) throw SCHEMA_MISSING();
    throw new Error(`site-name-fix: site read failed: ${error.message}`);
  }
  return (data as NameSite | null) ?? null;
}

async function readRunDefault(tenant_id: string, run_id: string): Promise<NameRun | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("objective, goal_graph")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`site-name-fix: build read failed: ${error.message}`);
  return (data as NameRun | null) ?? null;
}

async function readWorkspaceNameDefault(tenant_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenants").select("display_name").maybeSingle();
  if (error) throw new Error(`site-name-fix: workspace read failed: ${error.message}`);
  const name = (data as { display_name?: unknown } | null)?.display_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

async function setNameDefault(tenant_id: string, site_id: string, expected: string | null, name: string): Promise<SetNameOutcome> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_set_name", {
    p_site_id: site_id,
    p_expected_name: expected,
    p_name: name,
  });
  if (error) {
    if (MISSING_CODES.has(String(error.code ?? ""))) throw SCHEMA_MISSING();
    throw new Error(`site-name-fix: site_set_name failed${error.code ? ` (${error.code})` : ""}`);
  }
  const outcome = (data as { outcome?: unknown } | null)?.outcome;
  if (outcome === "updated" || outcome === "already_applied" || outcome === "stale_preview" || outcome === "not_found") return outcome;
  throw new Error("site-name-fix: site_set_name returned no outcome");
}

export const DEFAULT_SITE_NAME_FIX_DEPS: SiteNameFixDeps = {
  readSite: readSiteDefault,
  readRun: readRunDefault,
  readWorkspaceName: readWorkspaceNameDefault,
  setName: setNameDefault,
};

type GraphNode = { payload?: Record<string, unknown> | null };
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

export function buildInputs(run: NameRun | null): { idea: string; company_name: string } {
  const nodes: GraphNode[] = Array.isArray(run?.goal_graph) ? (run!.goal_graph as GraphNode[]) : [];
  let idea: string | null = null;
  let company: string | null = null;
  for (const n of nodes) {
    const p = n?.payload ?? null;
    if (!p || typeof p !== "object") continue;
    idea ??= str(p.idea);
    company ??= str(p.company_name);
  }
  const objective = run?.objective ?? null;
  if (!idea) idea = buildRequestFromObjective(objective);
  if (!company && objective) {
    const m = /^build product:\s*([^—]{1,120}?)\s*—/i.exec(objective.trim());
    company = m ? m[1].trim() : null;
  }
  return { idea: idea ?? "", company_name: company ?? "" };
}

export function overrideName(raw: string): string {
  const name = cleanSiteName(raw);
  const why = name ? validateCompanyName(name) : "empty";
  if (!name || why) throw new SiteNameFixError("invalid_name", `That name cannot be used (${why}).`, 400);
  return name;
}

export function nameFixToken(site: Pick<NameSite, "id" | "tenant_id" | "name">, after: string): string {
  return createHash("sha256")
    .update(JSON.stringify([site.tenant_id, site.id, site.name, after]))
    .digest("hex")
    .slice(0, 32);
}

export function nameFixConfirmPhrase(site_id: string): string {
  return `RENAME ${site_id}`;
}

export type NameFixPreview = {
  site_id: string;
  tenant_id: string;
  hostname: string;
  label: string;
  status: string;
  shown_now: string;
  stored_name: string | null;
  new_name: string;
  source: "typed" | "derived";
  changes: boolean;
  updates: string[];
  not_updated: string[];
  confirm_phrase: string;
  preview_token: string;
};

const UPDATES = [
  "Build header and Artifacts list (read live)",
  "The site-is-live email and its share card, from the next send",
];
const NOT_UPDATED = [
  "The address (label and hostname) never changes",
  "The KV host record carries no name: nothing to re-render",
  "The live site's own page title, share tags and favicon are in the site's source code (written at its first build); they change only when the site is edited and published again",
];

export async function previewNameFix(args: SiteNameFixArgs, deps: SiteNameFixDeps): Promise<NameFixPreview> {
  const site = await deps.readSite(args.site_id);
  if (!site) throw new SiteNameFixError("not_found", "No site with that id.", 404);
  let after: string | null;
  let source: NameFixPreview["source"];
  if (args.name !== undefined) {
    after = overrideName(args.name);
    source = "typed";
  } else {
    const [run, workspace_name] = await Promise.all([
      site.root_conductor_run_id ? deps.readRun(site.tenant_id, site.root_conductor_run_id) : Promise.resolve(null),
      deps.readWorkspaceName(site.tenant_id),
    ]);
    const { idea, company_name } = buildInputs(run);
    after = await resolveSiteName({ idea, company_name, workspace_name, site_name: null });
    source = "derived";
  }
  if (!after) throw new SiteNameFixError("no_name", "No usable name could be derived from this site's build. Type one in Name.", 409);
  return {
    site_id: site.id,
    tenant_id: site.tenant_id,
    hostname: site.hostname,
    label: site.label,
    status: site.status,
    shown_now: siteShownName(site),
    stored_name: site.name,
    new_name: after,
    source,
    changes: site.name !== after,
    updates: UPDATES,
    not_updated: NOT_UPDATED,
    confirm_phrase: nameFixConfirmPhrase(site.id),
    preview_token: nameFixToken(site, after),
  };
}

export async function prepareNameFix(
  args: SiteNameFixArgs,
  deps: SiteNameFixDeps,
  confirm: string | undefined,
  previewToken: string | undefined,
): Promise<NameFixPreview> {
  const preview = await previewNameFix(args, deps);
  if (!preview.changes) throw new SiteNameFixError("nothing_to_change", "The site already has this name.", 409);
  if (!previewToken || previewToken !== preview.preview_token) {
    throw new SiteNameFixError("list_changed", "The site's name or the name to set changed since the Dry Run. Run the Dry Run again.", 409);
  }
  if ((confirm ?? "").trim() !== preview.confirm_phrase) {
    throw new SiteNameFixError("confirm_mismatch", `Type "${preview.confirm_phrase}" to confirm.`, 409);
  }
  return preview;
}

export async function applyNameFix(preview: NameFixPreview, deps: SiteNameFixDeps): Promise<SetNameOutcome> {
  const outcome = await deps.setName(preview.tenant_id, preview.site_id, preview.stored_name, preview.new_name);
  if (outcome === "stale_preview") {
    throw new SiteNameFixError("list_changed", "The site's name changed since the Dry Run. Run the Dry Run again.", 409);
  }
  if (outcome === "not_found") throw new SiteNameFixError("not_found", "No site with that id.", 404);
  return outcome;
}
