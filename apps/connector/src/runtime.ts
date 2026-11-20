import { createHash } from "node:crypto";
import type { ConnectorDelivery, ConnectorResult } from "@zavi/shared/db-guard";
import { checkRequest, describeOp, reasonForZavi, reasonScope, ZAVI_DB_ERROR } from "./check";
import { execute } from "./execute";
import { backoffMs, type ZaviClient } from "./client";
import type { ActivityLog, Decision, Delivery } from "./activity";
import { safeDbError, type DatabaseManager } from "./db";
import { rulesHash, rulesSummary, type RulesFile } from "./rules";
import type { Store } from "./store";
import type { Config } from "./config";
import type { Introspection } from "./db/types";

export const HEARTBEAT_MS = 15_000;
export const REQUEST_DEADLINE_MS = 42_000;
export const CATALOG_MAX_AGE_MS = 10 * 60_000;
const UNAUTHORIZED_CONFIRM_MS = 5_000;
const ONLINE_WINDOW_MS = 45_000;
const MIN_EMPTY_POLL_MS = 1_000;

export type Status =
  | { kind: "unpaired" }
  | { kind: "pairing" }
  | { kind: "pair_failed"; message: string }
  | { kind: "running" }
  | { kind: "revoked" }
  | { kind: "stopped" };

export const REVOKED_MESSAGE = "Pairing was revoked. Run the docker command again with a new code.";

