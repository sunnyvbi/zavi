import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { ConnectorHeartbeat, ConnectorOp, ConnectorPairRequest, parseConnectorCompletion } from "@zavi/shared/db-guard";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { redeemPairCode } from "@/services/data-gateway/connector/pairing";
import { claimNext, complete } from "@/services/data-gateway/connector/queue";
import { ensureWakeupSubscription, waitForWake } from "@/services/data-gateway/connector/wakeup";
import { sendConnectorDiscovery } from "@/services/data-gateway/connector/discovery-outbox";
import { getConnector, requireConnectorToken, type ResolveDeps } from "./auth";

export const LONG_POLL_MS = 25_000;
export const SAFETY_RECHECK_MS = 5_000;
const POLL_LEASE_SECONDS = 35;

export type ConnectorRouteDeps = {
  redeem: typeof redeemPairCode;
  claimNext: typeof claimNext;
  complete: typeof complete;
  rpc: typeof tenantRpc;
  sendDiscovery: (tenant_id: string, generation: number) => Promise<boolean>;
  waitForWake: typeof waitForWake;
  subscribe: () => void;
  log: typeof logEvent;
  now: () => number;
  longPollMs: number;
  resolve?: ResolveDeps;
};

const DEFAULT: ConnectorRouteDeps = {
  redeem: (...a) => redeemPairCode(...a),
  claimNext: (...a) => claimNext(...a),
  complete: (...a) => complete(...a),
  rpc: (...a) => tenantRpc(...a),
  sendDiscovery: (t, g) => sendConnectorDiscovery(t, g),
  waitForWake: (...a) => waitForWake(...a),
  subscribe: () => ensureWakeupSubscription(),
  log: (i) => logEvent(i),
  now: () => Date.now(),
  longPollMs: LONG_POLL_MS,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
}

