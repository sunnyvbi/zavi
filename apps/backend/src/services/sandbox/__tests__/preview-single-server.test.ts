import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreviewBootScript, parsePreviewResult } from "../preview";

const FAKE_NEXT = `#!/usr/bin/env node
const http = require("http"), fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const at = args.indexOf("-p");
const pinned = at >= 0;
const dir = process.cwd();
function start(port) {
  const server = http.createServer((req, res) => {
    if (fs.existsSync(path.join(dir, ".next", "BUILD_ID"))) {
      res.writeHead(500);
      res.end("Error: Cannot find module './948.js'");
      return;
    }
    res.writeHead(fs.existsSync(path.join(dir, "BROKEN-" + process.pid)) ? 404 : 200);
    res.end("srv-" + process.pid);
  });
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && !pinned) start(port + 1);
    else process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => fs.appendFileSync(path.join(dir, "servers.log"), process.pid + " " + port + "\\n"));
}
start(pinned ? Number(args[at + 1]) : Number(process.env.FAKE_BASE_PORT));
`;

const SETSID_SHIM = `#!/bin/sh
exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' "$@"
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("buildPreviewBootScript run twice on one sandbox", () => {
  let root: string;
  let repo: string;
  let bin: string;
  let port: number;

  const servers = () =>
    (existsSync(join(repo, "servers.log")) ? readFileSync(join(repo, "servers.log"), "utf-8") : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [pid, p] = l.split(" ").map(Number);
        return { pid, port: p };
      });
  const running = () => servers().filter((s) => alive(s.pid));
  const settle = () => new Promise((r) => setTimeout(r, 5000));

  const boot = () => {
    const script = buildPreviewBootScript({ port, repo_dir: repo, boot_timeout_seconds: 20 });
    const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, FAKE_BASE_PORT: String(port), PATH: `${hasSetsid ? "" : `${bin}:`}${process.env.PATH}` },
    });
    return parsePreviewResult(r.stdout);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "preview-single-"));
    repo = join(root, "repo");
    bin = join(root, "bin");
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fake-app", private: true, scripts: { dev: "next dev" }, dependencies: { next: "14.2.35" } }),
    );
    writeFileSync(join(repo, "node_modules", ".bin", "next"), FAKE_NEXT);
    chmodSync(join(repo, "node_modules", ".bin", "next"), 0o755);
    writeFileSync(join(bin, "setsid"), SETSID_SHIM);
    chmodSync(join(bin, "setsid"), 0o755);
    port = await freePort();
  });

  afterEach(() => {
    for (const s of servers()) {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {}
    }
    const pgidFile = spawnSync("bash", ["-c", `printf '%s' ${JSON.stringify(repo)} | cksum | awk '{print $1}'`], { encoding: "utf-8" }).stdout.trim();
    rmSync(`/tmp/zavi-preview-${pgidFile}.pgid`, { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps one dev server on the requested port when a second boot finds it healthy", async () => {
    const first = boot();
    expect(first).toMatchObject({ ready: true, port });
    const [original] = running();

    const second = boot();
    await settle();

    expect(second).toMatchObject({ ready: true, port });
    expect(running()).toEqual([{ pid: original.pid, port }]);
    expect(servers()).toHaveLength(1);
  }, 90_000);

  it("replaces a dev server that stopped serving the page, on the same port, and leaves no second server", async () => {
    boot();
    const [stale] = running();
    writeFileSync(join(repo, `BROKEN-${stale.pid}`), "");

    const second = boot();
    await settle();

    expect(second).toMatchObject({ ready: true, port });
    expect(alive(stale.pid)).toBe(false);
    const now = running();
    expect(now).toHaveLength(1);
    expect(now[0].pid).not.toBe(stale.pid);
    expect(now[0].port).toBe(port);
    const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    expect(body).toBe(`srv-${now[0].pid}`);
  }, 90_000);

  it("recovers a dev server whose .next was overwritten by a production next build", async () => {
    boot();
    const [stale] = running();
    mkdirSync(join(repo, ".next", "server"), { recursive: true });
    writeFileSync(join(repo, ".next", "BUILD_ID"), "prod-build");
    writeFileSync(join(repo, ".next", "server", "webpack-runtime.js"), "require('./948.js')");
    expect(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status)).toBe(500);

    const second = boot();
    await settle();

    expect(second).toMatchObject({ ready: true, port });
    expect(alive(stale.pid)).toBe(false);
    expect(existsSync(join(repo, ".next", "BUILD_ID"))).toBe(false);
    const now = running();
    expect(now).toHaveLength(1);
    const reply = await fetch(`http://127.0.0.1:${port}/`);
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe(`srv-${now[0].pid}`);
  }, 90_000);

  it("keeps the production build of an app that boots with next start", async () => {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fake-app", private: true, scripts: { start: "next start" }, dependencies: { next: "14.2.35" } }),
    );
    mkdirSync(join(repo, ".next"), { recursive: true });
    writeFileSync(join(repo, ".next", "BUILD_ID"), "prod-build");
    boot();
    expect(existsSync(join(repo, ".next", "BUILD_ID"))).toBe(true);
  }, 90_000);

  it("leaves a dev-only .next alone, so a healthy restart keeps its compile cache", async () => {
    mkdirSync(join(repo, ".next", "cache"), { recursive: true });
    writeFileSync(join(repo, ".next", "cache", "keep"), "x");
    const first = boot();
    expect(first).toMatchObject({ ready: true, port });
    expect(existsSync(join(repo, ".next", "cache", "keep"))).toBe(true);
  }, 90_000);
});
