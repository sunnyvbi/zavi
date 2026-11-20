
export const FUNCTION_HTTP_PREFIX = "/api/fn/";
export const FUNCTION_WEBHOOK_PREFIX = "/api/hooks/";
export const FUNCTIONS_DIR = "functions";

export const FUNCTION_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const RESERVED_SECRET_PREFIX = "ZAVI_";

export const FUNCTION_LIMITS = {
  endpoints: 16,
  schedules: 8,
  secrets: 16,
  allowedHosts: 8,
  minScheduleMinutes: 5,
} as const;

export const ENDPOINT_TYPES = ["http", "webhook"] as const;
export type EndpointType = (typeof ENDPOINT_TYPES)[number];

export type EndpointDef =
  | { type: "http"; principals: string[]; asAdmin?: true }
  | { type: "webhook"; asAdmin?: true };
export type ScheduleDef = { cron: string; asAdmin?: true };
export type FunctionsDef = {
  endpoints: Record<string, EndpointDef>;
  schedules: Record<string, ScheduleDef>;
  secrets: string[];
  allowedHosts: string[];
};

export type FunctionIssue = { path: string; code: string; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ROLE_PRINCIPAL = /^role:[a-z][a-z0-9_]{0,31}$/;
const PRINCIPAL_ORDER = ["anyone", "signed_in", "admin"];
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const CRON_FIELDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 6 },
];

const PRIVATE_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa", ".test", ".example", ".invalid", ".onion", ".alt", ".example.com", ".example.net", ".example.org"];

function cronValues(field: string, min: number, max: number): number[] | string {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `"${part}" is not a number, range, list or */step`;
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
    }
    if (!Number.isInteger(step) || step < 1) return `step in "${part}" must be 1 or more`;
    if (lo < min || hi > max || lo > hi) return `"${part}" is outside ${min}-${max}`;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function cronIssue(cron: unknown): string | null {
  if (typeof cron !== "string" || cron.length > 100) return 'cron must be a 5-field string like "0 3 * * *"';
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 'cron has 5 fields: minute hour day-of-month month day-of-week (UTC), e.g. "0 3 * * *"';
  const values: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const v = cronValues(fields[i], CRON_FIELDS[i].min, CRON_FIELDS[i].max);
    if (typeof v === "string") return `${CRON_FIELDS[i].name}: ${v}`;
    values.push(v);
  }
  const times: number[] = [];
  for (const h of values[1]) for (const m of values[0]) times.push(h * 60 + m);
  times.sort((a, b) => a - b);
  let smallest = 1440;
  for (let i = 1; i < times.length; i++) smallest = Math.min(smallest, times[i] - times[i - 1]);
  if (times.length > 0) smallest = Math.min(smallest, 1440 - times[times.length - 1] + times[0]);
  if (smallest < FUNCTION_LIMITS.minScheduleMinutes) return `a schedule may run at most every ${FUNCTION_LIMITS.minScheduleMinutes} minutes`;
  return null;
}

