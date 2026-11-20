
import { CronError, minIntervalMinutes, parseCron } from "./cron";

export const FN_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const PRINCIPAL_RE = /^(anyone|signed_in|admin|role:[a-z][a-z0-9_]{0,31})$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DENIED_HOST_SUFFIXES = ["zaviagent.com", "supabase.co", "supabase.in", "workers.dev", "pages.dev", "internal", "local", "localhost"];
export const LIMITS = { endpoints: 16, schedules: 8, secrets: 16, allowedHosts: 8, minScheduleMinutes: 5 } as const;

export type DataAccess = "function" | "admin";

export interface FunctionsSpec {
  endpoints: Record<string, { type: "http" | "webhook"; principals: string[]; data: DataAccess }>;
  schedules: Record<string, { cron: string; data: DataAccess }>;
  secrets: string[];
  allowedHosts: string[];
}

export class FunctionsManifestError extends Error {
  readonly code = "functions_manifest_invalid";
  constructor(public problems: string[]) {
    super(`zavi-site.json "functions" is invalid: ${problems.slice(0, 5).join("; ")}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function functionNames(spec: FunctionsSpec): string[] {
  return [...new Set([...Object.keys(spec.endpoints), ...Object.keys(spec.schedules)])].sort();
}

export function adminFunctions(spec: FunctionsSpec): string[] {
  const out = new Set<string>();
  for (const [n, e] of Object.entries(spec.endpoints)) if (e.data === "admin") out.add(n);
  for (const [n, s] of Object.entries(spec.schedules)) if (s.data === "admin") out.add(n);
  return [...out].sort();
}

export function parseFunctionsManifest(manifestRaw: unknown, now: Date = new Date()): FunctionsSpec | null {
  if (!isObj(manifestRaw) || manifestRaw.functions === undefined || manifestRaw.functions === null) return null;
  const f = manifestRaw.functions;
  const problems: string[] = [];
  if (!isObj(f)) throw new FunctionsManifestError(["functions must be an object"]);
  for (const k of Object.keys(f)) if (!["endpoints", "schedules", "secrets", "allowedHosts"].includes(k)) problems.push(`unknown key functions.${k}`);
  const data = (v: unknown, where: string): DataAccess => {
    if (v === undefined) return "function";
    if (v === true) return "admin";
    problems.push(`${where}.asAdmin must be true when present`);
    return "function";
  };

  const endpoints: FunctionsSpec["endpoints"] = {};
  if (f.endpoints !== undefined) {
    if (!isObj(f.endpoints)) problems.push("functions.endpoints must be an object");
    else {
      const entries = Object.entries(f.endpoints);
      if (entries.length > LIMITS.endpoints) problems.push(`at most ${LIMITS.endpoints} endpoints`);
      for (const [name, e] of entries.slice(0, LIMITS.endpoints)) {
        const w = `functions.endpoints.${name}`;
        if (!FN_NAME_RE.test(name)) { problems.push(`${w}: name must match ${FN_NAME_RE.source}`); continue; }
        if (!isObj(e)) { problems.push(`${w} must be an object`); continue; }
        for (const k of Object.keys(e)) if (!["type", "principals", "asAdmin"].includes(k)) problems.push(`${w}: unknown key ${k}`);
        if (e.type !== "http" && e.type !== "webhook") { problems.push(`${w}.type must be "http" or "webhook"`); continue; }
        let principals: string[] = ["anyone"];
        if (e.principals !== undefined) {
          if (e.type === "webhook") problems.push(`${w}: webhooks have no principals (no session is ever attached; verify the sender's signature instead)`);
          else if (!Array.isArray(e.principals) || !e.principals.length || e.principals.length > 8 || !e.principals.every((p) => typeof p === "string" && PRINCIPAL_RE.test(p))) {
            problems.push(`${w}.principals must be 1..8 of anyone | signed_in | admin | role:<name>`);
          } else principals = [...new Set(e.principals as string[])];
        }
        endpoints[name] = { type: e.type, principals: e.type === "webhook" ? [] : principals, data: data(e.asAdmin, w) };
      }
    }
  }

  const schedules: FunctionsSpec["schedules"] = {};
  if (f.schedules !== undefined) {
    if (!isObj(f.schedules)) problems.push("functions.schedules must be an object");
    else {
      const entries = Object.entries(f.schedules);
      if (entries.length > LIMITS.schedules) problems.push(`at most ${LIMITS.schedules} schedules`);
      for (const [name, s] of entries.slice(0, LIMITS.schedules)) {
        const w = `functions.schedules.${name}`;
        if (!FN_NAME_RE.test(name)) { problems.push(`${w}: name must match ${FN_NAME_RE.source}`); continue; }
        if (!isObj(s)) { problems.push(`${w} must be an object`); continue; }
        for (const k of Object.keys(s)) if (!["cron", "asAdmin"].includes(k)) problems.push(`${w}: unknown key ${k}`);
        if (typeof s.cron !== "string") { problems.push(`${w}.cron must be a string`); continue; }
        try {
          const c = parseCron(s.cron);
          if (minIntervalMinutes(c, now) < LIMITS.minScheduleMinutes) problems.push(`${w}.cron runs more often than every ${LIMITS.minScheduleMinutes} minutes`);
          schedules[name] = { cron: c.source, data: data(s.asAdmin, w) };
        } catch (err) {
          problems.push(`${w}.cron: ${err instanceof CronError ? err.message : "invalid"}`);
        }
      }
    }
  }

  let secrets: string[] = [];
  if (f.secrets !== undefined) {
    if (!Array.isArray(f.secrets) || f.secrets.length > LIMITS.secrets || !f.secrets.every((s) => typeof s === "string" && SECRET_NAME_RE.test(s) && !s.startsWith("ZAVI_"))) {
      problems.push(`functions.secrets must be at most ${LIMITS.secrets} names matching ${SECRET_NAME_RE.source} (not ZAVI_)`);
    } else secrets = [...new Set(f.secrets as string[])].sort();
  }

  let allowedHosts: string[] = [];
  if (f.allowedHosts !== undefined) {
    if (!Array.isArray(f.allowedHosts) || f.allowedHosts.length > LIMITS.allowedHosts) problems.push(`functions.allowedHosts must be at most ${LIMITS.allowedHosts} hostnames`);
    else {
      for (const h of f.allowedHosts) {
        const host = typeof h === "string" ? h.trim().toLowerCase() : "";
        const bare = host.replace(/^\*\./, "");
        if (!HOST_RE.test(host) || /^\d+(\.\d+)*$/.test(bare) || (host.startsWith("*.") && bare.split(".").length < 2)) {
          problems.push(`functions.allowedHosts: "${String(h).slice(0, 80)}" is not a hostname (https hosts only, no IPs, no ports, no paths)`);
        } else if (DENIED_HOST_SUFFIXES.some((s) => bare === s || bare.endsWith(`.${s}`))) {
          problems.push(`functions.allowedHosts: "${host}" is a platform or internal host and cannot be reached from a function`);
        } else allowedHosts.push(host);
      }
      allowedHosts = [...new Set(allowedHosts)].sort();
    }
  }

  if (!Object.keys(endpoints).length && !Object.keys(schedules).length && !problems.length) {
    problems.push("functions declares no endpoints and no schedules (remove the block, or declare one)");
  }
  if (problems.length) throw new FunctionsManifestError(problems);
  return { endpoints, schedules, secrets, allowedHosts };
}
