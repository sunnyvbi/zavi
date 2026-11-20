
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("../e2b-client", () => ({
  execCommand: vi.fn(),
  getSandboxHost: vi.fn(),
}));

import { execCommand, getSandboxHost } from "../e2b-client";
import {
  buildPreviewBootScript,
  buildPreviewDeadReason,
  parsePreviewBooted,
  parsePreviewResult,
  parseExplicitPort,
  previewEnabled,
  startPreviewServer,
  PreviewBootError,
  PREVIEW_DEFAULT_PORT,
} from "../preview";

const execMock = vi.mocked(execCommand);
const hostMock = vi.mocked(getSandboxHost);

describe("previewEnabled — kill-switch (default ON, matches reaper pattern)", () => {
  const orig = process.env.INSTANT_PREVIEW_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.INSTANT_PREVIEW_ENABLED;
    else process.env.INSTANT_PREVIEW_ENABLED = orig;
  });

  it("is ON when unset (default-on)", () => {
    delete process.env.INSTANT_PREVIEW_ENABLED;
    expect(previewEnabled()).toBe(true);
  });
  it("is OFF only for explicit '0'", () => {
    process.env.INSTANT_PREVIEW_ENABLED = "0";
    expect(previewEnabled()).toBe(false);
  });
  it("is ON for any non-'0' value (1/true/yes/on)", () => {
    for (const v of ["1", "true", "yes", "on", "2", ""]) {
      process.env.INSTANT_PREVIEW_ENABLED = v;
      expect(previewEnabled()).toBe(true);
    }
  });
});

