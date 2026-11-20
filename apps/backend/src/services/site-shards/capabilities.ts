
export const DEDICATED_CAPABILITIES = [
  "payments",
  "payouts",
  "interval_overlap",
  "multi_step_workflow",
  "webhooks",
  "secrets",
  "jobs",
  "arbitrary_joins",
  "server_compute",
  "raw_sql",
] as const;
export type DedicatedCapability = (typeof DEDICATED_CAPABILITIES)[number];

const KNOWN: ReadonlySet<string> = new Set(DEDICATED_CAPABILITIES);

export const isDedicatedCapability = (v: unknown): v is DedicatedCapability => typeof v === "string" && KNOWN.has(v);

export function isSqlPath(path: string): boolean {
  const n = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return n === "supabase" || n.startsWith("supabase/") || n.endsWith(".sql");
}

export const ROUTING_CAPABILITIES = DEDICATED_CAPABILITIES.filter((c) => c !== "raw_sql") as Exclude<DedicatedCapability, "raw_sql">[];
export type RoutingCapability = (typeof ROUTING_CAPABILITIES)[number];

export const SITE_FUNCTIONS_SERVE_CAPABILITIES = false;
export const FUNCTION_SERVED_CAPABILITIES = ["payments", "webhooks", "jobs", "secrets", "server_compute"] as const satisfies readonly RoutingCapability[];
const FUNCTION_SERVED: ReadonlySet<string> = new Set(FUNCTION_SERVED_CAPABILITIES);

export function servedByFunctions(cap: DedicatedCapability, on: boolean = SITE_FUNCTIONS_SERVE_CAPABILITIES): boolean {
  return on && FUNCTION_SERVED.has(cap);
}

export type CapabilityService = "kernel" | "legacy_dedicated_project" | "site_functions" | "refused";
const fnOr = (c: DedicatedCapability): CapabilityService => (servedByFunctions(c) ? "site_functions" : "legacy_dedicated_project");
export const CAPABILITY_SERVICE: Readonly<Record<DedicatedCapability, CapabilityService>> = {
  payments: fnOr("payments"),
  payouts: "legacy_dedicated_project",
  interval_overlap: "legacy_dedicated_project",
  multi_step_workflow: "legacy_dedicated_project",
  webhooks: fnOr("webhooks"),
  secrets: fnOr("secrets"),
  jobs: fnOr("jobs"),
  arbitrary_joins: "legacy_dedicated_project",
  server_compute: fnOr("server_compute"),
  raw_sql: "refused",
};

export type CapabilityDetection = {
  capabilities: RoutingCapability[];
  functionServed: RoutingCapability[];
  rawSql: boolean;
  declaredRawSql: boolean;
  sqlPaths: string[];
  unknown: string[];
};

export function detectDedicatedCapabilities(input: { manifestRaw: unknown; paths?: readonly string[]; functionsServe?: boolean }): CapabilityDetection {
  const on = input.functionsServe ?? SITE_FUNCTIONS_SERVE_CAPABILITIES;
  const found = new Set<DedicatedCapability>();
  const unknown: string[] = [];
  const raw = input.manifestRaw;
  const declared = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { capabilities?: unknown }).capabilities : undefined;
  if (Array.isArray(declared)) {
    for (const c of declared) {
      if (isDedicatedCapability(c)) found.add(c);
      else if (typeof c === "string" && c.trim()) unknown.push(c.slice(0, 64));
    }
  }
  const sqlPaths = (input.paths ?? []).filter(isSqlPath);
  return {
    capabilities: ROUTING_CAPABILITIES.filter((c) => found.has(c) && !servedByFunctions(c, on)),
    functionServed: ROUTING_CAPABILITIES.filter((c) => found.has(c) && servedByFunctions(c, on)),
    rawSql: found.has("raw_sql") || sqlPaths.length > 0,
    declaredRawSql: found.has("raw_sql"),
    sqlPaths: sqlPaths.slice(0, 5),
    unknown: [...new Set(unknown)].slice(0, 16),
  };
}

export const RAW_SQL_REFUSAL_CODE = "raw_sql_refused";
export function rawSqlRefusal(sqlPaths: readonly string[], manifestPath = "zavi-site.json"): { reason: string; signal: string } {
  const where = sqlPaths.length ? `: ${sqlPaths.slice(0, 5).join(", ").slice(0, 300)}` : ` ("raw_sql" in ${manifestPath} capabilities)`;
  const reason =
    `This site keeps its data in Zavi's database, which never runs SQL from a site, so SQL files, supabase/ and the ` +
    `"raw_sql" capability are not allowed (nothing was run)${where}.`;
  return {
    reason,
    signal:
      `${reason}\nDelete those files (including supabase/) and any "raw_sql" capability, declare the data the site stores as ` +
      `collections in ${manifestPath} (each with its rules and schema), and read and write it with the Zavi data SDK ` +
      `(src/zavi: the client and React hooks). Never write SQL for this site.`,
  };
}

export const CAPABILITY_NOT_SUPPORTED_CODE = "capability_not_supported";
export function capabilityNotSupported(caps: readonly DedicatedCapability[]): string {
  const one = caps.length === 1;
  return (
    `This site needs ${describeCapabilities(caps)}, which Zavi's database does not support yet, so it was not published. ` +
    `Remove ${one ? "that capability" : "those capabilities"} from zavi-site.json to publish the site without ${one ? "it" : "them"}.`
  );
}

const LABEL: Record<DedicatedCapability, string> = {
  payments: "taking payments",
  payouts: "paying people out",
  interval_overlap: "time-range overlap rules",
  multi_step_workflow: "multi-step workflows",
  webhooks: "webhooks",
  secrets: "server-side secrets",
  jobs: "background jobs",
  arbitrary_joins: "custom queries across collections",
  server_compute: "server-side code",
  raw_sql: "its own SQL",
};

export function describeCapabilities(caps: readonly DedicatedCapability[]): string {
  const l = caps.map((c) => LABEL[c]);
  if (l.length <= 1) return l.join("");
  return `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}