export type RuntimeDeps = {
  cfg: Pick<Config, "pairCode" | "machine" | "version" | "concurrency" | "maxStatementMs">;
  store: Store;
  rules: RulesFile;
  db: DatabaseManager;
  activity: ActivityLog;
  client: ZaviClient;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  now?: () => number;
  rand?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

class Semaphore {
  private free: number;
  private waiters: Array<() => void> = [];
  constructor(n: number) {
    this.free = n;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.free++;
  }
}

export class ConnectorRuntime {
  status: Status = { kind: "unpaired" };
  lastError: string | null = null;
  lastContactAt: number | null = null;
  lastHeartbeatAt: number | null = null;
  pairNote: string | null = null;

  private stopping = false;
  private readonly stopCtl = new AbortController();
  private pollCtl: AbortController | null = null;
  private readonly inflight = new Map<string, { execution_token: string; done: Promise<void> }>();
  private unauthorizedSince: number | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private hbSoon: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private readonly slots: Semaphore;
  private readonly now: () => number;
  private readonly rand: () => number;

  constructor(private readonly d: RuntimeDeps) {
    this.now = d.now ?? (() => Date.now());
    this.rand = d.rand ?? Math.random;
    this.slots = new Semaphore(d.cfg.concurrency);
    d.rules.onChange(() => this.heartbeatSoon());
  }

  online(): boolean {
    return this.status.kind === "running" && this.lastContactAt !== null && this.now() - this.lastContactAt < ONLINE_WINDOW_MS;
  }

  private sleep(ms: number): Promise<void> {
    if (this.d.sleep) return this.stopping ? Promise.resolve() : this.d.sleep(ms);
    return new Promise((resolve) => {
      if (this.stopping) return resolve();
      const t = setTimeout(done, ms);
      const sig = this.stopCtl.signal;
      function done() {
        clearTimeout(t);
        sig.removeEventListener("abort", done);
        resolve();
      }
      sig.addEventListener("abort", done, { once: true });
    });
  }

  async start(): Promise<void> {
    await this.pairIfNeeded();
    if (this.stopping || !this.d.store.read().token) return;
    this.status = { kind: "running" };
    void this.heartbeat();
    this.hbTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.hbTimer.unref?.();
    this.loop = this.pollLoop();
  }

  private async pairIfNeeded(): Promise<void> {
    const code = this.d.cfg.pairCode;
    const st = this.d.store.read();
    if (!code) {
      this.status = st.token ? { kind: "running" } : { kind: "unpaired" };
      return;
    }
    if (st.token && st.paired_code_hash === sha(code)) return;
    this.status = { kind: "pairing" };
    for (let attempt = 0; !this.stopping; attempt++) {
      const out = await this.d.client.pair(code, this.d.cfg.machine, this.d.cfg.version);
      if (out.kind === "paired") {
        this.d.store.update((s) => ({ ...s, token: out.token, paired_code_hash: sha(code), paired_at: new Date(this.now()).toISOString() }));
        this.d.log("info", `Paired with Zavi as "${this.d.cfg.machine}".`);
        this.pairNote = null;
        return;
      }
      if (out.kind === "rejected") {
        if (st.token) {
          this.pairNote = "The new pairing code was not accepted, so the connector keeps its earlier pairing.";
          this.d.log("warn", this.pairNote);
          return;
        }
        this.status = { kind: "pair_failed", message: out.message };
        this.lastError = out.message;
        this.d.log("error", out.message);
        return;
      }
      this.lastError = `Pairing: ${out.why}`;
      const wait = out.afterMs ?? backoffMs(attempt, this.rand);
      this.d.log("warn", `Pairing failed (${out.why}); retrying in ${Math.round(wait / 1000)}s.`);
      await this.sleep(wait);
    }
  }

  heartbeatBody() {
    const summary = rulesSummary(this.d.rules.current());
    return {
      machine: this.d.cfg.machine,
      version: this.d.cfg.version,
      dialect: this.d.db.config()?.dialect ?? null,
      source_instance_id: this.d.db.config()?.source_instance_id ?? null,
      rules: summary,
      rules_hash: rulesHash(summary),
    };
  }

  heartbeatSoon(): void {
    if (this.status.kind !== "running" || this.stopping) return;
    if (this.hbSoon) clearTimeout(this.hbSoon);
    this.hbSoon = setTimeout(() => {
      this.hbSoon = null;
      void this.heartbeat();
    }, 250);
  }

  async heartbeat(): Promise<void> {
    if (this.status.kind !== "running" || this.stopping) return;
    const out = await this.d.client.heartbeat(this.heartbeatBody());
    if (out === "ok") {
      this.lastHeartbeatAt = this.now();
      this.contact();
    } else if (out === "unauthorized") await this.unauthorized();
    else this.lastError = `Heartbeat: ${out.error}`;
  }

  private contact(): void {
    this.lastContactAt = this.now();
    this.unauthorizedSince = null;
  }

  private async unauthorized(): Promise<boolean> {
    if (this.unauthorizedSince === null) {
      this.unauthorizedSince = this.now();
      return false;
    }
    if (this.now() - this.unauthorizedSince < UNAUTHORIZED_CONFIRM_MS) return false;
    if (this.status.kind === "revoked") return true;
    this.status = { kind: "revoked" };
    this.lastError = REVOKED_MESSAGE;
    this.d.log("error", REVOKED_MESSAGE);
    this.d.store.update((s) => ({ ...s, token: null, paired_code_hash: null }));
    this.pollCtl?.abort();
    if (this.hbTimer) clearInterval(this.hbTimer);
    return true;
  }

  private async pollLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopping && this.status.kind === "running") {
      await this.slots.acquire();
      if (this.stopping || this.status.kind !== "running") {
        this.slots.release();
        break;
      }
      this.pollCtl = new AbortController();
      const polledAt = this.now();
      const out = await this.d.client.next(AbortSignal.any([this.pollCtl.signal, this.stopCtl.signal]));
      this.pollCtl = null;
      if (out.kind === "delivery") {
        attempt = 0;
        this.contact();
        this.spawn(out.delivery);
        continue;
      }
      this.slots.release();
      if (this.stopping) break;
      if (out.kind === "empty") {
        attempt = 0;
        this.contact();
        if (this.now() - polledAt < MIN_EMPTY_POLL_MS) await this.sleep(MIN_EMPTY_POLL_MS);
        continue;
      }
      if (out.kind === "bad_delivery") {
        this.contact();
        if (out.id && out.execution_token) {
          const body = JSON.stringify({ execution_token: out.execution_token, status: "refused", reason: out.reason });
          const delivery = await this.post(out.id, body);
          this.record(out.id, "(not understood)", "(a request this connector does not understand)", "refused", out.reason, 0, body, delivery);
        }
        continue;
      }
      if (out.kind === "unauthorized") {
        if (await this.unauthorized()) break;
        await this.sleep(UNAUTHORIZED_CONFIRM_MS);
        continue;
      }
      this.lastError = `Polling: ${out.why}`;
      const wait = out.afterMs !== null ? out.afterMs + Math.round(this.rand() * Math.min(1000, out.afterMs * 0.2)) : backoffMs(attempt++, this.rand);
      await this.sleep(wait);
    }
  }

  private spawn(delivery: ConnectorDelivery): void {
    const done = this.handle(delivery)
      .catch((e) => this.d.log("error", `Request handling crashed: ${(e as Error).name}`))
      .finally(() => {
        this.inflight.delete(delivery.id);
        this.slots.release();
      });
    this.inflight.set(delivery.id, { execution_token: delivery.execution_token, done });
  }

  async handle(delivery: ConnectorDelivery): Promise<void> {
    const { id, execution_token, op, generation } = delivery;
    const query = describeOp(op);
    let result: ConnectorResult;
    let detailed: string | null = null;
    const cfg = this.d.db.config();
    const sourceAtStart = cfg?.source_instance_id ?? null;
    let catalog: Introspection | null = null;
    try {
      const driver = this.d.db.driver();
      if (driver) {
        try {
          catalog = op.op === "describe" ? await this.d.db.refresh() : await this.d.db.catalog(CATALOG_MAX_AGE_MS);
        } catch (e) {
          throw new Error(`The connector could not read its database's structure: ${(e as Error).message}`);
        }
      }
      const checked = checkRequest(op, {
        rules: this.d.rules.current(),
        dialect: cfg?.dialect ?? null,
        database: driver?.database ?? null,
        catalog,
        maxStatementMs: this.d.cfg.maxStatementMs,
      });
      if (!checked.ok) result = { status: checked.status, reason: checked.reason.slice(0, 500) };
      else result = await withDeadline(execute(checked, { driver: driver!, intro: catalog! }), REQUEST_DEADLINE_MS);
      if (result.status !== "done") {
        detailed = result.reason;
        const scope = reasonScope(this.d.rules.current(), catalog, cfg?.dialect ?? null);
        result = { ...result, reason: reasonForZavi(result.reason, scope).slice(0, 500) };
      }
    } catch (e) {
      const deadline = e instanceof DeadlineError;
      detailed = deadline ? "The read took too long on the connector." : safeDbError(e, cfg?.connection_string ?? null);
      result = { status: "failed", reason: deadline ? detailed : ZAVI_DB_ERROR };
    }
    if (result.status === "done" && (this.d.db.config()?.source_instance_id ?? null) !== sourceAtStart) {
      detailed = "The database on this connector changed while the read ran.";
      result = { status: "failed", reason: "source_changed" };
    }
    const body = JSON.stringify({ execution_token, generation, source_instance_id: sourceAtStart, ...result });
    const delivered = await this.post(id, body);
    const decision: Decision = result.status === "done" ? "allowed" : result.status;
    const reason = result.status === "done" ? null : (detailed ?? result.reason);
    this.record(id, op.op, query, decision, reason, rowCount(result), body, delivered);
  }

  private async post(id: string, body: string): Promise<Delivery> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = await this.d.client.postResult(id, body);
      if (out === "delivered") return "delivered";
      if (out === "stale") return "stale";
      if (out === "rejected") return "rejected";
      if (out === "unauthorized") {
        await this.unauthorized();
        return "not_delivered";
      }
      if (this.stopping && attempt > 0) break;
      await new Promise((r) => setTimeout(r, out.afterMs ?? backoffMs(attempt, this.rand, 500, 5_000)));
    }
    return "not_delivered";
  }

  private record(request_id: string, opName: string, query: string, decision: Decision, reason: string | null, rows: number, sent: string, delivery: Delivery): void {
    try {
      this.d.activity.append({ request_id, op: opName, query: query.slice(0, 20_000), decision, reason, rows, bytes: Buffer.byteLength(sent, "utf8"), delivery, sent });
    } catch (e) {
      this.d.log("error", `Could not write the activity log: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`);
    }
  }

  async stop(graceMs = 8_000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopCtl.abort();
    this.pollCtl?.abort();
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.hbSoon) clearTimeout(this.hbSoon);
    const pending = [...this.inflight.values()].map((x) => x.done);
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, graceMs))]);
    const left = [...this.inflight.entries()];
    await Promise.allSettled(
      left.map(async ([id, x]) => {
        const body = JSON.stringify({ execution_token: x.execution_token, status: "failed", reason: "The connector was shutting down and could not finish this read." });
        const out = await this.d.client.postResult(id, body).catch(() => "not_delivered" as const);
        this.record(id, "(shutdown)", "(abandoned at shutdown)", "failed", "The connector was shutting down and could not finish this read.", 0, body, typeof out === "string" ? (out === "unauthorized" ? "not_delivered" : out) : "not_delivered");
      }),
    );
    await this.loop?.catch(() => undefined);
    this.status = { kind: "stopped" };
  }
}

function rowCount(r: ConnectorResult): number {
  if (r.status !== "done") return 0;
  const d = r.data;
  if (d.kind === "rows") return d.rows.length;
  if (d.kind === "docs") return d.docs.length;
  if (d.kind === "count") return 1;
  return d.introspection.tables.length;
}

class DeadlineError extends Error {}
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new DeadlineError()), ms)))]).finally(() => clearTimeout(t));
}