describe("buildPreviewBootScript — pure boot script", () => {
  describe("readiness verdict (the poll loop run in bash with a fake curl)", () => {
    function verdict(codes: Record<string, string>): string {
      const s = buildPreviewBootScript({ port: 3000, boot_timeout_seconds: 1 });
      const loop = s.slice(s.indexOf("READY=0"), s.lastIndexOf("fi") + 2);
      const fakeCurl = `curl() { for a in "$@"; do case "$a" in http://127.0.0.1:*) p="\${a#http://127.0.0.1:}"; p="\${p%/}";; esac; done; case "$p" in ${Object.entries(
        codes,
      )
        .map(([port, code]) => `${port}) printf '${code}';;`)
        .join(" ")} *) printf '000';; esac; }`;
      const out = execFileSync("bash", ["-c", `${fakeCurl}\nsleep() { :; }\nPORTS='3000 5173'\n${loop}`], { encoding: "utf8" });
      return out.trim();
    }

    it("the app's own port answering only 500 is server_error", () => {
      expect(verdict({ "3000": "500" })).toContain("boot_timeout:server_error");
    });

    it("nothing bound, or only ANOTHER port answering 404, is still port_unbound", () => {
      expect(verdict({})).toContain("boot_timeout:port_unbound");
      expect(verdict({ "5173": "404" })).toContain("boot_timeout:port_unbound");
    });

    it("a 2xx on any candidate port is ready on that port", () => {
      expect(verdict({ "3000": "500", "5173": "200" })).toContain('"ready":1,"port":5173');
    });
  });

  it("uses setsid + nohup so the dev-server survives the exec returning", () => {
    const s = buildPreviewBootScript({ port: 3000 });
    expect(s).toMatch(/setsid nohup bash -c "\$BOOT_CMD"/);
    expect(s).toMatch(/BOOT_CMD="\$START_CMD"/);
  });

  it("OMITS teardown — never kills the process group it just started (unlike app-verify)", () => {
    const s = buildPreviewBootScript({ port: 3000 });
    const afterLaunch = s.slice(s.indexOf(`setsid nohup bash -c "$BOOT_CMD"`));
    expect(afterLaunch).not.toMatch(/kill -TERM/);
    expect(afterLaunch).not.toMatch(/kill -KILL/);
  });

  it("detects a root start command (dev → start → server) and runs at repo_dir", () => {
    const s = buildPreviewBootScript({ repo_dir: "/home/user/repo" });
    expect(s).toMatch(/ROOT_SCRIPT="\$\(__root_script "\$ROOT"\)"/);
    expect(s).toMatch(/RUN_DIR="\$ROOT"; START_CMD="npm run \$ROOT_SCRIPT"/);
    expect(s).toMatch(/\['dev','start','server'\]/);
    expect(s).toMatch(/ROOT='\/home\/user\/repo'/);
  });

  it("targets apps/web for a workspaces monorepo with no root dev script", () => {
    const s = buildPreviewBootScript({});
    expect(s).toMatch(/elif __has_workspaces "\$ROOT" \|\| \[ -d "\$ROOT\/apps" \]; then/);
    expect(s).toMatch(/if \[ -f "\$ROOT\/apps\/web\/package\.json" \] && __ws_has_dev "\$ROOT\/apps\/web"; then/);
    expect(s).toMatch(/RUN_DIR="\$ROOT\/apps\/web"/);
    expect(s).toMatch(/for __base in apps packages; do/);
    expect(s).toMatch(/__ws_is_web "\$__d"/);
    expect(s).toMatch(/'next','vite','react-scripts','remix','@remix-run\/dev','astro'/);
    expect(s).toMatch(/cd "\$RUN_DIR"/);
  });

  it("resolves an explicit port from `next dev -p 3001`", () => {
    const s = buildPreviewBootScript({ start_cmd: "next dev -p 3001" });
    expect(s).toMatch(/PORTS='3001'/);
    expect(s).toMatch(/START_CMD='next dev -p 3001'/);
  });
  it("resolves --port=N and leading PORT=N forms", () => {
    expect(buildPreviewBootScript({ start_cmd: "vite --port=5174" })).toMatch(/PORTS='5174'/);
    expect(buildPreviewBootScript({ start_cmd: "PORT=8081 npm run dev" })).toMatch(/PORTS='8081'/);
  });

  it("includes the candidate-port poll set when no port is pinned", () => {
    const s = buildPreviewBootScript({});
    expect(s).toMatch(/PORTS='3000 3001 5173 4321 8080 4000 5000'/);
    expect(s).toMatch(/for p in \$PORTS; do/);
    expect(s).toMatch(/http:\/\/127\.0\.0\.1:\$p\//);
    expect(s).toMatch(/BOUND_PORT="\$p"/);
  });

  it("puts a custom requested port first in the candidate set (deduped)", () => {
    const s = buildPreviewBootScript({ port: 5173 });
    expect(s).toMatch(/PORTS='5173 3000 3001 4321 8080 4000 5000'/);
  });

  it("uses an explicit start_cmd verbatim when supplied (no root detection)", () => {
    const s = buildPreviewBootScript({ start_cmd: "pnpm dev" });
    expect(s).toMatch(/START_CMD='pnpm dev'/);
    expect(s).not.toMatch(/__root_script/);
  });

  it("polls for the requested number of seconds", () => {
    const s = buildPreviewBootScript({ port: 5173, boot_timeout_seconds: 42 });
    expect(s).toMatch(/for i in \$\(seq 1 42\)/);
  });

  it("opt-in npm install only when allow_npm_install is set", () => {
    const off = buildPreviewBootScript({ repo_dir: "/home/user/preview-x" });
    expect(off).not.toMatch(/npm install/);
    const on = buildPreviewBootScript({
      repo_dir: "/home/user/preview-x",
      allow_npm_install: true,
    });
    expect(on).toMatch(/timeout 240 npm install --prefer-offline --no-audit --no-fund/);
    expect(on).toMatch(/if \[ ! -e "\$RUN_DIR\/node_modules" \] && \[ ! -e "\$ROOT\/node_modules" \]; then/);
  });

  it("emits a shared-ROOT re-hydrate guard when shared_root is set (self-heals drift)", () => {
    const s = buildPreviewBootScript({
      repo_dir: "/home/user/preview-x",
      shared_root: "/home/user/repo",
      install_timeout_s: 600,
    });
    expect(s).toContain(
      "if [ ! -d '/home/user/repo'/node_modules ] && [ -f '/home/user/repo'/package.json ]; then",
    );
    expect(s).toMatch(/cd '\/home\/user\/repo' && timeout 600 npm ci --prefer-offline --no-audit --no-fund/);
    expect(s).toMatch(/cd '\/home\/user\/repo' && timeout 600 npm install --prefer-offline --no-audit --no-fund/);
  });

  it("OMITS the re-hydrate block on the product-builder path (no shared_root) — unchanged", () => {
    const s = buildPreviewBootScript({ repo_dir: "/home/user/repo" });
    expect(s).not.toContain("re-hydrate");
    expect(s).not.toContain("npm ci");
    expect(s).not.toMatch(/node_modules \] && \[ -f .*package\.json \]/);
  });

  it("cd's into ROOT and emits a not-ready sentinel (reason) if it's missing", () => {
    const s = buildPreviewBootScript({ repo_dir: "/home/user/repo" });
    expect(s).toMatch(/ROOT='\/home\/user\/repo'/);
    expect(s).toMatch(/cd "\$ROOT"/);
    expect(s).toMatch(/__PREVIEW__\{"ready":0,"port":0,"reason":"no_repo_dir"\}/);
    expect(s).toMatch(/__PREVIEW__\{"ready":0,"port":0,"reason":"no_runnable_web_app"\}/);
  });
});

