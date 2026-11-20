import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

type FakeSandbox = {
  id: string;
  n: number;
  paused: boolean;
  commands: { run: Mock<any[], any> };
  files: { write: Mock<any[], any>; read: Mock<any[], any> };
  setTimeout: Mock<any[], any>;
  betaPause: Mock<any[], any>;
  getHost: (port: number) => string;
};

const h = vi.hoisted(() => ({
  made: [] as FakeSandbox[],
  connect: null as unknown as Mock<any[], any>,
  kill: null as unknown as Mock<any[], any>,
  runImpl: null as null | ((sb: FakeSandbox, cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>),
}));

function fake(id: string): FakeSandbox {
  const sb: FakeSandbox = {
    id,
    n: h.made.length + 1,
    paused: false,
    commands: {
      run: vi.fn(async (cmd: string) => {
        if (sb.paused) throw new Error("sandbox is paused");
        return h.runImpl ? h.runImpl(sb, cmd) : { stdout: `conn=${sb.n}`, stderr: "", exitCode: 0 };
      }),
    },
    files: {
      write: vi.fn(async () => {
        if (sb.paused) throw new Error("sandbox is paused");
        return {};
      }),
      read: vi.fn(async () => `conn=${sb.n}`),
    },
    setTimeout: vi.fn(async () => undefined),
    betaPause: vi.fn(async () => {
      sb.paused = true;
    }),
    getHost: (port: number) => `${port}-${id}.e2b.app`,
  };
  h.made.push(sb);
  return sb;
}

vi.mock("e2b", () => {
  h.connect = vi.fn(async (id: string) => fake(id));
  h.kill = vi.fn(async () => true);
  return { Sandbox: { connect: (...a: unknown[]) => h.connect(...(a as [string])), kill: (...a: unknown[]) => h.kill(...a) } };
});

import {
  destroySandbox,
  execCommand,
  getSandboxHost,
  pauseSandbox,
  readFile,
  revokeSandboxGithubToken,
  setEnv,
  withSandboxSession,
  writeFile,
} from "../e2b-client";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  process.env.E2B_API_KEY = "test-key";
  h.made.length = 0;
  h.runImpl = null;
  h.connect.mockClear();
  h.kill.mockClear();
});

async function prepLikeASiteRun(id: string) {
  await setEnv(id, { GITHUB_TOKEN: "ghs_token_value_123" });
  await execCommand(id, "git clone", 1000);
  await execCommand(id, "stop+env+config", 1000);
  await getSandboxHost(id, 5173);
  await revokeSandboxGithubToken(id, { NODE_OPTIONS: "--max-old-space-size=6144" });
  await execCommand(id, "deps", 1000);
}

