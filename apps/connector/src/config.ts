import { hostname } from "node:os";

declare const __CONNECTOR_VERSION__: string | undefined;

export const DEFAULT_API = "https://api.zaviagent.com";
export const DEFAULT_SECRET_FILE = "/run/secrets/zavi_connector_key";
export const DEFAULT_MAX_STATEMENT_MS = 30_000;
export const DEFAULT_STATEMENT_MS = 5_000;

export type Config = {
  api: string;
  pairCode: string | null;
  dataDir: string;
  bind: string;
  port: number;
  secretFile: string;
  envKey: string | null;
  machine: string;
  version: string;
  extraHosts: string[];
  maxStatementMs: number;
  concurrency: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function intIn(raw: string | undefined, name: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function connectorVersion(): string {
  return typeof __CONNECTOR_VERSION__ === "string" && __CONNECTOR_VERSION__ ? __CONNECTOR_VERSION__ : "0.0.0-dev";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const api = (env.ZAVI_API ?? DEFAULT_API).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new ConfigError("ZAVI_API must be a URL.");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && env.ZAVI_ALLOW_HTTP_API === "1";
  if (url.protocol !== "https:" && !localHttp) throw new ConfigError("ZAVI_API must use https://.");
  if (url.username || url.password || url.search || url.hash) throw new ConfigError("ZAVI_API must be a plain origin.");

  const machine = (env.ZAVI_MACHINE ?? hostname()).trim().slice(0, 120) || "connector";
  const pair = (env.ZAVI_PAIR ?? "").trim();
  return {
    api,
    pairCode: pair ? pair : null,
    dataDir: (env.ZAVI_DATA_DIR ?? "/data").trim() || "/data",
    bind: (env.ZAVI_LOCAL_BIND ?? "127.0.0.1").trim() || "127.0.0.1",
    port: intIn(env.ZAVI_LOCAL_PORT, "ZAVI_LOCAL_PORT", 7801, 1, 65535),
    secretFile: (env.ZAVI_SECRET_KEY_FILE ?? DEFAULT_SECRET_FILE).trim() || DEFAULT_SECRET_FILE,
    envKey: env.ZAVI_SECRET_KEY?.trim() ? env.ZAVI_SECRET_KEY.trim() : null,
    machine,
    version: connectorVersion(),
    extraHosts: (env.ZAVI_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => /^[a-z0-9.-]{1,253}$/.test(h)),
    maxStatementMs: intIn(env.ZAVI_MAX_STATEMENT_TIMEOUT_MS, "ZAVI_MAX_STATEMENT_TIMEOUT_MS", DEFAULT_MAX_STATEMENT_MS, 100, 120_000),
    concurrency: intIn(env.ZAVI_CONCURRENCY, "ZAVI_CONCURRENCY", 4, 1, 16),
  };
}