describe("parseExplicitPort", () => {
  it("parses -p / --port / --port= / PORT= forms", () => {
    expect(parseExplicitPort("next dev -p 3001")).toBe(3001);
    expect(parseExplicitPort("next dev --port 4321")).toBe(4321);
    expect(parseExplicitPort("vite --port=5174")).toBe(5174);
    expect(parseExplicitPort("PORT=8081 npm run dev")).toBe(8081);
  });
  it("returns null when no port is pinned", () => {
    expect(parseExplicitPort("npm run dev")).toBeNull();
    expect(parseExplicitPort("next dev")).toBeNull();
  });
});

describe("parsePreviewResult — sentinel parser (ready + bound port)", () => {
  it("returns the bound port when ready", () => {
    expect(parsePreviewResult('__PREVIEW__{"ready":1,"port":5173}\n')).toEqual({
      ready: true,
      port: 5173,
    });
  });
  it("port 0 when not ready (carries the reason on the failure path)", () => {
    expect(
      parsePreviewResult('__PREVIEW__{"ready":0,"port":0,"reason":"no_runnable_web_app"}'),
    ).toMatchObject({ ready: false, port: 0, reason: "no_runnable_web_app" });
  });
  it("ready with a missing/zero port falls back to 0 (caller uses requested port)", () => {
    expect(parsePreviewResult('__PREVIEW__{"ready":1,"port":0}')).toEqual({ ready: true, port: 0 });
  });
});

describe("parsePreviewBooted — sentinel parser", () => {
  it("true when ready:1", () => {
    expect(parsePreviewBooted('foo\n__PREVIEW__{"ready":1,"port":3000}\n')).toBe(true);
  });
  it("false when ready:0", () => {
    expect(parsePreviewBooted('__PREVIEW__{"ready":0,"port":3000}')).toBe(false);
  });
  it("false when no sentinel present", () => {
    expect(parsePreviewBooted("npm run dev started but no sentinel")).toBe(false);
  });
  it("false on malformed sentinel JSON", () => {
    expect(parsePreviewBooted("__PREVIEW__{not json}")).toBe(false);
  });
});