export function checkFunctions(raw: unknown, roles: ReadonlySet<string>): FunctionIssue[] {
  const issues: FunctionIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  if (!isObj(raw)) {
    add("functions", "invalid_functions", "functions must be an object with endpoints, schedules, secrets and allowedHosts");
    return issues;
  }
  for (const k of Object.keys(raw)) {
    if (!["endpoints", "schedules", "secrets", "allowedHosts"].includes(k)) {
      add(`functions.${k}`, "unknown_key", `unknown key "${k}" (use endpoints, schedules, secrets, allowedHosts)`);
    }
  }
  const names = new Map<string, string>();
  const claim = (path: string, name: string) => {
    const prior = names.get(name);
    if (prior) add(path, "duplicate_function", `"${name}" is already declared at ${prior}; one name, one functions/${name}.ts`);
    else names.set(name, path);
  };

  if (raw.endpoints !== undefined) {
    if (!isObj(raw.endpoints)) add("functions.endpoints", "invalid_endpoints", "endpoints must be an object of { name: { type } }");
    else {
      const entries = Object.entries(raw.endpoints);
      if (entries.length > FUNCTION_LIMITS.endpoints) add("functions.endpoints", "too_many_functions", `at most ${FUNCTION_LIMITS.endpoints} endpoints`);
      for (const [name, def] of entries) {
        const at = `functions.endpoints.${name}`;
        if (!FUNCTION_NAME_RE.test(name)) add(at, "invalid_function_name", "names are lowercase letters, digits and -, starting with a letter (at most 48)");
        claim(at, name);
        if (!isObj(def)) { add(at, "invalid_endpoint", 'an endpoint is { "type": "http", "principals": [...] } or { "type": "webhook" }'); continue; }
        for (const k of Object.keys(def)) if (k !== "type" && k !== "principals" && k !== "asAdmin") add(`${at}.${k}`, "unknown_key", `unknown key "${k}" (use type, principals, asAdmin)`);
        if (def.asAdmin !== undefined && typeof def.asAdmin !== "boolean") add(`${at}.asAdmin`, "invalid_as_admin", "asAdmin is true or false");
        if (def.type === "webhook") {
          if (def.principals !== undefined) add(`${at}.principals`, "principals_not_allowed", "a webhook has no signed-in caller; it must verify the sender itself (defineWebhook)");
        } else if (def.type === "http") {
          const p = def.principals;
          if (!Array.isArray(p) || p.length === 0) add(`${at}.principals`, "invalid_principals", 'list who may call it: "anyone", "signed_in", "admin" or "role:<name>"');
          else {
            if (p.length > 8) add(`${at}.principals`, "too_many_principals", "at most 8 principals");
            const seen = new Set<string>();
            p.forEach((e, i) => {
              const pat = `${at}.principals[${i}]`;
              if (typeof e !== "string") return add(pat, "invalid_principal", `${JSON.stringify(e)} is not a principal`);
              if (seen.has(e)) add(pat, "duplicate_principal", "listed twice");
              seen.add(e);
              if (PRINCIPAL_ORDER.includes(e)) return;
              if (ROLE_PRINCIPAL.test(e)) {
                if (!roles.has(e.slice(5))) add(pat, "undeclared_role", `${e} is not declared in "roles"`);
                return;
              }
              add(pat, "unknown_principal", `unknown principal ${JSON.stringify(e)} (use anyone, signed_in, admin or role:<name>)`);
            });
          }
        } else add(`${at}.type`, "invalid_endpoint_type", 'type is "http" (called by the site) or "webhook" (called by another service)');
      }
    }
  }

  if (raw.schedules !== undefined) {
    if (!isObj(raw.schedules)) add("functions.schedules", "invalid_schedules", 'schedules must be an object of { name: { "cron": "..." } }');
    else {
      const entries = Object.entries(raw.schedules);
      if (entries.length > FUNCTION_LIMITS.schedules) add("functions.schedules", "too_many_functions", `at most ${FUNCTION_LIMITS.schedules} schedules`);
      for (const [name, def] of entries) {
        const at = `functions.schedules.${name}`;
        if (!FUNCTION_NAME_RE.test(name)) add(at, "invalid_function_name", "names are lowercase letters, digits and -, starting with a letter (at most 48)");
        claim(at, name);
        if (!isObj(def)) { add(at, "invalid_schedule", 'a schedule is { "cron": "0 3 * * *" }'); continue; }
        for (const k of Object.keys(def)) if (k !== "cron" && k !== "asAdmin") add(`${at}.${k}`, "unknown_key", `unknown key "${k}" (use cron, asAdmin)`);
        if (def.asAdmin !== undefined && typeof def.asAdmin !== "boolean") add(`${at}.asAdmin`, "invalid_as_admin", "asAdmin is true or false");
        const why = cronIssue(def.cron);
        if (why) add(`${at}.cron`, "invalid_cron", why);
      }
    }
  }

  if (raw.secrets !== undefined) {
    if (!Array.isArray(raw.secrets)) add("functions.secrets", "invalid_secrets", 'secrets is a list of NAMES, e.g. ["STRIPE_SECRET_KEY"]; values are set by the owner in Settings');
    else {
      if (raw.secrets.length > FUNCTION_LIMITS.secrets) add("functions.secrets", "too_many_secrets", `at most ${FUNCTION_LIMITS.secrets} secrets`);
      const seen = new Set<string>();
      raw.secrets.forEach((s, i) => {
        const at = `functions.secrets[${i}]`;
        if (typeof s !== "string" || !SECRET_NAME_RE.test(s)) return add(at, "invalid_secret_name", "secret names are UPPER_SNAKE_CASE, 2-64 characters (the name only, never the value)");
        if (s.startsWith(RESERVED_SECRET_PREFIX)) add(at, "reserved_secret_name", `names starting with ${RESERVED_SECRET_PREFIX} are kept for the platform`);
        if (seen.has(s)) add(at, "duplicate_secret", "listed twice");
        seen.add(s);
      });
    }
  }

  if (raw.allowedHosts !== undefined) {
    if (!Array.isArray(raw.allowedHosts)) add("functions.allowedHosts", "invalid_allowed_hosts", 'allowedHosts is a list of host names, e.g. ["api.stripe.com"]');
    else {
      if (raw.allowedHosts.length > FUNCTION_LIMITS.allowedHosts) add("functions.allowedHosts", "too_many_hosts", `at most ${FUNCTION_LIMITS.allowedHosts} hosts`);
      const seen = new Set<string>();
      raw.allowedHosts.forEach((h, i) => {
        const at = `functions.allowedHosts[${i}]`;
        if (typeof h !== "string" || !HOST_RE.test(h)) return add(at, "invalid_host", "a host is a lowercase public DNS name like api.stripe.com (no scheme, path, port, IP address or wildcard)");
        if (h.endsWith(".zaviagent.com") || h === "zaviagent.com") add(at, "host_not_allowed", "functions reach this site's data through ctx.data, not over the network");
        else if (PRIVATE_HOST_SUFFIXES.some((s) => `.${h}`.endsWith(s))) add(at, "host_not_allowed", "only public internet hosts may be listed");
        if (seen.has(h)) add(at, "duplicate_host", "listed twice");
        seen.add(h);
      });
    }
  }

  if (names.size === 0 && issues.length === 0) {
    add("functions", "no_functions", "declare at least one endpoint or schedule (or remove the functions block)");
  }
  return issues;
}

