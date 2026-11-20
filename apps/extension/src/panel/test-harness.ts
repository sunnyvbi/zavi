
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi, type Mock } from "vitest";
import { App } from "./App";

export type Call = { method: string; path: string; body: unknown };

export type FakeDecision = {
  id: string;
  decision_class: string;
  body: unknown;
  status: string;
  agent_slug: string | null;
  thread_id: string | null;
};

export type ThreadMessage = {
  id: string;
  sender_role: string;
  body: string;
  agent_run_id: string | null;
  created_at: string;
};

export type FakeServer = {
  calls: Call[];
  consentGranted: boolean;
  revokeFails: boolean;
  runsCleared: number | undefined;
  uploadReply: { status: number; json: unknown };
  runStatus: string;
  progressReplies: Array<Array<{ key: string; label: string; state: string }>>;
  decisions: FakeDecision[];
  approveReplies: { status: number; json: unknown }[];
  chatCount: number;
  threads: Record<string, ThreadMessage[]>;
  threadSeq: number;
  extOps: unknown[];
};

export function newServer(): FakeServer {
  return {
    calls: [],
    consentGranted: true,
    revokeFails: false,
    runsCleared: 3,
    uploadReply: { status: 200, json: { image_path: "tenant-1/shot.jpg" } },
    runStatus: "success",
    progressReplies: [],
    decisions: [],
    approveReplies: [],
    chatCount: 0,
    threads: {},
    threadSeq: 0,
    extOps: [],
  };
}

function reply(status: number, json: unknown) {
  const text = json === undefined ? "" : JSON.stringify(json);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

function consentReply(s: FakeServer) {
  return {
    consent: {
      granted: s.consentGranted,
      version: s.consentGranted ? "1" : null,
      granted_at: s.consentGranted ? "2026-09-17T00:00:00.000Z" : null,
      revoked_at: null,
      current_version: "1",
    },
    consent_required: !s.consentGranted,
    current_version: "1",
  };
}

export function installFetch(s: FakeServer): void {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("data:")) {
      return { blob: async () => new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" }) };
    }
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body ?? null;
    if (typeof body === "string") body = JSON.parse(body);
    s.calls.push({ method, path: u.pathname + u.search, body });
    const p = u.pathname;

    if (p === "/api/extension/consent") {
      if (method === "POST") s.consentGranted = true;
      if (method === "DELETE") {
        if (s.revokeFails) return reply(500, { error: { message: "boom" } });
        s.consentGranted = false;
        return reply(200, { ...consentReply(s), runs_cleared: s.runsCleared });
      }
      return reply(200, consentReply(s));
    }
    if (p === "/api/extension/sessions" && method === "POST") {
      return reply(201, { session_id: "sess-1" });
    }
    if (p.startsWith("/api/extension/sessions/")) return reply(204, undefined);
    if (p === "/api/extension/ops/next") {
      const next = s.extOps.shift();
      if (next) return reply(200, { op: next });
      return new Promise((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
      );
    }
    if (p.startsWith("/api/extension/ops/") && method === "POST") return reply(204, undefined);
    if (p === "/api/extension/screenshot" && method === "POST") {
      return reply(s.uploadReply.status, s.uploadReply.json);
    }
    if (p === "/api/agents/operator/chat" && method === "POST") {
      s.chatCount += 1;
      const n = s.chatCount;
      const asked = (body as { thread_id?: unknown } | null)?.thread_id;
      const threadId =
        typeof asked === "string" && asked ? asked : `thread-${(s.threadSeq += 1)}`;
      const list = (s.threads[threadId] ??= []);
      list.push(
        { id: `user-${n}`, sender_role: "user", body: `q${n}`, agent_run_id: null, created_at: `2026-09-17T00:00:0${n}.000Z` },
        { id: `asst-${n}`, sender_role: "assistant", body: `answer ${n}`, agent_run_id: `run-${n}`, created_at: `2026-09-17T00:00:0${n}.500Z` },
      );
      return reply(202, {
        thread_id: threadId,
        user_message_id: `user-${n}`,
        run_id: `run-${n}`,
      });
    }
    if (p === "/api/agents/operator/chat/history") {
      const threadId = u.searchParams.get("thread_id") ?? "";
      return reply(200, {
        thread: { id: threadId },
        messages: s.threads[threadId] ?? [],
      });
    }
    if (p.startsWith("/api/agents/runs/") && p.endsWith("/progress")) {
      const next = s.progressReplies.length > 1 ? s.progressReplies.shift() : s.progressReplies[0];
      return reply(200, { steps: next ?? [] });
    }
    if (p.startsWith("/api/agents/runs/")) {
      return reply(200, { run: { status: s.runStatus } });
    }
    if (p === "/api/approvals" && method === "GET") {
      return reply(200, { decisions: s.decisions });
    }
    const m = p.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
    if (m && method === "POST") {
      if (m[2] === "approve") {
        const next = s.approveReplies.shift();
        if (next) return reply(next.status, next.json);
      }
      s.decisions = s.decisions.filter((d) => d.id !== m[1]);
      return reply(200, { ok: true, decision_id: m[1] });
    }
    return reply(404, { error: { code: "not_found", message: `no fake for ${method} ${p}` } });
  });
  vi.stubGlobal("fetch", fetchMock);
}

export type FakeTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
};