export function connectorRouter(over: Partial<ConnectorRouteDeps> = {}): Router {
  const d: ConnectorRouteDeps = { ...DEFAULT, ...over };
  const r = Router();

  r.post("/pair", async (req: Request, res: Response) => {
    noStore(res);
    const parsed = ConnectorPairRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body" } });
      return;
    }
    const out = await d.redeem({ code: parsed.data.code, machine: parsed.data.machine, version: parsed.data.version, ip: req.ip });
    if (out.ok) {
      res.status(200).json({ token: out.token });
      return;
    }
    res.status(out.status).json({ error: { code: out.status === 401 ? "unauthorized" : out.reason } });
  });

  r.use(requireConnectorToken(d.resolve));

  r.get("/requests/next", async (req: Request, res: Response) => {
    const { tenant_id, connector_id } = getConnector(req);
    const tid = asTenantId(tenant_id);
    const lease = randomUUID();
    try {
      const { data, error } = await d.rpc(tid, "acquire_db_connector_poll", { p_connector_id: connector_id, p_lease_id: lease, p_seconds: POLL_LEASE_SECONDS });
      if (error) throw new Error("acquire failed");
      const row = (Array.isArray(data) ? data[0] : null) as { acquired?: boolean; retry_after?: number } | null;
      if (!row?.acquired) {
        res.setHeader("Retry-After", String(Math.max(1, Number(row?.retry_after ?? 1))));
        res.status(429).json({ error: { code: "poll_in_progress" } });
        return;
      }
    } catch {
      await d.log({ level: "error", source: "db-connector.queue", code: "connector_poll_lease_failed", tenant_id });
      res.status(503).json({ error: { code: "unavailable" } });
      return;
    }

    d.subscribe();
    let closed = false;
    const abortFns: Array<() => void> = [];
    res.on("close", () => {
      if (res.writableEnded) return;
      closed = true;
      for (const fn of abortFns.splice(0)) fn();
    });
    const signal = {
      get aborted() {
        return closed;
      },
      onAbort: (fn: () => void) => void abortFns.push(fn),
    };

    const tryClaim = async (): Promise<boolean> => {
      for (;;) {
        const delivery = await d.claimNext(tenant_id, connector_id);
        if (!delivery) return false;
        const op = ConnectorOp.safeParse(delivery.op);
        if (!op.success) {
          await d.complete(tenant_id, connector_id, delivery.id, delivery.execution_token, "failed", null, "Zavi built a request the connector protocol does not allow.", { generation: delivery.generation, source_instance_id: null });
          await d.log({ level: "error", source: "db-connector.queue", code: "connector_bad_op", tenant_id });
          continue;
        }
        if (closed) return true;
        res.status(200).json({ id: delivery.id, execution_token: delivery.execution_token, op: op.data, generation: delivery.generation });
        return true;
      }
    };

    try {
      if (await tryClaim()) return;
      const deadline = d.now() + Math.min(d.longPollMs, LONG_POLL_MS);
      while (!closed) {
        const remaining = deadline - d.now();
        if (remaining <= 0) break;
        await d.waitForWake(tenant_id, Math.min(SAFETY_RECHECK_MS, remaining), signal);
        if (closed) break;
        if (await tryClaim()) return;
      }
      if (!closed && (await tryClaim())) return;
      if (!closed) res.status(204).end();
    } catch {
      await d.log({ level: "error", source: "db-connector.queue", code: "connector_claim_failed", tenant_id });
      if (!closed && !res.headersSent) res.status(503).json({ error: { code: "unavailable" } });
    } finally {
      await Promise.resolve(d.rpc(tid, "release_db_connector_poll", { p_connector_id: connector_id, p_lease_id: lease })).catch(() => undefined);
    }
  });

  r.post("/requests/:id/result", async (req: Request, res: Response) => {
    const { tenant_id, connector_id } = getConnector(req);
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) {
      res.status(400).json({ error: { code: "invalid_request_id" } });
      return;
    }
    const parsed = parseConnectorCompletion(req.body);
    if (!parsed.ok) {
      await d.log({ level: "warn", source: "db-connector.queue", code: "connector_invalid_result", tenant_id, meta: { stage: "route" } });
      res.status(400).json({ error: { code: "invalid_result", message: parsed.reason.slice(0, 200) } });
      return;
    }
    const v = parsed.value;
    try {
      const outcome = await d.complete(
        tenant_id,
        connector_id,
        id,
        parsed.execution_token,
        v.status,
        v.status === "done" ? v : null,
        v.status === "done" ? null : v.reason,
        { generation: parsed.generation, source_instance_id: parsed.source_instance_id },
      );
      if (outcome === "stale" || outcome === "source_changed") {
        res.status(409).json({ error: { code: outcome } });
        return;
      }
      res.status(204).end();
    } catch {
      await d.log({ level: "error", source: "db-connector.queue", code: "connector_complete_failed", tenant_id });
      res.status(503).json({ error: { code: "unavailable" } });
    }
  });

  r.post("/heartbeat", async (req: Request, res: Response) => {
    const { tenant_id, connector_id } = getConnector(req);
    const parsed = ConnectorHeartbeat.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body" } });
      return;
    }
    const hb = parsed.data;
    const tid = asTenantId(tenant_id);
    try {
      const { data, error } = await d.rpc(tid, "touch_db_connector", {
        p_connector_id: connector_id,
        p_machine: hb.machine,
        p_version: hb.version,
        p_rules: hb.rules ?? null,
        p_rules_hash: hb.rules_hash ?? null,
        p_source_instance_id: hb.source_instance_id,
      });
      if (error) throw new Error("touch failed");
      const t = (Array.isArray(data) ? data[0] : null) as {
        is_active?: boolean;
        was_offline?: boolean;
        offline_seconds?: number;
        discovery_generation?: number | string | null;
      } | null;
      if (!t?.is_active) {
        res.status(401).json({ error: { code: "unauthorized" } });
        return;
      }
      if (t.was_offline) {
        await d.log({ level: "info", source: "db-connector.liveness", code: "connector_online", tenant_id, meta: { ms: Math.max(0, Number(t.offline_seconds ?? 0)) * 1000 } });
      }
      const generations: number[] = [];
      if (t.discovery_generation != null) generations.push(Number(t.discovery_generation));
      if (hb.dialect) {
        const { data: gen, error: dErr } = await d.rpc(tid, "set_db_connector_dialect", { p_connector_id: connector_id, p_dialect: hb.dialect });
        if (dErr) throw new Error("dialect failed");
        if (gen != null) generations.push(Number(gen));
      }
      const rediscover = generations.length > 0;
      if (rediscover) await d.sendDiscovery(tenant_id, Math.max(...generations));
      res.status(200).json({ ok: true, rediscover });
    } catch {
      await d.log({ level: "error", source: "db-connector.liveness", code: "connector_heartbeat_failed", tenant_id });
      res.status(503).json({ error: { code: "unavailable" } });
    }
  });

  return r;
}
