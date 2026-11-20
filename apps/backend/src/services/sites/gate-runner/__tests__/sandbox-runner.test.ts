import { describe, it, expect, vi } from "vitest";
import { createE2bGateRunner } from "../sandbox-runner";

const LINK = "https://s.zaviagent.com/api/auth/callback?type=magiclink&token_hash=ownertokenhash123456";

function deps(opts: { execThrows?: boolean } = {}) {
  const order: string[] = [];
  const create = vi.fn(async (_a: { tenant_id: string; repo_full_name: string; template?: string }) => {
    order.push("create");
    return "sbx-gate-1";
  });
  const write = vi.fn(async (_id: string, path: string, _c: string) => {
    order.push(`write ${path}`);
  });
  const exec = vi.fn(async (_id: string, _cmd: string, _t?: number, _o?: { env?: Record<string, string>; redact?: string[] }) => {
    order.push("exec");
    if (opts.execThrows) throw new Error("boom");
    return { exit_code: 0, stdout: "{}", stderr: "", ms: 1 };
  });
  const destroy = vi.fn(async (_id: string) => {
    order.push("destroy");
  });
  return { order, create, write, exec, destroy };
}

const input = {
  tenant_id: "t1",
  site_id: "s1",
  files: { "/home/user/zavi-gate/runner.cjs": "// runner", "/home/user/zavi-gate/config.json": "{}" },
  command: "node /home/user/zavi-gate/runner.cjs /home/user/zavi-gate/config.json",
  env: { GATE_BASE_URL: "https://s.zaviagent.com/__zavi_preview/x/?t=sig12345678", GATE_OWNER_LINK: LINK },
  redact: [LINK],
  timeoutMs: 1000,
};

describe("createE2bGateRunner", () => {
  it("creates a FRESH platform sandbox, writes only the given files, passes secrets only as env, then destroys it", async () => {
    const d = deps();
    const run = createE2bGateRunner(d as never);
    await run(input);
    expect(d.order).toEqual(["create", "write /home/user/zavi-gate/runner.cjs", "write /home/user/zavi-gate/config.json", "exec", "destroy"]);
    expect(d.create.mock.calls[0][0]).toEqual({ tenant_id: "t1", repo_full_name: "site-gate:s1", template: "praxis-qa" });
    const [id, cmd, timeout, opts] = d.exec.mock.calls[0];
    expect(id).toBe("sbx-gate-1");
    expect(cmd).not.toContain("token_hash");
    expect(timeout).toBe(1000);
    expect(opts?.env).toEqual({ NODE_PATH: "/home/user/qa/node_modules", ...input.env });
    expect(opts?.redact).toEqual([LINK]);
    for (const c of d.write.mock.calls) expect(c[2]).not.toContain("ownertokenhash");
  });

  it("destroys the sandbox when the run throws", async () => {
    const d = deps({ execThrows: true });
    await expect(createE2bGateRunner(d as never)(input)).rejects.toThrow("boom");
    expect(d.destroy).toHaveBeenCalledWith("sbx-gate-1");
  });
});
