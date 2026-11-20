// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

const core = vi.hoisted(() => ({
  constructed: 0,
  configs: [] as Array<Record<string, unknown>>,
  connects: [] as Array<string | undefined>,
  headers: {} as Record<string, string>,
  tools: [] as Array<{ name: string; followUp?: boolean | string; handler: (a: Record<string, unknown>) => Promise<unknown> }>,
  contexts: [] as Array<{ description: string; value: string }>,
}));

vi.mock("@copilotkit/react-core/v2/headless", () => ({
  CopilotKitCoreReact: class {
    constructor(config: Record<string, unknown>) {
      core.constructed += 1;
      core.configs.push(config);
      if (!config.deferInitialConnection) core.connects.push(core.headers.Authorization);
    }
    setHeaders(h: Record<string, string>) {
      core.headers = h;
    }
    connect() {
      core.connects.push(core.headers.Authorization);
    }
    setProperties() {}
    subscribe() {
      return { unsubscribe() {} };
    }
  },
  useFrontendTool: (tool: (typeof core.tools)[number]) => {
    core.tools.push(tool);
  },
  useAgentContext: (c: { description: string; value: string }) => {
    core.contexts.push(c);
  },
}));
vi.mock("@copilotkit/react-core/v2/context", async () => {
  const React = await import("react");
  return {
    CopilotKitContext: React.createContext(null),
    LicenseContext: React.createContext(null),
  };
});
vi.mock("@copilotkit/shared", () => ({ createLicenseContextValue: () => ({}) }));
const auth = vi.hoisted(() => ({
  token: "tok" as string | null,
  listener: null as null | ((e: unknown, s: { access_token?: string } | null) => void),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: auth.token ? { access_token: auth.token } : null } }),
      onAuthStateChange: (cb: (e: unknown, s: { access_token?: string } | null) => void) => {
        auth.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  }),
}));
const openTab = vi.fn(() => "tab-1");
const openAgentTab = vi.fn(async () => "tab-2");
vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspace: () => ({
    openTab,
    openAgentTab,
    tabs: [{ id: "a", kind: "agent", title: "Growth", payload: { kind: "agent", slug: "growth-lead" } }],
    activeTabId: "a",
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ZaviCopilotProvider } from "./ZaviCopilotProvider";
import { ZaviCopilotBridge } from "./ZaviCopilotBridge";
import { screenContextValue } from "./useZaviScreenContext";

const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  core.constructed = 0;
  core.configs.length = 0;
  core.connects.length = 0;
  core.headers = {};
  auth.token = "tok";
  auth.listener = null;
  core.tools.length = 0;
  core.contexts.length = 0;
  openTab.mockClear();
});
afterEach(() => {
  delete env.NEXT_PUBLIC_COPILOTKIT_TRANSPORT;
});

describe("kill switch", () => {
  it("NEXT_PUBLIC_COPILOTKIT_TRANSPORT=0 → children only, no core, no hooks", () => {
    env.NEXT_PUBLIC_COPILOTKIT_TRANSPORT = "0";
    const { container } = render(
      <ZaviCopilotProvider>
        <ZaviCopilotBridge />
        <span>child</span>
      </ZaviCopilotProvider>,
    );
    expect(container.textContent).toBe("child");
    expect(core.constructed).toBe(0);
    expect(core.tools).toEqual([]);
  });
});

describe("with the transport on", () => {
  it("constructs one core, registers exactly the three gated tools, all followUp:false", () => {
    render(
      <ZaviCopilotProvider agentSlug="growth-lead">
        <ZaviCopilotBridge />
      </ZaviCopilotProvider>,
    );
    expect(core.constructed).toBe(1);
    expect(core.tools.map((t) => t.name)).toEqual(["open_tab", "open_agent", "open_approval"]);
    expect(core.tools.every((t) => t.followUp === false)).toBe(true);
  });

  it("open_tab opens the requested destination; open_agent opens the agent", async () => {
    render(
      <ZaviCopilotProvider>
        <ZaviCopilotBridge />
      </ZaviCopilotProvider>,
    );
    await core.tools[0].handler({ kind: "calendar" });
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "calendar", title: "Calendar" }));
    await core.tools[1].handler({ slug: "growth-lead", new_thread: true });
    expect(openAgentTab).toHaveBeenCalledWith("growth-lead", { newThread: true });
  });

  it("hands the agent the active tab as bounded, content-free context", () => {
    render(
      <ZaviCopilotProvider>
        <ZaviCopilotBridge />
      </ZaviCopilotProvider>,
    );
    expect(core.contexts).toHaveLength(1);
    expect(core.contexts[0].value).toEqual({
      active_tab: { kind: "agent", title: "Growth", agent: "growth-lead" },
      open_tabs: ["agent"],
    });
    expect(screenContextValue([], "x").active_tab).toBeNull();
  });
});

describe("/api/copilotkit/info waits for the token", () => {
  it("no request while signed out; one, with the bearer, once the token arrives", async () => {
    auth.token = null;
    render(
      <ZaviCopilotProvider>
        <span>child</span>
      </ZaviCopilotProvider>,
    );
    await act(async () => {});
    expect(core.configs[0]).toMatchObject({ deferInitialConnection: true });
    expect(core.connects).toEqual([]);

    await act(async () => auth.listener?.("SIGNED_IN", { access_token: "fresh" }));
    expect(core.connects).toEqual(["Bearer fresh"]);
  });

  it("signed in: the first request already carries the bearer", async () => {
    render(
      <ZaviCopilotProvider>
        <span>child</span>
      </ZaviCopilotProvider>,
    );
    await act(async () => {});
    expect(core.connects.length).toBeGreaterThan(0);
    expect(core.connects.every((h) => h === "Bearer tok")).toBe(true);
  });
});