export type FakeChrome = {
  tab: FakeTab;
  tabs: Record<number, FakeTab>;
  captureVisibleTab: Mock<unknown[], Promise<string>>;
  permissionsContains: Mock<unknown[], Promise<boolean>>;
  permissionsRequest: Mock<unknown[], Promise<boolean>>;
  session: Record<string, unknown>;
  fire: {
    updated(tabId: number, change: Record<string, unknown>): void;
    activated(tabId: number): void;
  };
};

export function fakeSessionArea(bag: Record<string, unknown>) {
  return {
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys === null) return { ...bag };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in bag) out[k] = bag[k];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(bag, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete bag[k];
    }),
  };
}

export function fakeDebuggerApi() {
  const detachFns: ((...a: unknown[]) => void)[] = [];
  return {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => ({})),
    onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    onDetach: {
      addListener: vi.fn((fn: (...a: unknown[]) => void) => detachFns.push(fn)),
      removeListener: vi.fn(),
    },
  };
}

export function installChrome(opts: { debuggerApi?: unknown } = {}): FakeChrome {
  const onUpdated: ((...a: unknown[]) => void)[] = [];
  const onActivated: ((...a: unknown[]) => void)[] = [];
  const own: FakeTab = {
    id: 1,
    windowId: 7,
    url: "https://app.slack.com/client/T1/D1?x=secret#frag",
    title: "Slack | DM with Sam",
    active: true,
  };
  const fake: FakeChrome = {
    tab: own,
    tabs: { 1: own },
    captureVisibleTab: vi.fn(async (..._a: unknown[]) => "data:image/jpeg;base64,/9j/"),
    permissionsContains: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
    permissionsRequest: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
    session: {},
    fire: {
      updated: (tabId, change) => {
        for (const fn of onUpdated) fn(tabId, change, fake.tabs[tabId]);
      },
      activated: (tabId) => {
        for (const fn of onActivated) fn({ tabId, windowId: fake.tabs[tabId]?.windowId ?? 7 });
      },
    },
  };
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => Object.values(fake.tabs).filter((t) => t.active !== false)),
      get: vi.fn(async (id: number) => {
        const t = fake.tabs[id];
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return t;
      }),
      captureVisibleTab: fake.captureVisibleTab,
      onActivated: {
        addListener: vi.fn((fn: (...a: unknown[]) => void) => onActivated.push(fn)),
        removeListener: vi.fn((fn: (...a: unknown[]) => void) => {
          const i = onActivated.indexOf(fn);
          if (i >= 0) onActivated.splice(i, 1);
        }),
      },
      onUpdated: {
        addListener: vi.fn((fn: (...a: unknown[]) => void) => onUpdated.push(fn)),
        removeListener: vi.fn((fn: (...a: unknown[]) => void) => {
          const i = onUpdated.indexOf(fn);
          if (i >= 0) onUpdated.splice(i, 1);
        }),
      },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: { getCurrent: vi.fn(async () => ({ id: 7 })) },
    permissions: {
      contains: fake.permissionsContains,
      request: fake.permissionsRequest,
    },
    storage: { session: fakeSessionArea(fake.session) },
    ...(opts.debuggerApi ? { debugger: opts.debuggerApi } : {}),
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1280, height: 800, close: () => undefined })),
  );
  return fake;
}

export class Panel {
  root: Root | null = null;
  host: HTMLElement;

  constructor(tabId: number | null = 1) {
    if (tabId !== null) {
      window.history.replaceState({}, "", `/panel.html?tabId=${tabId}`);
    } else {
      window.history.replaceState({}, "", "/panel.html");
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = vi.fn();
    this.host = document.createElement("div");
    document.body.appendChild(this.host);
  }

  get text(): string {
    return this.host.textContent ?? "";
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  async mount(): Promise<void> {
    this.root = createRoot(this.host);
    await act(async () => {
      this.root?.render(createElement(App));
    });
    await this.settle();
  }

  async type(text: string): Promise<void> {
    const box = this.host.querySelector("textarea");
    if (!box) throw new Error("composer not rendered");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setValue) throw new Error("no native value setter");
    await act(async () => {
      setValue.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await this.settle();
  }

  get draft(): string {
    const box = this.host.querySelector("textarea");
    return box instanceof HTMLTextAreaElement ? box.value : "";
  }

  async ask(text: string): Promise<void> {
    const box = this.host.querySelector("textarea");
    if (!box) throw new Error("composer not rendered");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setValue) throw new Error("no native value setter");
    await act(async () => {
      setValue.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = this.host.querySelector("form.zv-composer");
    if (!form) throw new Error("composer form not rendered");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await this.settle();
  }

  async act(fn: () => void): Promise<void> {
    await act(async () => {
      fn();
      await new Promise((r) => setTimeout(r, 0));
    });
    await this.settle();
  }

  async click(selector: string): Promise<void> {
    const el = this.host.querySelector(selector);
    if (!el) throw new Error(`not rendered: ${selector}`);
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await this.settle();
  }

  unmount(): void {
    if (this.root) act(() => this.root?.unmount());
    this.root = null;
    this.host.remove();
  }
}

export function callsTo(s: FakeServer, method: string, path: string): Call[] {
  return s.calls.filter((c) => c.method === method && c.path.split("?")[0] === path);
}
