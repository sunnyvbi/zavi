import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const RUNTIME_SRC = readFileSync(
  resolve(process.cwd(), "public/zavi-editor-runtime.js"),
  "utf8",
);

const PAGE = `<!doctype html><html><body><h1 class="hero">Original</h1></body></html>`;
const APP_URL = "https://create-a-web-app-b748751d.zaviagent.com/";

type Posted = Record<string, unknown>;

function frameApp(opts: { referrer?: string; from: string }) {
  const dom = new JSDOM(PAGE, {
    url: APP_URL,
    referrer: opts.referrer,
    runScripts: "outside-only",
  });
  const win = dom.window;
  const posted: Posted[] = [];
  Object.defineProperty(win, "parent", {
    value: { postMessage: (m: Posted) => posted.push(m) },
    configurable: true,
  });

  win.eval(RUNTIME_SRC);
  if (win.document.readyState === "loading") {
    win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  }

  const send = (data: Posted) =>
    win.dispatchEvent(
      new win.MessageEvent("message", { data, origin: opts.from }),
    );

  send({ type: "zavi:editor-mode", enabled: true });
  send({
    type: "zavi:editor-apply",
    selector: ".hero",
    patch: { text: "Changed" },
    reveal: true,
  });

  return {
    ready: posted.some((m) => m.type === "zavi:editor-ready"),
    heroText: win.document.querySelector(".hero")?.textContent,
  };
}

describe("zavi editor runtime — parent origin gate", () => {
  const allowed: Array<[string, string]> = [
    ["the dev server this machine actually runs", "http://localhost:3010"],
    ["the repo-default dev port", "http://localhost:3000"],
    ["the loopback IP form of the dev server", "http://127.0.0.1:3010"],
    ["a worktree dev server on another port", "http://localhost:3070"],
    ["another worktree's dev server", "http://127.0.0.1:3042"],
    ["production www", "https://www.zaviagent.com"],
    ["production apex", "https://zaviagent.com"],
    ["the development web app", "https://latest.zaviagent.com"],
    ["the staging web app", "https://staging.zaviagent.com"],
  ];

  it.each(allowed)("activates for %s", (_label, origin) => {
    const r = frameApp({ referrer: origin + "/", from: origin });
    expect(r.ready).toBe(true);
    expect(r.heroText).toBe("Changed");
  });

  const denied: Array<[string, string]> = [
    ["an unrelated site", "https://evil.example"],
    ["a host that only starts with localhost", "http://localhost.evil.example:3010"],
    ["a host that only contains localhost", "http://mylocalhost:3010"],
    ["a host that only contains the dev port", "http://evil.example:3010"],
    ["a non-loopback private host", "http://192.168.1.9:3010"],
    ["https localhost, which Zavi dev never serves", "https://localhost:3010"],
    ["any other port on this machine", "http://localhost:8080"],
    ["the bare localhost origin", "http://localhost"],
    ["a high port on loopback", "http://127.0.0.1:49152"],
    ["a port that only starts with 30", "http://localhost:30100"],
    ["a customer site on a zaviagent.com subdomain", "https://hush.zaviagent.com"],
    ["a lookalike of the staging host", "https://latest.zaviagent.com.evil.example"],
    ["a lookalike of the staging web", "https://staging.zaviagent.com.evil.example"],
    ["the staging host over plain http", "http://staging.zaviagent.com"],
  ];

  it.each(denied)("stays inert for %s", (_label, origin) => {
    const r = frameApp({ referrer: origin + "/", from: origin });
    expect(r.ready).toBe(false);
    expect(r.heroText).toBe("Original");
  });

  it("with no referrer, still answers an allowlisted dev origin", () => {
    const r = frameApp({ from: "http://localhost:3010" });
    expect(r.ready).toBe(true);
    expect(r.heroText).toBe("Changed");
  });

  it("with no referrer, ignores a message from an unlisted origin", () => {
    const r = frameApp({ from: "https://evil.example" });
    expect(r.heroText).toBe("Original");
  });
});
