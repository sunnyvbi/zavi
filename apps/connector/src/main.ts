import { mkdirSync } from "node:fs";
import { request } from "node:http";
import { loadConfig, type Config } from "./config";
import { resolveKey } from "./keys";
import { Store } from "./store";
import { RulesFile } from "./rules";
import { DatabaseManager } from "./db";
import { ActivityLog } from "./activity";
import { ZaviClient } from "./client";
import { ConnectorRuntime } from "./runtime";
import { AdminAuth, ensureAdminToken, resetAdminToken } from "./admin-auth";
import { createLocalServer } from "./local/server";

function log(level: "info" | "warn" | "error", msg: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function printAdminToken(token: string): void {
  process.stdout.write(
    `\nZavi Connector admin token (shown once): ${token}\n` +
      "Open http://localhost:7801 on this machine and paste it to log in.\n" +
      "Lost it? docker exec zavi-connector node dist/main.js reset-admin-token\n\n",
  );
}

function openStore(cfg: Config) {
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const key = resolveKey(cfg);
  const store = Store.open(cfg.dataDir, key, (m) => log("info", m));
  return { key, store };
}

async function healthcheck(cfg: Config): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: cfg.port, path: "/healthz", method: "GET", timeout: 3_000, headers: { Host: `127.0.0.1:${cfg.port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? 0 : 1);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(1));
    req.end();
  });
}

async function run(cfg: Config): Promise<void> {
  const { key, store } = openStore(cfg);
  const created = ensureAdminToken(store);
  if (created) printAdminToken(created);
  if (key.source === "generated") log("warn", "The encryption key is stored in the data volume (accidental-plaintext protection only). Use a Docker secret named zavi_connector_key for real protection.");

  const rules = new RulesFile(cfg.dataDir);
  const db = new DatabaseManager(store);
  const activity = new ActivityLog(cfg.dataDir);
  activity.sweep();
  const sweep = setInterval(() => activity.sweep(), 6 * 3600 * 1000);
  sweep.unref();
  const client = new ZaviClient(cfg.api, cfg.version, () => store.read().token);
  const runtime = new ConnectorRuntime({ cfg, store, rules, db, activity, client, log });
  const auth = new AdminAuth(store);

  const server = createLocalServer({ cfg, rules, db, activity, runtime, auth, keySource: key.source, log });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.bind, () => resolve());
  });
  log("info", `Zavi Connector ${cfg.version} on "${cfg.machine}". Local page: http://localhost:${cfg.port} (listening on ${cfg.bind}).`);

  if (db.config()) void db.refresh().catch((e: Error) => log("warn", `Could not read the database structure: ${e.message}`));

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) {
      log("warn", `${sig} again: exiting now.`);
      process.exit(1);
    }
    shuttingDown = true;
    log("info", `${sig}: finishing running requests, then exiting.`);
    await runtime.stop(8_000);
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    await db.close();
    log("info", "Stopped.");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await runtime.start();
  if (runtime.status.kind === "unpaired") log("warn", "Not paired: start the connector with -e ZAVI_PAIR=<code> from Zavi.");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  const cfg = loadConfig();
  if (cmd === "healthcheck") process.exit(await healthcheck(cfg));
  if (cmd === "reset-admin-token") {
    const { store } = openStore(cfg);
    printAdminToken(resetAdminToken(store));
    process.stdout.write("Earlier sessions on the local page have ended.\n");
    return;
  }
  if (cmd !== "run") {
    process.stderr.write(`Unknown command "${cmd}". Use: run | reset-admin-token | healthcheck\n`);
    process.exit(2);
  }
  await run(cfg);
}

main().catch((e: Error) => {
  log("error", `${e.name}: ${e.message}`);
  process.exit(1);
});
