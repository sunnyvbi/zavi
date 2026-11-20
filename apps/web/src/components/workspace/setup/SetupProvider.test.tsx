// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  kind: "settings" as string,
  answers: [] as Array<{ ok: boolean; status: number; body?: unknown } | "network" | "hang">,
  opened: [] as string[],
  build: null as string | null,
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => {
    const a = h.answers.shift() ?? { ok: true, status: 200, body: { enabled: false } };
    if (a === "network") throw new Error("offline");
    if (a === "hang") return new Promise(() => {});
    return { ok: a.ok, status: a.status, json: async () => a.body ?? {} };
  }),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "t1", kind: h.kind }],
    activeTabId: "t1",
    role: h.role,
    buildSessionId: h.build,
    openBuildTab: (id: string) => h.opened.push(`build:${id}`),
    openAgentTab: async (slug: string) => {
      h.opened.push(`agent:${slug}`);
      return "t2";
    },
  }),
}));
vi.mock("../layout/shared", () => ({ useOpenStatic: () => (kind: string) => h.opened.push(kind) }));

import { SetupProvider, useSetupOptional } from "./SetupProvider";
import { SetupLoadError } from "./SetupLoadError";
import { apiFetch } from "@/lib/api";

function Probe() {
  const ctx = useSetupOptional();
  return <p data-testid="probe">{ctx ? `locked=${ctx.locked} enabled=${ctx.state ? String(ctx.state.enabled) : "unknown"}` : "none"}</p>;
}
const mount = () =>
  render(
    <SetupProvider>
      <SetupLoadError />
      <Probe />
    </SetupProvider>,
  );
const running = { enabled: true, docs: { status: "pending", files: 0, facts: 0 }, connectors: { status: "pending" }, done: false, home_seen: false, draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true } };

beforeEach(() => { h.role = "owner"; h.kind = "settings"; h.answers = []; h.opened = []; h.build = null; window.sessionStorage.clear(); });
afterEach(cleanup);