const canonicalPrincipalList = (p: string[]): string[] => {
  const known = PRINCIPAL_ORDER.filter((x) => p.includes(x));
  const roles = p.filter((x) => !PRINCIPAL_ORDER.includes(x)).sort(byCodeUnit);
  return [...known, ...roles];
};

export function canonicalFunctions(raw: Record<string, unknown>): FunctionsDef {
  const endpoints: Record<string, EndpointDef> = {};
  const rawEndpoints = (raw.endpoints ?? {}) as Record<string, { type: EndpointType; principals?: string[]; asAdmin?: boolean }>;
  for (const name of Object.keys(rawEndpoints).sort(byCodeUnit)) {
    const d = rawEndpoints[name];
    const e: EndpointDef = d.type === "webhook" ? { type: "webhook" } : { type: "http", principals: canonicalPrincipalList(d.principals ?? []) };
    if (d.asAdmin === true) e.asAdmin = true;
    endpoints[name] = e;
  }
  const schedules: Record<string, ScheduleDef> = {};
  const rawSchedules = (raw.schedules ?? {}) as Record<string, { cron: string; asAdmin?: boolean }>;
  for (const name of Object.keys(rawSchedules).sort(byCodeUnit)) {
    const d: ScheduleDef = { cron: rawSchedules[name].cron.trim().split(/\s+/).join(" ") };
    if (rawSchedules[name].asAdmin === true) d.asAdmin = true;
    schedules[name] = d;
  }
  return {
    endpoints,
    schedules,
    secrets: [...new Set((raw.secrets ?? []) as string[])].sort(byCodeUnit),
    allowedHosts: [...new Set((raw.allowedHosts ?? []) as string[])].sort(byCodeUnit),
  };
}

export function functionFilePath(name: string): string {
  return `${FUNCTIONS_DIR}/${name}.ts`;
}

export type FunctionKind = "http" | "webhook" | "schedule";

export function declaredFunctions(f: FunctionsDef | undefined): Array<{ name: string; kind: FunctionKind; asAdmin: boolean }> {
  if (!f) return [];
  return [
    ...Object.entries(f.endpoints).map(([name, d]) => ({ name, kind: d.type as FunctionKind, asAdmin: d.asAdmin === true })),
    ...Object.entries(f.schedules).map(([name, d]) => ({ name, kind: "schedule" as const, asAdmin: d.asAdmin === true })),
  ].sort((a, b) => byCodeUnit(a.name, b.name));
}

export function functionPrincipal(name: string): string {
  return `fn:${name}`;
}

export function functionFileIssues(f: FunctionsDef | undefined, paths: readonly string[]): FunctionIssue[] {
  const norm = new Set(paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));
  const issues: FunctionIssue[] = [];
  const declared = new Set(declaredFunctions(f).map((d) => d.name));
  for (const name of declared) {
    if (!norm.has(functionFilePath(name))) {
      issues.push({ path: functionFilePath(name), code: "function_file_missing", message: `"${name}" is declared in zavi-site.json but ${functionFilePath(name)} does not exist` });
    }
  }
  for (const p of norm) {
    const m = /^functions\/([^/]+)\.ts$/.exec(p);
    if (!m) continue;
    if (!declared.has(m[1])) {
      issues.push({ path: p, code: "function_not_declared", message: `${p} is not declared under functions.endpoints or functions.schedules in zavi-site.json` });
    }
  }
  return issues;
}
