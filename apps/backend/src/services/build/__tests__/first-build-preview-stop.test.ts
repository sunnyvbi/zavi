import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0, ms: 1 })),
}));

import {
  buildStopFirstBuildPreviewScript,
  hideStaleFirstBuildPreview,
} from "@/services/build/first-build-preview";

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      process.kill(-(c.pid as number), "SIGKILL");
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function bootOldDevServer(cwd: string, pidFile: string, portFile: string): ChildProcess {
  const server =
    "process.on('SIGTERM',()=>{});" +
    "require('fs').writeFileSync(process.argv[1],String(process.pid));" +
    "const s=require('http').createServer((q,r)=>{r.end('old app')}).listen(0,'127.0.0.1',()=>require('fs').writeFileSync(process.argv[2],String(s.address().port)));";
  const child = spawn("bash", ["-c", `node -e "${server}" '${pidFile}' '${portFile}' & wait`], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

describe("stopping the previous app's dev server before a first build", () => {
  it("kills the old next dev process group (even one that ignores SIGTERM) and spares everything outside the repo", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fbp-stop-")));
    dirs.push(root);
    const repo = join(root, "repo");
    const other = join(root, "elsewhere");
    const proc = join(root, "proc");
    mkdirSync(join(repo, "app"), { recursive: true });
    mkdirSync(other);
    mkdirSync(proc);

    const pidFile = join(root, "server.pid");
    const portFile = join(root, "server.port");
    const wrapper = bootOldDevServer(join(repo, "app"), pidFile, portFile);
    const bystander = spawn("sleep", ["600"], { cwd: other, detached: true, stdio: "ignore" });
    children.push(bystander);

    await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").length > 0);
    const serverPid = Number(readFileSync(pidFile, "utf8"));
    const port = Number(readFileSync(portFile, "utf8"));
    expect(await answers(port)).toBe(true);

    const fake = (pid: number, cwd: string) => {
      mkdirSync(join(proc, String(pid)));
      symlinkSync(cwd, join(proc, String(pid), "cwd"));
    };
    fake(wrapper.pid as number, join(repo, "app"));
    fake(bystander.pid as number, other);
    fake(process.pid, repo);

    const out = spawnSync("bash", ["-c", buildStopFirstBuildPreviewScript(repo, proc)], {
      cwd: "/",
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(out.stdout).toContain("__FBP__STOPPED");
    await waitFor(() => !alive(serverPid) && !alive(wrapper.pid as number));
    expect(await answers(port)).toBe(false);
    expect(alive(bystander.pid as number)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  }, 30_000);

  it("does not treat a sibling directory that shares the repo prefix as the repo", () => {
    const script = buildStopFirstBuildPreviewScript("/home/user/repo");
    expect(script).toContain(`case "$c" in "$ROOT"|"$ROOT"/*)`);
    expect(script).toContain("ROOT='/home/user/repo'");
  });
});

describe("hideStaleFirstBuildPreview stops the old server before clearing the row", () => {
  function client(row: unknown) {
    const order: string[] = [];
    const rpc = vi.fn(async (fn: string) => {
      order.push(`rpc:${fn}`);
      return { error: null };
    });
    const c = {
      from: vi.fn(() => {
        order.push("select");
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
          }),
        };
      }),
      rpc,
    };
    return { c, rpc, order };
  }

  for (const row of [
    { id: "row-1", preview_status: "live" },
    { id: "row-1", preview_status: "dead" },
    null,
  ]) {
    it(`kills the dev server in the build's sandbox when the row is ${row ? row.preview_status : "missing"}`, async () => {
      const { c, order } = client(row);
      const exec = vi.fn(async (_id: string, _cmd: string) => {
        order.push("stop");
        return { stdout: "__FBP__STOPPED\n", stderr: "", exit_code: 0, ms: 1 };
      });
      await hideStaleFirstBuildPreview("t1", "r/a", c, "sb-9", exec);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][0]).toBe("sb-9");
      expect(exec.mock.calls[0][1]).toBe(buildStopFirstBuildPreviewScript());
      expect(order[0]).toBe("stop");
    });
  }

  it("still hides the row when the stop exec throws", async () => {
    const { c, rpc } = client({ id: "row-1", preview_status: "live" });
    const exec = vi.fn(async () => {
      throw new Error("sandbox gone");
    });
    expect(await hideStaleFirstBuildPreview("t1", "r/a", c, "sb-9", exec)).toBe("hidden");
    expect(rpc).toHaveBeenCalledWith("clear_sandbox_preview", { p_id: "row-1", p_final_status: "dead" });
  });
});