describe("SetupProvider", () => {
  it.each([["a 5xx", { ok: false, status: 503 }], ["a network error", "network"]] as const)(
    "%s keeps an owner locked (not 'off'), leaves them on the page they were on, and shows Retry",
    async (_label, answer) => {
      h.answers = [answer as never];
      mount();
      await screen.findByRole("alert");
      expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=unknown");
      await new Promise((r) => setTimeout(r, 0));
      expect(h.opened).toEqual([]);
      h.answers = [{ ok: true, status: 200, body: { enabled: false } }];
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=false enabled=false"));
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it("an explicit {enabled:false} answer unlocks", async () => {
    h.answers = [{ ok: true, status: 200, body: { enabled: false } }];
    mount();
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=false enabled=false"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("a member is never locked, even when the read fails", async () => {
    h.role = "member";
    h.answers = [{ ok: false, status: 500 }];
    mount();
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=false enabled=unknown"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(h.opened).toEqual([]);
  });
  it("a failed REFRESH keeps the last good state (a running setup stays locked)", async () => {
    h.answers = [{ ok: true, status: 200, body: running }];
    let ctx: ReturnType<typeof useSetupOptional> = null;
    function Grab() { ctx = useSetupOptional(); return null; }
    render(<SetupProvider><Grab /><Probe /></SetupProvider>);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=true"));
    h.answers = [{ ok: false, status: 502 }];
    await ctx!.refresh();
    await waitFor(() => expect(ctx!.loadError).toBe(true));
    expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=true");
  });
  describe("B10: a founder who signed up with an idea stays on the build", () => {
    const openBuild = { ...running, build_open: true };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    it("a running setup with build_open locks but never moves the founder off the Build tab", async () => {
      h.kind = "build";
      h.answers = [{ ok: true, status: 200, body: openBuild }];
      let ctx: ReturnType<typeof useSetupOptional> = null;
      function Grab() { ctx = useSetupOptional(); return null; }
      render(<SetupProvider><Grab /><Probe /></SetupProvider>);
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=true"));
      await settle();
      expect(ctx!.buildOpen).toBe(true);
      expect(h.opened).toEqual([]);
      h.answers = [{ ok: true, status: 200, body: { ...openBuild, docs: { status: "skipped", files: 0, facts: 0 } } }];
      await ctx!.mark({ step: "docs", outcome: "skipped" });
      await settle();
      expect(h.opened).toEqual([]);
    });
    it.each(["home", "settings", "website", "analytics", "channels", "build"])(
      "a running setup for an owner on %s, with a build in the tabs, opens neither Growth nor the build",
      async (kind) => {
        h.kind = kind;
        h.build = "b-1";
        for (const body of [running, openBuild]) {
          h.opened = [];
          h.answers = [{ ok: true, status: 200, body }];
          const view = render(<SetupProvider><Probe /></SetupProvider>);
          await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=true"));
          await settle();
          await settle();
          expect(h.opened).toEqual([]);
          view.unmount();
        }
      },
    );
    it("with the key off (no build_open) a running setup leaves the Build tab where it is", async () => {
      h.kind = "build";
      h.answers = [{ ok: true, status: 200, body: running }];
      let ctx: ReturnType<typeof useSetupOptional> = null;
      function Grab() { ctx = useSetupOptional(); return null; }
      render(<SetupProvider><Grab /><Probe /></SetupProvider>);
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=true"));
      await settle();
      expect(ctx!.buildOpen).toBe(false);
      expect(h.opened).toEqual([]);
    });
    it("a failed first read on a founder's open build keeps them on it, and a later key-off answer still does not move them", async () => {
      h.kind = "build";
      h.build = "b-1";
      h.answers = [{ ok: false, status: 503 }];
      let ctx: ReturnType<typeof useSetupOptional> = null;
      function Grab() { ctx = useSetupOptional(); return null; }
      render(<SetupProvider><Grab /><SetupLoadError /><Probe /></SetupProvider>);
      await waitFor(() => expect(ctx!.loadError).toBe(true));
      await settle();
      expect(ctx!.locked).toBe(true);
      expect(ctx!.buildOpen).toBe(true);
      expect(h.opened).toEqual([]);
      h.answers = [{ ok: true, status: 200, body: running }];
      await ctx!.refresh();
      await waitFor(() => expect(ctx!.buildOpen).toBe(false));
      await settle();
      expect(ctx!.locked).toBe(true);
      expect(h.opened).toEqual([]);
    });
    it("a failed first read on the build, then build_open confirmed, never moves the founder", async () => {
      h.kind = "build";
      h.build = "b-1";
      h.answers = [{ ok: false, status: 503 }, { ok: true, status: 200, body: openBuild }];
      let ctx: ReturnType<typeof useSetupOptional> = null;
      function Grab() { ctx = useSetupOptional(); return null; }
      render(<SetupProvider><Grab /><Probe /></SetupProvider>);
      await waitFor(() => expect(ctx!.loadError).toBe(true));
      await ctx!.refresh();
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=true"));
      await settle();
      expect(ctx!.buildOpen).toBe(true);
      expect(h.opened).toEqual([]);
    });
    it("a failed first read off the build keeps the owner locked without moving them, even with a build in the tabs", async () => {
      h.build = "b-1";
      h.answers = [{ ok: false, status: 503 }];
      let ctx: ReturnType<typeof useSetupOptional> = null;
      function Grab() { ctx = useSetupOptional(); return null; }
      render(<SetupProvider><Grab /><Probe /></SetupProvider>);
      await waitFor(() => expect(ctx!.loadError).toBe(true));
      await settle();
      expect(ctx!.locked).toBe(true);
      expect(ctx!.buildOpen).toBe(false);
      expect(h.opened).toEqual([]);
    });
    it("a member on the build with a failed read is neither locked nor handed an open build", async () => {
      h.role = "member";
      h.kind = "build";
      h.build = "b-1";
      h.answers = [{ ok: false, status: 503 }];
      let ctx: ReturnType<typeof useSetupOptional> = null;
      function Grab() { ctx = useSetupOptional(); return null; }
      render(<SetupProvider><Grab /><Probe /></SetupProvider>);
      await waitFor(() => expect(ctx!.loadError).toBe(true));
      expect(ctx!.locked).toBe(false);
      expect(ctx!.buildOpen).toBe(false);
      expect(h.opened).toEqual([]);
    });
    it("a failed first read on Build with no session keeps the owner locked and on Build", async () => {
      h.kind = "build";
      h.answers = [{ ok: false, status: 503 }];
      mount();
      await screen.findByRole("alert");
      await settle();
      expect(screen.getByTestId("probe").textContent).toBe("locked=true enabled=unknown");
      expect(h.opened).toEqual([]);
    });
  });

describe("SetupProvider: finishing lands in chat, and a stale read never undoes it", () => {
  const finished = {
    ...running,
    docs: { status: "skipped", files: 0, facts: 0 },
    connectors: { status: "skipped" },
    done: true,
    draft: { status: "running", run_id: "r1", attempts: 1, can_retry: false, free_retry: false },
  };
  function Driver() {
    const ctx = useSetupOptional();
    return (
      <>
        <p data-testid="probe">{`locked=${ctx?.locked} pending=${ctx?.pending}`}</p>
        <button type="button" onClick={() => void ctx?.mark({ step: "done" })}>finish</button>
        <button type="button" onClick={() => void ctx?.refresh()}>refresh</button>
      </>
    );
  }
  const mountDriver = () => render(<SetupProvider><Driver /></SetupProvider>);
  const probe = () => screen.getByTestId("probe").textContent;

  it("a refresh that answers 'not done' after Finish does not bring the setup back", async () => {
    h.kind = "autopilot";
    h.answers = [{ ok: true, status: 200, body: running }];
    mountDriver();
    await waitFor(() => expect(probe()).toBe("locked=true pending=false"));
    h.answers = [{ ok: true, status: 200, body: finished }];
    fireEvent.click(screen.getByRole("button", { name: "finish" }));
    await waitFor(() => expect(probe()).toBe("locked=false pending=false"));
    h.answers = [{ ok: true, status: 200, body: running }];
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(probe()).toBe("locked=false pending=false");
  });

  it("finishing from the Growth page under the setup opens chat", async () => {
    h.kind = "autopilot";
    h.answers = [{ ok: true, status: 200, body: running }];
    mountDriver();
    await waitFor(() => expect(probe()).toBe("locked=true pending=false"));
    h.answers = [{ ok: true, status: 200, body: finished }];
    fireEvent.click(screen.getByRole("button", { name: "finish" }));
    await waitFor(() => expect(h.opened).toContain("agent:operator"));
  });

  it("finishing while on a build stays on the build", async () => {
    h.kind = "build";
    h.answers = [{ ok: true, status: 200, body: { ...running, build_open: true } }];
    mountDriver();
    await waitFor(() => expect(probe()).toBe("locked=true pending=false"));
    h.answers = [{ ok: true, status: 200, body: { ...finished, build_open: true } }];
    fireEvent.click(screen.getByRole("button", { name: "finish" }));
    await waitFor(() => expect(probe()).toBe("locked=false pending=false"));
    expect(h.opened).not.toContain("agent:operator");
  });

  it("a workspace that was already set up does not jump to chat", async () => {
    h.kind = "autopilot";
    h.answers = [{ ok: true, status: 200, body: finished }];
    mountDriver();
    await waitFor(() => expect(probe()).toBe("locked=false pending=false"));
    expect(h.opened).toEqual([]);
  });

  it("right after signup the setup counts as pending until the read lands, and the hint clears once setup is done", async () => {
    window.sessionStorage.setItem("zavi.setup.expected", "1");
    h.answers = ["hang"];
    const first = mountDriver();
    await waitFor(() => expect(probe()).toBe("locked=false pending=true"));
    first.unmount();
    h.answers = [{ ok: true, status: 200, body: finished }];
    mountDriver();
    await waitFor(() => expect(probe()).toBe("locked=false pending=false"));
    expect(window.sessionStorage.getItem("zavi.setup.expected")).toBeNull();
  });

  it("a setup read that never answers stops covering the workspace after a bounded wait", async () => {
    vi.useFakeTimers();
    try {
      window.sessionStorage.setItem("zavi.setup.expected", "1");
      h.answers = ["hang"];
      mountDriver();
      await act(async () => {});
      expect(probe()).toBe("locked=false pending=true");
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(probe()).toBe("locked=false pending=false");
      expect(window.sessionStorage.getItem("zavi.setup.expected")).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("without the signup hint nothing is pending, so a set-up workspace never flashes a loader", async () => {
    h.answers = ["hang"];
    mountDriver();
    await new Promise((r) => setTimeout(r, 10));
    expect(probe()).toBe("locked=false pending=false");
  });
});
});

describe("SetupProvider response ordering", () => {
  const progress = {
    ...running, done: true, docs: { status: "skipped", files: 0, facts: 0 }, connectors: { status: "skipped" }, has_plan: false,
    draft: { status: "running", run_id: "run", attempts: 1, can_retry: false, free_retry: false },
  };
  const ready = { ...progress, has_plan: true, draft: { ...progress.draft, status: "done" } };
  const response = (body: unknown) => new Response(JSON.stringify(body));
  async function grab(body: unknown) {
    h.answers = [{ ok: true, status: 200, body }];
    let ctx: ReturnType<typeof useSetupOptional> = null;
    function Grab() { ctx = useSetupOptional(); return null; }
    render(<SetupProvider><Grab /></SetupProvider>);
    await waitFor(() => expect(ctx?.state?.enabled).toBe(true));
    return () => ctx!;
  }
  it("an older refresh cannot replace a ready plan with a running draft", async () => {
    const ctx = await grab(progress);
    let answerOld: (value: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { answerOld = resolve; }));
    const older = ctx().refresh();
    vi.mocked(apiFetch).mockResolvedValueOnce(response(ready));
    await act(() => ctx().refresh());
    expect(ctx().state).toEqual(ready);
    await act(async () => { answerOld(response(progress)); await older; });
    expect(ctx().state).toEqual(ready);
  });
  it("a read begun before a progress write cannot discard that write", async () => {
    const ctx = await grab(running);
    let answerOld: (value: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { answerOld = resolve; }));
    const older = ctx().refresh();
    vi.mocked(apiFetch).mockResolvedValueOnce(response(ready));
    await act(() => ctx().mark({ step: "done" }));
    await act(async () => { answerOld(response({ enabled: false })); await older; });
    expect(ctx().state).toEqual(ready);
    expect(ctx().locked).toBe(false);
  });
  it("a delayed refresh error cannot overwrite a newer successful read", async () => {
    const ctx = await grab(progress);
    let answerOld: (value: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { answerOld = resolve; }));
    const older = ctx().refresh();
    vi.mocked(apiFetch).mockResolvedValueOnce(response(ready));
    await act(() => ctx().refresh());
    await act(async () => { answerOld(new Response(null, { status: 500 })); await older; });
    expect(ctx().loadError).toBe(false);
  });
  it("a delayed progress snapshot saves its step without replacing a newer ready plan", async () => {
    const ctx = await grab(progress);
    let answerMark: (value: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { answerMark = resolve; }));
    const marking = ctx().mark({ step: "home" });
    vi.mocked(apiFetch).mockResolvedValueOnce(response(ready));
    await act(() => ctx().refresh());
    await act(async () => { answerMark(response({ ...progress, home_seen: true })); await marking; });
    expect(ctx().state).toEqual({ ...ready, home_seen: true });
  });
});

describe("setup-disabled signup fallback", () => {
  it("opens Growth Strategy once for a new signup when welcome setup is off", async () => {
    h.kind = "agent";
    window.sessionStorage.setItem("zavi.setup.expected", "1");
    h.answers = [{ ok: true, status: 200, body: { enabled: false } }];
    mount();
    await waitFor(() => expect(h.opened).toEqual(["autopilot"]));
    expect(window.sessionStorage.getItem("zavi.setup.expected")).toBeNull();
  });
  it("does not redirect an ordinary workspace visit with setup off", async () => {
    h.kind = "agent";
    h.answers = [{ ok: true, status: 200, body: { enabled: false } }];
    mount();
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toContain("enabled=false"));
    expect(h.opened).toEqual([]);
  });
});
