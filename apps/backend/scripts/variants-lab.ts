#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import fs, { readFileSync, existsSync } from "node:fs";
import { mkdir, appendFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import {
  applyProdAppKeys,
  parseEnvKeys,
  PROD_APP_KEYS,
  supabaseProjectRef,
} from "../src/services/agents/variants-lab/lab-env";
import {
  blockSendgridClient,
  LAB_DELETED_OUTBOUND_ENV,
  makeLabGuardedFetch,
} from "../src/services/agents/variants-lab/lab-db-guard";

const PROD_REF = "wmycgyjsenvgtczlupoe";
const PORT = Number(process.env.VARIANTS_LAB_PORT) || 3010;
const HOST = "127.0.0.1";
const LAB_AGENTS: readonly string[] = [
  "operator",
  "cgo",
  ...fs.readdirSync(path.resolve(__dirname, "..", "src", "channels"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(path.resolve(__dirname, "..", "src", "channels", d.name, "recipe.md")))
    .map((d) => d.name)
    .sort(),
];
const BACKEND_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(os.homedir(), ".zavi", "variants-runs");

function die(msg: string): never {
  console.error(`[variants-lab] ${msg}`);
  process.exit(1);
}

function keychain(service: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-a", os.userInfo().username, "-s", service, "-w"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function prodCredentials(): { url: string; key: string; anon?: string; source: string } {
  const file = path.join(os.homedir(), ".zavi", "prodqa.env");
  if (existsSync(file)) {
    const kv = parseEnvKeys(readFileSync(file, "utf-8"), ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]);
    if (kv.SUPABASE_URL && kv.SUPABASE_SERVICE_ROLE_KEY) {
      return { url: kv.SUPABASE_URL, key: kv.SUPABASE_SERVICE_ROLE_KEY, anon: kv.SUPABASE_ANON_KEY, source: "~/.zavi/prodqa.env" };
    }
  }
  const url = keychain("zavi-variants-prod-url");
  const key = keychain("zavi-variants-prod-service-role");
  if (url && key) return { url, key, source: "Keychain (zavi-variants-prod-*)" };
  die(
    "no prod credentials. Put SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in ~/.zavi/prodqa.env, or add:\n" +
      '  security add-generic-password -a "$USER" -s zavi-variants-prod-url -w "https://' + PROD_REF + '.supabase.co"\n' +
      '  security add-generic-password -a "$USER" -s zavi-variants-prod-service-role -w "<service-role key>"',
  );
}

const envFile = path.join(BACKEND_DIR, ".env");
if (existsSync(envFile)) dotenv.config({ path: envFile });
else console.warn(`[variants-lab] no ${envFile}; model and connector keys must already be in the environment`);
if (process.env.NODE_ENV === "production") die("refusing to run with NODE_ENV=production");
const creds = prodCredentials();
if (supabaseProjectRef(creds.url) !== PROD_REF) die(`credentials from ${creds.source} are not the prod project (${PROD_REF})`);
process.env.SUPABASE_URL = creds.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = creds.key;
if (creds.anon) process.env.SUPABASE_ANON_KEY = creds.anon;
else delete process.env.SUPABASE_ANON_KEY;
{
  const prodFile = path.join(os.homedir(), ".zavi", "prodqa.env");
  const prodKeys = existsSync(prodFile) ? parseEnvKeys(readFileSync(prodFile, "utf-8"), PROD_APP_KEYS) : {};
  const { from_prod, still_staging } = applyProdAppKeys(process.env, prodKeys);
  console.log(`[variants-lab] ${from_prod.length} app key(s) from prod`);
  if (still_staging.length) {
    console.warn(
      `[variants-lab] WARNING: still the local .env (staging) value, add to ~/.zavi/prodqa.env: ${still_staging.join(", ")}`,
    );
  }
}
globalThis.fetch = makeLabGuardedFetch({ supabaseUrl: creds.url, baseFetch: globalThis.fetch.bind(globalThis) });
process.env.PRAXIS_VARIANTS_LAB = "1";
for (const k of LAB_DELETED_OUTBOUND_ENV) delete process.env[k];
delete process.env.INNGEST_EVENT_KEY;
delete process.env.INNGEST_SIGNING_KEY;
delete process.env.INNGEST_DEV;
console.log(`[variants-lab] prod project ${PROD_REF}, credentials from ${creds.source}`);

async function main() {
  const sendgridClient = (await import("@sendgrid/client")) as unknown as { Client?: { prototype: { request: unknown } }; default?: { Client: { prototype: { request: unknown } } } };
  blockSendgridClient((sendgridClient.Client ?? sendgridClient.default!.Client)!);
  const express = (await import("express")).default;
  const { serviceClient } = await import("../src/services/supabase");
  const lab = await import("../src/services/agents/variants-lab/run-variants");
  const { pickVariant } = await import("../src/services/agents/variants-lab/pick");
  const { loadFileVariants } = await import("../src/services/agents/variants-lab/file-variants");

  const sb = serviceClient();
  const cards = lab;
  const store = await cards.checkLabCardStore(sb);
  cards.setLabCardStoreStatus(store);
  if (store.ok) console.log("[variants-lab] lab card store matches prod: channel columns show real cards");
  else {
    console.warn("[variants-lab] lab card store does NOT match prod, card step OFF:");
    for (const p of store.problems) console.warn(`  - ${p}`);
    console.warn(
      "  fix: a real card table or record_channel_run_actions changed (or the lab migration is not deployed yet).\n" +
        "  Add a migration that recreates the lab copies the way 20261026120000_lab_card_store.sql does, then deploy.",
    );
  }
  const runDeps = await lab.defaultRunVariantsDeps(sb);
  const page = readFileSync(path.join(__dirname, "variants-lab.html"), "utf-8").replace(
    "<option>operator</option><option>cgo</option>",
    LAB_AGENTS.map((a) => `<option>${a}</option>`).join(""),
  );

  const app = express();
  const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!allowedHosts.has(String(req.headers.host)) || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, "")))) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "30mb" }));

  async function tenantBySlug(slug: unknown): Promise<{ id: string; slug: string; display_name: string }> {
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new lab.LabInputError("tenant not found");
    const { data, error } = await sb.from("tenants").select("id, slug, display_name").eq("slug", slug).limit(1);
    if (error) throw new Error(`tenant read failed: ${error.message}`);
    const t = (data ?? [])[0] as { id: string; slug: string; display_name: string } | undefined;
    if (!t) throw new lab.LabInputError("tenant not found");
    return t;
  }

  function agentOf(a: unknown): string {
    if (!LAB_AGENTS.includes(a as never)) throw new lab.LabInputError(`agent must be one of ${LAB_AGENTS.join(", ")}`);
    return a as string;
  }

  const handle =
    (fn: (req: import("express").Request) => Promise<unknown>) =>
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        res.json(await fn(req));
      } catch (e) {
        const err = e as Error;
        const user = err instanceof lab.LabInputError;
        if (!user) console.error(`[variants-lab] ${err.message}`);
        res.status(user ? 400 : 500).json({ error: err.message });
      }
    };

  app.get("/", (_req, res) => {
    res.type("html").send(page);
  });

  app.get(
    "/variants/options",
    handle(async (req) => {
      const tenant = await tenantBySlug(req.query.tenant);
      const agent = agentOf(req.query.agent ?? "operator");
      const variants = await sb
        .from("agent_engine_variants")
        .select("slug, label, config, note")
        .order("slug")
        .limit(100);
      if (variants.error) throw new Error(`variant read failed: ${variants.error.message}`);
      const files = loadFileVariants(agent);
      const fileNames = new Set(files.map((f) => f.slug));
      return {
        tenant,
        agent,
        agents: LAB_AGENTS,
        variants: [
          ...files.map((f) => ({ slug: f.slug, label: f.label, source: "local", config: f.config ?? null, error: f.error })),
          ...((variants.data ?? []) as Array<{ slug: string; label: string; config: unknown; note: string | null }>).map((r) => ({
            ...r,
            source: "prod",
            ...(fileNames.has(r.slug) ? { shadowed: true } : {}),
          })),
        ],
        max: lab.MAX_LAB_VARIANTS,
      };
    }),
  );

  app.post(
    "/variants/run",
    handle(async (req) => {
      const b = (req.body ?? {}) as { tenant?: unknown; agent?: unknown; variants?: unknown; input?: unknown };
      const tenant = await tenantBySlug(b.tenant);
      const agentSlug = agentOf(b.agent);
      if (!Array.isArray(b.variants) || !b.variants.every((v) => typeof v === "string")) {
        throw new lab.LabInputError("variants must be a list of slugs");
      }
      const result = await lab.runVariants({
        tenantId: tenant.id,
        agentSlug,
        input: b.input as import("../src/services/agents/variants-lab/run-variants").LabInput,
        variantSlugs: b.variants as string[],
        deps: runDeps,
      });
      return { ...result, tenant_slug: tenant.slug };
    }),
  );

  app.post(
    "/variants/pick",
    handle(async (req) => {
      const b = (req.body ?? {}) as { tenant?: unknown; agent?: unknown; variant?: unknown; note?: unknown; record?: unknown };
      const tenant = await tenantBySlug(b.tenant);
      const agentSlug = agentOf(b.agent);
      if (typeof b.variant !== "string") throw new lab.LabInputError("variant is required");
      return pickVariant(
        {
          tenantId: tenant.id,
          agentSlug,
          variantSlug: b.variant,
          note: typeof b.note === "string" ? b.note.slice(0, 4000) : "",
          record: b.record ?? null,
        },
        {
          sb,
          runsDir: RUNS_DIR,
          fileVariants: loadFileVariants(agentSlug),
          appendLine: async (file, line) => {
            await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await chmod(path.dirname(file), 0o700);
            await appendFile(file, line + "\n", { encoding: "utf-8", mode: 0o600 });
            await chmod(file, 0o600);
          },
        },
      );
    }),
  );

  app.listen(PORT, HOST, () => {
    console.log(`[variants-lab] http://${HOST}:${PORT}  (Ctrl-C to stop)`);
  });
}

main().catch((e) => die((e as Error).message));