describe("startPreviewServer", () => {
  beforeEach(() => {
    execMock.mockReset();
    hostMock.mockReset();
    process.env.INSTANT_PREVIEW_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.INSTANT_PREVIEW_ENABLED;
  });

  it("throws (no boot, no URL) when the kill-switch is off", async () => {
    process.env.INSTANT_PREVIEW_ENABLED = "0";
    await expect(startPreviewServer("sb-1")).rejects.toThrow(/disabled/);
    expect(execMock).not.toHaveBeenCalled();
    expect(hostMock).not.toHaveBeenCalled();
  });

  it("resolves {url,port} when the dev-server reports ready", async () => {
    execMock.mockResolvedValue({
      stdout: '__PREVIEW__{"ready":1,"port":3000}\n',
      stderr: "",
      exit_code: 0,
      ms: 1200,
    });
    hostMock.mockResolvedValue("https://3000-abc123.e2b.app");
    const r = await startPreviewServer("sb-1");
    expect(r).toEqual({ url: "https://3000-abc123.e2b.app", port: PREVIEW_DEFAULT_PORT });
    expect(hostMock).toHaveBeenCalledWith("sb-1", 3000);
  });

  it("resolves getHost for the ACTUAL bound port from the sentinel (monorepo non-3000)", async () => {
    execMock.mockResolvedValue({
      stdout: '__PREVIEW__{"ready":1,"port":5173}\n',
      stderr: "",
      exit_code: 0,
      ms: 1200,
    });
    hostMock.mockResolvedValue("https://5173-abc123.e2b.app");
    const r = await startPreviewServer("sb-1", PREVIEW_DEFAULT_PORT);
    expect(r).toEqual({ url: "https://5173-abc123.e2b.app", port: 5173 });
    expect(hostMock).toHaveBeenCalledWith("sb-1", 5173);
  });

  it("throws and never resolves a URL when the boot times out (ready:0)", async () => {
    execMock.mockResolvedValue({
      stdout: '__PREVIEW__{"ready":0,"port":3000}\n',
      stderr: "",
      exit_code: 0,
      ms: 90000,
    });
    await expect(startPreviewServer("sb-1")).rejects.toThrow(/did not serve a 2xx/);
    expect(hostMock).not.toHaveBeenCalled();
  });

  it("throws a PreviewBootError carrying the BOUNDED sentinel reason, no raw log (SLICE 3)", async () => {
    execMock.mockResolvedValue({
      stdout: '__PREVIEW__{"ready":0,"port":0,"reason":"boot_timeout:port_unbound"}\n',
      stderr: "",
      exit_code: 0,
      ms: 45000,
    });
    const err = await startPreviewServer("sb-1").catch((e) => e);
    expect(err).toBeInstanceOf(PreviewBootError);
    expect((err as PreviewBootError).deadReason).toBe("boot_timeout:port_unbound");
  });
});

describe("SLICE 2 — direct dev-server boot (bypass a lint/build preflix; no false-positive)", () => {
  it("runs `next dev` directly when the dev script chains `lint &&` BEFORE it", () => {
    const s = buildPreviewBootScript({
      repo_dir: "/home/user/preview-r1",
      shared_root: "/home/user/repo",
      start_cmd: "next lint && next dev",
    });
    expect(s).toMatch(/PREFLIX=/);
    expect(s).toMatch(/grep -oE '\^\[\^&\]\*&&'/);
    expect(s).toMatch(/next\) BOOT_CMD="npx --no-install next dev -p \$PORT_PRIMARY"/);
    expect(s).toMatch(/setsid nohup bash -c "\$BOOT_CMD"/);
    expect(s).toMatch(/RUN_DIR="\$RUN_DIR" node -e/);
  });

  it("keeps `npm run dev` for a clean dev script (no preflix) — BOOT_CMD defaults to START_CMD", () => {
    const s = buildPreviewBootScript({ start_cmd: "next dev -p 3001" });
    expect(s).toMatch(/BOOT_CMD="\$START_CMD"/);
  });

  it.each([
    ["next lint && next dev", true],
    ["tsc && vite", true],
    ["npm run build && remix dev", true],
    ["next dev && npm run build", false],
    ["vite --host 0.0.0.0 && echo done", false],
    ["next dev -p 3001", false],
  ])("PREFLIX(%s) => bypass=%s", (script, shouldBypass) => {
    const m = script.match(/^[^&]*&&/);
    const prefix = m ? m[0] : "";
    const has = /(^|\s)(lint|test|typecheck|tsc|build)(\s|&)/.test(prefix);
    expect(has).toBe(shouldBypass);
  });
});

describe("buildPreviewDeadReason — bounded token only, no free-form (SLICE 3)", () => {
  it("returns just the bounded reason, capped at 500 chars, no log field", () => {
    expect(buildPreviewDeadReason({ reason: "no_node_modules:ERESOLVE" })).toBe(
      "no_node_modules:ERESOLVE",
    );
    expect(buildPreviewDeadReason({ reason: "boot_timeout:port_unbound" })).toBe(
      "boot_timeout:port_unbound",
    );
    expect(buildPreviewDeadReason({ reason: "x".repeat(900) }).length).toBe(500);
  });
  it("falls back when no reason present", () => {
    expect(buildPreviewDeadReason({})).toBe("boot_failed");
  });
});