describe("withSandboxSession — one e2b connection per (tenant, sandbox) inside a run step", () => {
  it("a whole site prep (env, clone, stop, host, revoke, deps) connects to the sandbox ONCE", async () => {
    await withSandboxSession(T1, () => prepLikeASiteRun("sbx-a"));
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.made[0].commands.run.mock.calls.length).toBe(4);
    expect(h.made[0].files.write.mock.calls.length).toBe(2);
  });

  it("outside a session every call still connects on its own (unchanged behaviour)", async () => {
    await prepLikeASiteRun("sbx-a");
    expect(h.connect).toHaveBeenCalledTimes(7);
  });

  it("concurrent first calls share one in-flight connect", async () => {
    await withSandboxSession(T1, async () => {
      await Promise.all([execCommand("sbx-a", "a", 1000), readFile("sbx-a", "/x"), writeFile("sbx-a", "/y", "z")]);
    });
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it("two tenants' sessions never share a connection, even for the same sandbox id, even interleaved", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const a = withSandboxSession(T1, async () => {
      const first = await execCommand("sbx-same", "a1", 1000);
      await gateA;
      const second = await execCommand("sbx-same", "a2", 1000);
      return [first.stdout, second.stdout];
    });
    const b = withSandboxSession(T2, async () => {
      const r = await execCommand("sbx-same", "b1", 1000);
      releaseA();
      const r2 = await execCommand("sbx-same", "b2", 1000);
      return [r.stdout, r2.stdout];
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(new Set(ra).size).toBe(1);
    expect(new Set(rb).size).toBe(1);
    expect(ra[0]).not.toBe(rb[0]);
  });

  it("a nested session for another tenant gets its own connections; the same tenant reuses the outer one", async () => {
    await withSandboxSession(T1, async () => {
      await execCommand("sbx-a", "outer", 1000);
      await withSandboxSession(T1, () => execCommand("sbx-a", "same-tenant", 1000));
      await withSandboxSession(T2, () => execCommand("sbx-a", "other-tenant", 1000));
      await execCommand("sbx-a", "outer-again", 1000);
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("separate sandboxes in one session each get their own connection", async () => {
    await withSandboxSession(T1, async () => {
      await execCommand("sbx-a", "a", 1000);
      await execCommand("sbx-b", "b", 1000);
      await execCommand("sbx-a", "a", 1000);
    });
    expect(h.connect.mock.calls.map((c) => c[0])).toEqual(["sbx-a", "sbx-b"]);
  });

  it("a pause drops the connection: the next call reconnects (and so resumes the box)", async () => {
    await withSandboxSession(T1, async () => {
      await execCommand("sbx-a", "before", 1000);
      await pauseSandbox("sbx-a");
      const after = await execCommand("sbx-a", "after", 1000);
      expect(after.exit_code).toBe(0);
      expect(after.stdout).toBe("conn=2");
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("a kill drops the connection", async () => {
    await withSandboxSession(T1, async () => {
      await execCommand("sbx-a", "before", 1000);
      await destroySandbox("sbx-a");
      await execCommand("sbx-a", "after", 1000);
    });
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("a connection-level error drops the connection; a plain non-zero exit keeps it", async () => {
    h.runImpl = async (sb, cmd) => {
      if (cmd.includes("exit-1")) throw Object.assign(new Error("exit status 1"), { exitCode: 1, stdout: "", stderr: "boom" });
      if (cmd.includes("conn-lost") && sb.n === 1) throw new Error("socket hang up");
      return { stdout: `conn=${sb.n}`, stderr: "", exitCode: 0 };
    };
    await withSandboxSession(T1, async () => {
      const failed = await execCommand("sbx-a", "exit-1", 1000);
      expect(failed.exit_code).toBe(1);
      expect((await execCommand("sbx-a", "ok", 1000)).stdout).toBe("conn=1");
      const lost = await execCommand("sbx-a", "conn-lost", 1000);
      expect(lost.exit_code).toBe(1);
      expect((await execCommand("sbx-a", "ok", 1000)).stdout).toBe("conn=2");
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("a box paused from elsewhere: the failed file write drops the stale connection and the retry resumes", async () => {
    await withSandboxSession(T1, async () => {
      await execCommand("sbx-a", "warm", 1000);
      h.made[0].paused = true;
      await expect(writeFile("sbx-a", "/home/user/.praxis-env", "x")).rejects.toThrow(/paused/);
      await expect(writeFile("sbx-a", "/home/user/.praxis-env", "x")).resolves.toBeUndefined();
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("a failed connect is not cached", async () => {
    h.connect.mockImplementationOnce(async () => {
      throw new Error("e2b 503");
    });
    await withSandboxSession(T1, async () => {
      const r = await execCommand("sbx-a", "x", 1000).catch((e: Error) => e);
      expect(r).toBeInstanceOf(Error);
      expect((await execCommand("sbx-a", "y", 1000)).exit_code).toBe(0);
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("the cache ends with the session: a later step reconnects", async () => {
    await withSandboxSession(T1, () => execCommand("sbx-a", "step-1", 1000));
    await withSandboxSession(T1, () => execCommand("sbx-a", "step-2", 1000));
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it("refuses a session with no tenant", () => {
    expect(() => withSandboxSession("", async () => 1)).toThrow(/tenant_id required/);
  });
});
