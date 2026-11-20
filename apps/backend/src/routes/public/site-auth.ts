
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import * as broker from "@/services/site-auth/broker";
import { SiteAuthError } from "@/services/site-auth/errors";
import { GW, GW_NONCE_TTL_S, verifyGatewayRequest } from "@/services/site-auth/gateway-auth";
import { defaultBrokerDeps } from "@/services/site-auth";
import type { SiteRequestContext } from "@/services/site-auth/types";

type Op = (deps: broker.BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) => Promise<unknown>;

export const SITE_AUTH_OPS: Record<string, Op> = {
  signup: broker.signup,
  login: broker.login,
  "magic-link": broker.magicLink,
  refresh: broker.refresh,
  logout: broker.logout,
  recover: broker.recover,
  password: broker.changePassword,
  email: broker.requestEmailChange,
  delete: broker.deleteAccount,
  "members-invite": broker.memberInvite,
  "members-set-role": broker.memberSetRole,
  "members-disable": broker.memberDisable,
  "members-remove": broker.memberRemove,
  "members-reenable": broker.memberReenable,
  "members-reassign-owner": broker.memberReassignOwner,
  "members-delete-data": broker.memberDeleteData,
  "turnstile-verify": broker.turnstileVerify,
};

export const SITE_AUTH_GET_OPS: Record<string, Op> = {
  "members-list": broker.memberList,
};

export interface SiteAuthRouteDeps {
  broker: () => broker.BrokerDeps;
  gatewaySecret: () => string | undefined;
  now: () => number;
  log?: (msg: string) => void;
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : undefined;
}

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function createSiteAuthHandler(deps: SiteAuthRouteDeps) {
  return async function siteAuth(req: Request, res: Response): Promise<void> {
    const requestId = header(req, GW.requestId) && /^[A-Za-z0-9-]{8,64}$/.test(header(req, GW.requestId)!)
      ? header(req, GW.requestId)!
      : randomUUID();
    const fail = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message, request_id: requestId } });

    const secret = (deps.gatewaySecret() ?? "").trim();
    if (secret.length < 32) {
      fail(503, "unavailable", "Sign-in is not available right now.");
      return;
    }
    const action = String(req.params?.op ?? "");
    const url = String(req.originalUrl ?? req.url ?? "");
    const qi = url.indexOf("?");
    const query = qi >= 0 && qi < url.length - 1 ? url.slice(qi) : "";
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verdict = verifyGatewayRequest(
      secret,
      {
        ts: header(req, GW.ts),
        requestId: header(req, GW.requestId),
        siteId: header(req, GW.site),
        host: header(req, GW.host)?.toLowerCase(),
        shardId: header(req, GW.shard),
        ip: header(req, GW.ip),
        sig: header(req, GW.sig),
        method: req.method,
        action,
        query,
        body: raw,
      },
      deps.now(),
    );
    if (!verdict.ok) {
      deps.log?.(`[site-auth] gateway auth refused: ${verdict.reason}`);
      fail(401, "unauthorized", "Not allowed.");
      return;
    }
    const isCallback = action === "callback" && req.method === "GET";
    const isConfirm = action === "confirm" && req.method === "POST";
    const fn = req.method === "POST" && has(SITE_AUTH_OPS, action) ? SITE_AUTH_OPS[action] : undefined;
    const getFn = req.method === "GET" && has(SITE_AUTH_GET_OPS, action) ? SITE_AUTH_GET_OPS[action] : undefined;
    if (!fn && !getFn && !isCallback && !isConfirm) {
      fail(404, "bad_request", "Unknown operation.");
      return;
    }
    const brokerDeps = deps.broker();
    const ctx: SiteRequestContext = {
      siteId: verdict.siteId, shardId: verdict.shardId, host: verdict.host, ip: verdict.ip, requestId,
    };
    const redirect = (location: string) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Location", location);
      res.status(303).json({ data: { redirect: location.split("#")[0] } });
    };
    try {
      await broker.admitGatewayRequest(brokerDeps, verdict, GW_NONCE_TTL_S);
      if (isCallback) {
        const q = new URLSearchParams(query);
        const params = { type: q.get("type") ?? undefined, token_hash: q.get("token_hash") ?? undefined };
        if (params.type === "signup") {
          for (const [k, v] of Object.entries(broker.INTERSTITIAL_HEADERS)) res.setHeader(k, v);
          res.status(200).send(broker.signupInterstitial(params.token_hash));
          return;
        }
        let location: string;
        if (q.get("confirm") !== "1") {
          location = broker.callbackLanding(params);
        } else {
          try {
            location = broker.callbackResultFragment(await broker.callback(brokerDeps, ctx, params));
          } catch (e) {
            if (!(e instanceof SiteAuthError)) throw e;
            location = `/auth/confirm#error=${e.code}`;
          }
        }
        redirect(location);
        return;
      }
      if (isConfirm) {
        const text = raw.toString("utf8");
        let input: Record<string, unknown> = {};
        const ct = String(req.headers["content-type"] ?? "").toLowerCase();
        if (ct.startsWith("application/x-www-form-urlencoded")) {
          const f = new URLSearchParams(text);
          input = { type: f.get("type") ?? undefined, token_hash: f.get("token_hash") ?? undefined };
        } else {
          try {
            const j = JSON.parse(text);
            input = j && typeof j === "object" && !Array.isArray(j) ? j : {};
          } catch {
            input = {};
          }
        }
        let location: string;
        try {
          location = broker.callbackResultFragment(await broker.confirmSignup(brokerDeps, ctx, input));
        } catch (e) {
          if (!(e instanceof SiteAuthError)) throw e;
          location = `/auth/confirm#type=signup&error=${e.code}`;
        }
        redirect(location);
        return;
      }
      if (getFn) {
        const q = new URLSearchParams(query);
        const input: Record<string, string> = {};
        for (const [k, v] of q) {
          if (has(input, k)) {
            fail(400, "bad_request", "The request is not valid.");
            return;
          }
          input[k] = v;
        }
        if (Object.keys(input).some((k) => k !== "limit" && k !== "cursor")) {
          fail(400, "bad_request", "The request is not valid.");
          return;
        }
        res.status(200).json({ data: await getFn(brokerDeps, ctx, input, req.headers.authorization) });
        return;
      }
      let body: unknown = {};
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          fail(400, "bad_request", "The request is not valid.");
          return;
        }
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        fail(400, "bad_request", "The request is not valid.");
        return;
      }
      const data = await fn!(brokerDeps, ctx, body, req.headers.authorization);
      res.status(200).json({ data });
    } catch (e) {
      if (e instanceof SiteAuthError) {
        if (e.status === 429) res.setHeader("Retry-After", "60");
        fail(e.status, e.code, e.message);
        return;
      }
      deps.log?.(`[site-auth] ${action} failed (${requestId}): ${(e as Error).message}`);
      fail(503, "unavailable", "Something went wrong. Try again.");
    }
  };
}

export const siteAuthRoute = createSiteAuthHandler({
  broker: defaultBrokerDeps,
  gatewaySecret: () => process.env.SITE_GATEWAY_BROKER_SECRET,
  now: () => Date.now(),
  log: (m) => console.warn(m),
});
