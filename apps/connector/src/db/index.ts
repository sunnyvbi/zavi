import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import type { DatabaseConfig, Store } from "../store";
import { openMongo } from "./mongo";
import { openMysql } from "./mysql";
import { openPostgres } from "./postgres";
import type { Dialect, Driver, Introspection } from "./types";

export type DriverOpener = (dialect: Dialect, connectionString: string) => Driver;

export const defaultOpener: DriverOpener = (dialect, cs) => (dialect === "postgres" ? openPostgres(cs) : dialect === "mysql" ? openMysql(cs) : openMongo(cs));

export const DIALECT_LABEL: Record<Dialect, string> = { postgres: "PostgreSQL", mysql: "MySQL", mongodb: "MongoDB" };
const SCHEMES: Record<Dialect, RegExp> = {
  postgres: /^postgres(ql)?:\/\//i,
  mysql: /^(mysql|mariadb):\/\//i,
  mongodb: /^mongodb(\+srv)?:\/\//i,
};

function secretsOf(cs: string): string[] {
  const out = [cs];
  try {
    const u = new URL(cs);
    if (u.password) out.push(u.password, decodeURIComponent(u.password));
  } catch {
    const m = /(?:^|\s)password\s*=\s*('(?:\\.|[^'\\])*'|\S+)/i.exec(cs);
    if (m) out.push(m[1]!, m[1]!.replace(/^'|'$/g, ""));
  }
  return out.filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
}

export function safeDbError(e: unknown, cs: string | null): string {
  let msg = e instanceof Error ? e.message : String(e);
  if (cs) for (const s of secretsOf(cs)) msg = msg.split(s).join("[redacted]");
  msg = msg.replace(/\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?):\/\/[^\s'"]+/gi, "[connection string]");
  return msg.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

export function maskConnection(cs: string): string {
  try {
    const u = new URL(cs);
    const user = u.username ? `${decodeURIComponent(u.username)}:•••@` : "";
    return `${u.protocol}//${user}${u.host}${u.pathname}`;
  } catch {
    return "(saved key=value connection string)";
  }
}

export function connectionStringProblem(dialect: Dialect, cs: string): string | null {
  if (cs.length === 0) return "Paste a connection string.";
  if (cs.length > 4096) return "That connection string is too long.";
  if (/[\u0000-\u001f]/.test(cs)) return "The connection string has a line break or control character in it.";
  if (dialect === "postgres" && !SCHEMES.postgres.test(cs) && !/=/.test(cs)) return "A PostgreSQL connection string starts with postgres:// (or is a key=value string).";
  if (dialect === "mysql" && !SCHEMES.mysql.test(cs)) return "A MySQL connection string starts with mysql://.";
  if (dialect === "mongodb") {
    if (!SCHEMES.mongodb.test(cs)) return "A MongoDB connection string starts with mongodb:// or mongodb+srv://.";
    try {
      if (!new URL(cs).pathname.replace(/^\//, "")) return "Add the database name after the host, like mongodb://host/<database>.";
    } catch {
      return "That MongoDB connection string is not a valid URL.";
    }
  }
  return null;
}

const fp = (cs: string) => createHash("sha256").update(cs).digest("hex");

export function newSourceInstanceId(): string {
  return randomBytes(16).toString("hex");
}

export class DatabaseManager {
  private current: { fp: string; dialect: Dialect; driver: Driver } | null = null;
  private cat: { fp: string; intro: Introspection; at: number } | null = null;
  private inflight: Promise<Introspection> | null = null;

  constructor(
    private readonly store: Store,
    private readonly open: DriverOpener = defaultOpener,
    private readonly now: () => number = () => Date.now(),
  ) {}

  config(): DatabaseConfig | null {
    const cfg = this.store.read().database;
    if (!cfg || cfg.source_instance_id) return cfg;
    return this.store.update((s) => (s.database && !s.database.source_instance_id ? { ...s, database: { ...s.database, source_instance_id: newSourceInstanceId() } } : s)).database;
  }

  sourceInstanceId(): string | null {
    return this.config()?.source_instance_id ?? null;
  }

  driver(): Driver | null {
    const cfg = this.config();
    if (!cfg) {
      this.drop();
      return null;
    }
    const f = fp(cfg.connection_string);
    if (this.current?.fp !== f) {
      this.drop();
      this.current = { fp: f, dialect: cfg.dialect, driver: this.open(cfg.dialect, cfg.connection_string) };
      this.cat = null;
    }
    return this.current.driver;
  }

  private drop(): void {
    if (this.current) void this.current.driver.close().catch(() => undefined);
    this.current = null;
    this.cat = null;
  }

  async catalog(maxAgeMs = Number.POSITIVE_INFINITY): Promise<Introspection | null> {
    const d = this.driver();
    if (!d) return null;
    if (this.cat && this.cat.fp === this.current!.fp && this.now() - this.cat.at <= maxAgeMs) return this.cat.intro;
    return this.refresh();
  }

  cachedCatalog(): Introspection | null {
    return this.cat && this.current && this.cat.fp === this.current.fp ? this.cat.intro : null;
  }

  refresh(deadlineMs = 25_000): Promise<Introspection> {
    if (this.inflight) return this.inflight;
    const d = this.driver();
    if (!d) return Promise.reject(new Error("No database is added on this connector yet."));
    const f = this.current!.fp;
    const cs = this.config()!.connection_string;
    this.inflight = d
      .introspect(this.now() + deadlineMs)
      .then((intro) => {
        if (this.current?.fp === f) this.cat = { fp: f, intro, at: this.now() };
        return intro;
      })
      .catch((e) => {
        throw new Error(safeDbError(e, cs));
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async testAndSave(dialect: Dialect, cs: string): Promise<{ ok: true; intro: Introspection } | { ok: false; error: string }> {
    const problem = connectionStringProblem(dialect, cs);
    if (problem) return { ok: false, error: problem };
    const candidate = this.open(dialect, cs);
    let intro: Introspection;
    try {
      await candidate.test();
      intro = await candidate.introspect(this.now() + 25_000);
    } catch (e) {
      await candidate.close().catch(() => undefined);
      return { ok: false, error: safeDbError(e, cs) };
    }
    this.store.update((s) => ({ ...s, database: { dialect, connection_string: cs, saved_at: new Date(this.now()).toISOString(), source_instance_id: newSourceInstanceId() } }));
    this.drop();
    this.current = { fp: fp(cs), dialect, driver: candidate };
    this.cat = { fp: fp(cs), intro, at: this.now() };
    return { ok: true, intro };
  }

  remove(): void {
    this.store.update((s) => ({ ...s, database: null }));
    this.drop();
  }

  async close(): Promise<void> {
    const c = this.current;
    this.current = null;
    if (c) await c.driver.close().catch(() => undefined);
  }
}
