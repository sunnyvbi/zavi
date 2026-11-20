#!/usr/bin/env tsx

import "dotenv/config";
import type express from "express";
import { createApp } from "../src/app";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;

if (!URL || !ANON) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env.");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `   (${detail})` : ""}`);
  }
}

type RouteEntry = { method: string; path: string };

function walkRoutes(app: express.Express): RouteEntry[] {
  const out: RouteEntry[] = [];
  type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    name?: string;
    regexp?: RegExp;
    handle?: { stack?: Layer[] };
  };
  const root = (app as unknown as { _router: { stack: Layer[] } })._router;
  function visit(layers: Layer[], prefix: string): void {
    for (const l of layers) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) {
          out.push({ method: m.toUpperCase(), path: prefix + l.route.path });
        }
      } else if (l.handle?.stack && l.regexp) {
        const r = l.regexp.source;
        const m = r.match(/^\^\\?\/((?:[^\\]|\\.)*?)\\\/\?\(\?=/);
        const sub = m ? "/" + m[1].replace(/\\\//g, "/").replace(/\\\./g, ".") : "";
        visit(l.handle.stack, prefix + sub);
      }
    }
  }
  visit(root.stack, "");
  return out;
}

async function getCustomerJwt(): Promise<string> {
  const email = `staff-bdy-${Date.now()}@praxis.local`;
  const password = "boundary-pw-987";

  const tmp = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await tmp.auth.signUp({ email, password });
  if (error || !data.session) {
    throw new Error(`signUp for boundary fixture failed: ${error?.message}`);
  }
  return data.session.access_token;
}

async function fetchPath(
  app: express.Express,
  method: string,
  path: string,
  token: string | null,
): Promise<number> {
  const server = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    const s = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((r) => {
              s.close(() => r());
            }),
        });
      } else {
        reject(new Error("listen returned unexpected addr"));
      }
    });
  });
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return r.status;
  } finally {
    await server.close();
  }
}

async function main(): Promise<void> {
  console.log("[staff boundary] booting app");
  const app = createApp();
  const routes = walkRoutes(app).filter((r) => r.path.startsWith("/api/staff"));
  if (routes.length === 0) {
    console.error("No /api/staff routes discovered — sub-router not mounted?");
    process.exit(1);
  }
  console.log(`[staff boundary] found ${routes.length} /api/staff routes`);

  const customerToken = await getCustomerJwt();

  const getRoutes = routes.filter((r) => r.method === "GET");

  for (const r of getRoutes) {
    const path = r.path
      .replace(":tenant_id", "00000000-0000-0000-0000-000000000000")
      .replace(":slug", "qa");

    const noTok = await fetchPath(app, r.method, path, null);
    assert(`${r.method} ${path} — no token → 401`, noTok === 401, `got=${noTok}`);

    const custTok = await fetchPath(app, r.method, path, customerToken);
    assert(
      `${r.method} ${path} — customer JWT → not 200`,
      custTok === 401 || custTok === 500,
      `got=${custTok}`,
    );
  }

  console.log("");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
});
