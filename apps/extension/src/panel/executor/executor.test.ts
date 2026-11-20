
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_CDP_METHODS, CdpNotAllowedError, OwnTabCdp, type DebuggerApi, type DebuggerTarget } from "./cdp";
import { executeOp, MAX_NAME_CHARS, parseOp } from "./ops";
import { settle, snapshot, SETTLE_MAX_MS, type SettleClock } from "./perceive";
import { BrowserControl, EXEC_TOKENS_KEY, TokenLedger, guardClaimedOp, type SessionArea } from "./control";
import { stepLine, STOPPED_BY_YOU, WORKING_BAR } from "./copy";
import type { ClaimedOp } from "../api";

const OWN = 7;

type Sent = { target: DebuggerTarget; method: string; params: unknown };

function fakeDebugger(reply: (method: string, params: unknown, target: DebuggerTarget) => unknown = () => ({})) {
  const eventFns: ((s: DebuggerTarget, m: string, p: unknown) => void)[] = [];
  const detachFns: ((s: DebuggerTarget, r: string) => void)[] = [];
  const sent: Sent[] = [];
  const api: DebuggerApi & { sent: Sent[]; fire: (s: DebuggerTarget, m: string, p: unknown) => void; fireDetach: (s: DebuggerTarget, r: string) => void } = {
    sent,
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (target: DebuggerTarget, method: string, params?: object) => {
      sent.push({ target, method, params });
      return reply(method, params, target);
    }),
    onEvent: {
      addListener: (fn) => eventFns.push(fn),
      removeListener: (fn) => {
        const i = eventFns.indexOf(fn);
        if (i >= 0) eventFns.splice(i, 1);
      },
    },
    onDetach: {
      addListener: (fn) => detachFns.push(fn),
      removeListener: (fn) => {
        const i = detachFns.indexOf(fn);
        if (i >= 0) detachFns.splice(i, 1);
      },
    },
    fire: (s, m, p) => eventFns.forEach((f) => f(s, m, p)),
    fireDetach: (s, r) => detachFns.forEach((f) => f(s, r)),
  };
  return api;
}

function sessionArea(bag: Record<string, unknown> = {}): SessionArea & { bag: Record<string, unknown> } {
  return {
    bag,
    get: async (keys) => {
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in bag) out[k] = bag[k];
      return out;
    },
    set: async (items) => {
      Object.assign(bag, items);
    },
  };
}

const topUrl = async () => "https://adsmanager.facebook.com/adsmanager/manage";

async function attached(reply?: Parameters<typeof fakeDebugger>[0]) {
  const api = fakeDebugger(reply);
  const cdp = new OwnTabCdp(OWN, api);
  await cdp.attach();
  api.sent.length = 0;
  return { api, cdp };
}

describe("CDP allowlist", () => {
  it("never lists page script, network or storage methods", () => {
    for (const m of ALLOWED_CDP_METHODS) {
      expect(m).not.toMatch(/^(Runtime|Network|Storage|Fetch|Debugger|Target\.attachToTarget|Target\.createTarget)/);
    }
  });

  it.each(["Runtime.evaluate", "Network.getCookies", "Storage.getCookies", "Target.attachToTarget", "Page.printToPDF"])(
    "refuses %s before Chrome sees it",
    async (method) => {
      const { api, cdp } = await attached();
      await expect(cdp.send(method, {})).rejects.toBeInstanceOf(CdpNotAllowedError);
      expect(api.sendCommand).not.toHaveBeenCalledWith(expect.anything(), method, expect.anything());
    },
  );

  it("attaches with protocol 1.3 and auto-attaches frames flat", async () => {
    const api = fakeDebugger();
    await new OwnTabCdp(OWN, api).attach();
    expect(api.attach).toHaveBeenCalledWith({ tabId: OWN }, "1.3");
    expect(api.sent.map((s) => s.method).slice(0, 2)).toEqual(["Page.enable", "Target.setAutoAttach"]);
    expect(api.sent[1].params).toEqual({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    expect(api.sent.map((s) => s.method).slice(2)).toEqual(["Page.getFrameTree", "Page.setLifecycleEventsEnabled"]);
  });
});

describe("own tab only", () => {
  it("every command targets the panel's own tab", async () => {
    const { api, cdp } = await attached(() => ({ nodes: [] }));
    await executeOp(cdp, { op: "ax_snapshot" }, topUrl);
    await executeOp(cdp, { op: "key", key: "Tab" }, topUrl);
    expect(api.sent.length).toBeGreaterThan(0);
    expect(api.sent.every((s) => s.target.tabId === OWN)).toBe(true);
  });

  it("refuses an op addressed to another tab, and reports it as not run", async () => {
    const tokens = new TokenLedger(sessionArea());
    const g = await guardClaimedOp(claimed({ tab_id: OWN + 1 }), OWN, tokens);
    expect(g).toMatchObject({ run: false, post: true, outcome: { status: "failed", result: { error_code: "wrong_tab" } } });
  });

  it("refuses a frame session that never attached to this tab", async () => {
    const { api, cdp } = await attached();
    api.fire({ tabId: OWN + 1 }, "Target.attachedToTarget", { sessionId: "foreign" });
    const r = await executeOp(cdp, { op: "click_ref", ref: { frame_session: "foreign", backend_node_id: 5 } }, topUrl);
    expect(r.status).toBe("failed");
    expect(r.result.error_code).toBe("unknown_frame");
    expect(api.sent).toHaveLength(0);
  });

  it("routes a frame ref to that frame's session once the frame attached to our tab", async () => {
    const { api, cdp } = await attached(() => ({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }));
    api.fire({ tabId: OWN }, "Target.attachedToTarget", { sessionId: "frame-1", targetInfo: { type: "iframe" } });
    const r = await executeOp(cdp, { op: "click_ref", ref: { frame_session: "frame-1", backend_node_id: 5 } }, topUrl);
    expect(r.status).toBe("done");
    const clicks = api.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(clicks.every((s) => s.target.sessionId === "frame-1" && s.target.tabId === OWN)).toBe(true);
  });
});

function claimed(over: Partial<ClaimedOp> = {}): ClaimedOp {
  return {
    id: "op-1",
    run_id: "run-1",
    seq: 1,
    tab_id: OWN,
    op: { op: "key", key: "Enter" },
    is_write: true,
    execution_token: "tok-1",
    lease_until: "2026-09-30T00:00:15Z",
    ...over,
  };
}

describe("execution tokens", () => {
  it("refuses a token it has already run, even after the panel is rebuilt", async () => {
    const bag: Record<string, unknown> = {};
    expect(await guardClaimedOp(claimed(), OWN, new TokenLedger(sessionArea(bag)))).toEqual({ run: true });
    expect(await guardClaimedOp(claimed(), OWN, new TokenLedger(sessionArea(bag)))).toEqual({ run: false, post: false });
    expect(bag[EXEC_TOKENS_KEY]).toEqual(["tok-1"]);
    expect(await guardClaimedOp(claimed({ execution_token: "tok-2" }), OWN, new TokenLedger(sessionArea(bag)))).toEqual({ run: true });
  });
});

describe("ops", () => {
  it("every result carries top_url, success and failure alike", async () => {
    const { cdp } = await attached();
    expect((await executeOp(cdp, { op: "scroll", dy: 300 }, topUrl)).result.top_url).toContain("facebook.com");
    expect((await executeOp(cdp, { op: "nope" }, topUrl)).result.top_url).toContain("facebook.com");
  });

  it.each(["a", "Delete", "Meta", "toString", "__proto__"])("refuses key %s", async (key) => {
    const { api, cdp } = await attached();
    const r = await executeOp(cdp, { op: "key", key }, topUrl);
    expect(r.status).toBe("failed");
    expect(api.sent.some((s) => s.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("presses Enter as keyDown (with text) + keyUp", async () => {
    const { api, cdp } = await attached();
    expect((await executeOp(cdp, { op: "key", key: "Enter" }, topUrl)).status).toBe("done");
    const keys = api.sent.filter((s) => s.method === "Input.dispatchKeyEvent").map((s) => s.params as Record<string, unknown>);
    expect(keys.map((k) => k.type)).toEqual(["keyDown", "keyUp"]);
    expect(keys[0]).toMatchObject({ key: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,x"])(
    "refuses to navigate to %s",
    async (url) => {
      const { api, cdp } = await attached();
      const r = await executeOp(cdp, { op: "nav", url }, topUrl);
      expect(r).toMatchObject({ status: "failed", result: { error_code: "nav_blocked" } });
      expect(api.sent.some((s) => s.method === "Page.navigate")).toBe(false);
    },
  );

  it("navigates http(s) and waits for the load event", async () => {
    const { api, cdp } = await attached();
    const p = executeOp(cdp, { op: "nav", url: "https://business.facebook.com/" }, topUrl);
    await Promise.resolve();
    api.fire({ tabId: OWN }, "Page.loadEventFired", {});
    expect((await p).status).toBe("done");
    expect(api.sent.find((s) => s.method === "Page.navigate")?.params).toEqual({ url: "https://business.facebook.com/" });
  });

  it("snapshots interactive nodes only, names capped, refs frame-qualified", async () => {
    const long = "x".repeat(200);
    const { api, cdp } = await attached((method, _p, target) =>
      method === "Accessibility.getFullAXTree"
        ? {
            nodes: target.sessionId
              ? [{ role: { value: "textbox" }, name: { value: "Card number" }, backendDOMNodeId: 9 }]
              : [
                  { role: { value: "button" }, name: { value: "Budget" }, backendDOMNodeId: 1 },
                  { role: { value: "StaticText" }, name: { value: "spend 4,120" }, backendDOMNodeId: 2 },
                  { role: { value: "link" }, name: { value: long }, backendDOMNodeId: 3 },
                  { role: { value: "button" }, ignored: true, name: { value: "hidden" }, backendDOMNodeId: 4 },
                ],
          }
        : {},
    );
    api.fire({ tabId: OWN }, "Target.attachedToTarget", { sessionId: "stripe-frame" });
    const r = await executeOp(cdp, { op: "ax_snapshot" }, topUrl);
    const nodes = r.result.nodes as { role: string; name: string; ref: unknown }[];
    expect(nodes.map((n) => n.role)).toEqual(["button", "link", "textbox"]);
    expect(nodes[1].name).toHaveLength(MAX_NAME_CHARS);
    expect(nodes[0].ref).toEqual({ frame_session: null, backend_node_id: 1 });
    expect(nodes[2].ref).toEqual({ frame_session: "stripe-frame", backend_node_id: 9 });
  });

  it("snapshots a role-less contenteditable editor as a textbox (Chrome reports it as generic + editable)", async () => {
    const { cdp } = await attached((method) =>
      method === "Accessibility.getFullAXTree"
        ? {
            nodes: [
              {
                role: { value: "generic" },
                name: { value: "Editor" },
                backendDOMNodeId: 5,
                properties: [
                  { name: "focusable", value: { value: true } },
                  { name: "editable", value: { value: "richtext" } },
                ],
              },
              { role: { value: "StaticText" }, name: { value: "old text" }, backendDOMNodeId: 9, properties: [{ name: "editable", value: { value: "richtext" } }] },
              { role: { value: "generic" }, name: { value: "plain div" }, backendDOMNodeId: 10, properties: [{ name: "focusable", value: { value: true } }] },
            ],
          }
        : {},
    );
    const r = await executeOp(cdp, { op: "ax_snapshot" }, topUrl);
    expect(r.result.nodes).toEqual([{ role: "textbox", name: "Editor", ref: { frame_session: null, backend_node_id: 5 } }]);
  });

  it("scroll: when the wheel at the centre does not move the page (an iframe took it), tries nearer the edge and says so", async () => {
    let pageY = 0;
    const wheels: { x: number; y: number }[] = [];
    const { cdp } = await attached((method, params) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800, pageY } };
      if (method === "Input.dispatchMouseEvent" && (params as { type: string }).type === "mouseWheel") {
        const p = params as { x: number; y: number; deltaY: number };
        wheels.push({ x: p.x, y: p.y });
        if (p.x !== 500) pageY += p.deltaY;
      }
      return {};
    });
    const r = await executeOp(cdp, { op: "scroll", dy: 600 }, topUrl);
    expect(wheels[0]).toEqual({ x: 500, y: 400 });
    expect(wheels).toHaveLength(2);
    expect(r.result.page_moved).toBe(true);
  });

  it("scroll: fails as scroll_no_move when nothing moves (already at the end)", async () => {
    const { api, cdp } = await attached((method) =>
      method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 1000, clientHeight: 800, pageY: 0 } } : {},
    );
    const r = await executeOp(cdp, { op: "scroll", dy: -300 }, topUrl);
    expect(r.status).toBe("failed");
    expect(r.result.error_code).toBe("scroll_no_move");
    expect(api.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && (s.params as { type: string }).type === "mouseWheel")).toHaveLength(3);
  });

  const gridTab = (opts: { innerAx?: boolean; canvas?: boolean; flicker?: boolean; pageHeight?: number } = {}) => {
    let rows = 0;
    let frames = 0;
    let pageY = 0;
    return (method: string, params: unknown) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800, pageY }, cssContentSize: { width: 1000, height: opts.pageHeight ?? 800 } };
      }
      if (method === "Input.dispatchMouseEvent" && (params as { type: string }).type === "mouseWheel") {
        const p = params as { x: number; deltaY: number };
        if (p.x === 500) rows += 20;
        else if (opts.pageHeight && opts.pageHeight > 800) pageY += p.deltaY;
      }
      if (method === "Accessibility.getFullAXTree") {
        return { nodes: [{ nodeId: "1", ignored: false, role: { type: "role", value: "gridcell" }, name: { type: "computedString", value: opts.innerAx ? `Row ${rows + 1}` : "Sheet1" } }] };
      }
      if (method === "Page.captureScreenshot") return { data: opts.flicker ? `frame${frames++}` : opts.canvas ? `rows-from-${rows}` : "static" };
      return {};
    };
  };

  it("scroll: an inner scroller moved (the page did not) → done, page_moved false, at the first point", async () => {
    const { api, cdp } = await attached(gridTab({ innerAx: true }));
    const r = await executeOp(cdp, { op: "scroll", dy: 600 }, topUrl);
    expect(r.status).toBe("done");
    expect(r.result).toMatchObject({ page_moved: false, content_changed: true, changed_by: "content" });
    expect(api.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && (s.params as { type: string }).type === "mouseWheel")).toHaveLength(1);
  });

  it("scroll: when the PAGE can still move, an inner area moving at the centre is not the answer; the page is", async () => {
    const { cdp } = await attached(gridTab({ innerAx: true, pageHeight: 4000 }));
    const r = await executeOp(cdp, { op: "scroll", dy: 600 }, topUrl);
    expect(r.result).toMatchObject({ page_moved: true, tried: 2 });
  });

  it("scroll: a canvas grid (cells not in the accessibility tree) counts by the screenshot changing", async () => {
    const { cdp } = await attached(gridTab({ canvas: true }));
    const r = await executeOp(cdp, { op: "scroll", dy: 600 }, topUrl);
    expect(r.status).toBe("done");
    expect(r.result).toMatchObject({ page_moved: false, changed_by: "screenshot" });
  });

  it("scroll: a screen that changes on its own (animation) is not taken as scrolled content", async () => {
    const { cdp } = await attached(gridTab({ flicker: true }));
    const r = await executeOp(cdp, { op: "scroll", dy: 600 }, topUrl);
    expect(r.result.error_code).toBe("scroll_no_move");
  });

  it("scroll with a ref wheels over that element first, in its own frame", async () => {
    const wheels: { x: number; y: number; target: DebuggerTarget }[] = [];
    const base = gridTab({ innerAx: true });
    const { cdp } = await attached((method, params, target) => {
      if (method === "DOM.getBoxModel") return { model: { content: [100, 100, 300, 100, 300, 500, 100, 500] } };
      if (method === "Input.dispatchMouseEvent" && (params as { type: string }).type === "mouseWheel") {
        wheels.push({ ...(params as { x: number; y: number }), target });
      }
      return base(method, params);
    });
    const r = await executeOp(cdp, { op: "scroll", dy: 600, ref: { frame_session: null, backend_node_id: 42 } }, topUrl);
    expect(r.status).toBe("done");
    expect(wheels[0]).toMatchObject({ x: 200, y: 300 });
    expect(parseOp({ op: "scroll", dy: 1, ref: { backend_node_id: "x" } })).toBeNull();
  });

  it("clicks at the centre of the box after scrolling it into view and checking nothing covers it", async () => {
    const { api, cdp } = await attached((m) =>
      m === "DOM.getBoxModel" ? { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } } : m === "DOM.getNodeForLocation" ? { backendNodeId: 3 } : {},
    );
    await executeOp(cdp, { op: "click_ref", ref: { frame_session: null, backend_node_id: 3 } }, topUrl);
    expect(api.sent.map((s) => s.method)).toEqual([
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "DOM.getBoxModel",
      "DOM.enable",
      "Page.getLayoutMetrics",
      "DOM.getNodeForLocation",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    const hit = api.sent.find((s) => s.method === "DOM.getNodeForLocation");
    expect(hit?.params).toMatchObject({ x: 20, y: 30 });
    const mouse = api.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(mouse.map((s) => (s.params as { type: string }).type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse[1].params).toMatchObject({ x: 20, y: 30 });
  });

  it("hit-tests in document coordinates on a scrolled page", async () => {
    const { api, cdp } = await attached((m) =>
      m === "DOM.getBoxModel"
        ? { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } }
        : m === "DOM.getNodeForLocation"
          ? { backendNodeId: 3 }
          : m === "Page.getLayoutMetrics"
            ? { cssVisualViewport: { clientWidth: 1000, clientHeight: 800, pageX: 7, pageY: 500 } }
            : {},
    );
    await executeOp(cdp, { op: "click_ref", ref: { frame_session: null, backend_node_id: 3 } }, topUrl);
    expect(api.sent.find((s) => s.method === "DOM.getNodeForLocation")?.params).toMatchObject({ x: 27, y: 530, ignorePointerEventsNone: false });
    expect(api.sent.find((s) => s.method === "Input.dispatchMouseEvent" && (s.params as { type: string }).type === "mousePressed")?.params).toMatchObject({ x: 20, y: 30 });
  });

  it("waits for a target that is still moving before clicking where it ends up", async () => {
    let n = 0;
    const { api, cdp } = await attached((m) => {
      if (m === "DOM.getBoxModel") {
        n++;
        const y = n < 3 ? 200 - n * 50 : 100;
        return { model: { content: [10, y, 30, y, 30, y + 20, 10, y + 20] } };
      }
      return m === "DOM.getNodeForLocation" ? { backendNodeId: 3 } : {};
    });
    await executeOp(cdp, { op: "click_ref", ref: { frame_session: null, backend_node_id: 3 } }, topUrl);
    const press = api.sent.find((s) => s.method === "Input.dispatchMouseEvent" && (s.params as { type: string }).type === "mousePressed");
    expect(press?.params).toMatchObject({ y: 110 });
  });

  it("types by focusing the node, selecting what it holds, then inserting text (replaces, never appends)", async () => {
    const { api, cdp } = await attached();
    await executeOp(cdp, { op: "type_ref", ref: { frame_session: null, backend_node_id: 3 }, text: "$50" }, topUrl);
    expect(api.sent.filter((s) => s.method !== "Accessibility.getPartialAXTree").map((s) => [s.method, s.params])).toEqual([
      ["DOM.focus", { backendNodeId: 3 }],
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] }],
      ["Input.dispatchKeyEvent", { type: "keyUp" }],
      ["Input.insertText", { text: "$50" }],
    ]);
  });

  it("screenshots as jpeg quality 60", async () => {
    const { api, cdp } = await attached((m) => (m === "Page.captureScreenshot" ? { data: "AAAA" } : {}));
    const r = await executeOp(cdp, { op: "screenshot" }, topUrl);
    const shot = api.sent.find((s) => s.method === "Page.captureScreenshot");
    expect(shot?.params).toEqual({ format: "jpeg", quality: 60 });
    expect(r.result.image_base64).toBe("AAAA");
  });
});

describe("resolve uses the snapshot's role rule", () => {
  it("a focusable role-less contenteditable resolves as a textbox, so Enter in a card form is a submit", async () => {
    const DOC = {
      nodeName: "#document",
      documentURL: "https://shop.example.com/checkout",
      backendNodeId: 1,
      children: [
        {
          localName: "form",
          nodeName: "FORM",
          backendNodeId: 10,
          children: [
            { localName: "input", nodeName: "INPUT", backendNodeId: 11, attributes: ["autocomplete", "cc-number"] },
            { localName: "div", nodeName: "DIV", backendNodeId: 12, attributes: ["contenteditable", "true", "aria-label", "Amount"] },
          ],
        },
      ],
    };
    const { cdp } = await attached((method, params) => {
      if (method === "DOM.getDocument") return { root: DOC };
      if (method === "Accessibility.getPartialAXTree") {
        const id = (params as { backendNodeId: number }).backendNodeId;
        if (id === 12) {
          return {
            nodes: [
              {
                backendDOMNodeId: 12,
                role: { value: "generic" },
                name: { value: "Amount" },
                properties: [
                  { name: "editable", value: { value: "richtext" } },
                  { name: "focusable", value: { value: true } },
                ],
              },
            ],
          };
        }
        return { nodes: [] };
      }
      return {};
    });
    const out = await executeOp(cdp, { op: "resolve", ref: { frame_session: null, backend_node_id: 12 } }, topUrl);
    expect(out.result).toMatchObject({ role: "textbox" });
  });
});

describe("resolve (S3 money-step check)", () => {
  const DOC = {
    nodeName: "#document",
    documentURL: "https://shop.example.com/checkout",
    backendNodeId: 1,
    children: [
      {
        nodeName: "HTML",
        localName: "html",
        backendNodeId: 2,
        children: [
          {
            localName: "form",
            nodeName: "FORM",
            backendNodeId: 10,
            children: [
              { localName: "input", nodeName: "INPUT", backendNodeId: 11, attributes: ["autocomplete", "billing cc-number", "name", "card"] },
              { localName: "button", nodeName: "BUTTON", backendNodeId: 12, attributes: ["class", "pay"] },
            ],
          },
          { localName: "iframe", nodeName: "IFRAME", backendNodeId: 20, attributes: ["src", "https://js.stripe.com/v3/elements-inner-card-abc.html"] },
          {
            localName: "div",
            nodeName: "DIV",
            backendNodeId: 30,
            attributes: ["role", "dialog"],
            children: [
              { localName: "input", nodeName: "INPUT", backendNodeId: 31, attributes: ["name", "daily_budget"] },
              { localName: "div", nodeName: "DIV", backendNodeId: 32, attributes: ["role", "button"] },
            ],
          },
        ],
      },
    ],
  };
  const AX: Record<number, { role: string; name: string; value?: string }> = {
    11: { role: "textbox", name: "Card number" },
    12: { role: "button", name: "Pay $20.00" },
    31: { role: "textbox", name: "Daily budget", value: "$20.00" },
    32: { role: "button", name: "Save" },
  };
  function reply(method: string, params: unknown) {
    if (method === "DOM.getDocument") return { root: DOC };
    if (method === "Accessibility.getPartialAXTree") {
      const id = (params as { backendNodeId: number }).backendNodeId;
      const a = AX[id];
      return { nodes: a ? [{ backendDOMNodeId: id, role: { value: a.role }, name: { value: a.name }, value: a.value ? { value: a.value } : undefined }] : [] };
    }
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Card number" }, properties: [{ name: "focused", value: { value: true } }] }] };
    }
    return {};
  }

  it("reports name, role, frame URL, submit, card field and payment iframe for a Pay button", async () => {
    const { cdp } = await attached(reply);
    const out = await executeOp(cdp, { op: "resolve", ref: { frame_session: null, backend_node_id: 12 } }, topUrl);
    expect(out.status).toBe("done");
    expect(out.result).toMatchObject({
      ref: { frame_session: null, backend_node_id: 12 },
      role: "button",
      name: "Pay $20.00",
      frame_url: "https://shop.example.com/checkout",
      is_submit: true,
      form: { kind: "form", scope_node_id: 10, has_card_field: true, budget_fields: [] },
      page_has_payment_frame: true,
    });
  });

  it("reports budget fields (label + current value) in the target's dialog", async () => {
    const { cdp } = await attached(reply);
    const out = await executeOp(cdp, { op: "resolve", ref: { frame_session: null, backend_node_id: 32 } }, topUrl);
    expect(out.result).toMatchObject({
      name: "Save",
      is_submit: false,
      form: { kind: "dialog", scope_node_id: 30, has_card_field: false, budget_fields: [{ label: "Daily budget", value: "$20.00" }] },
    });
  });

  it("a script-submitted button in a card form counts as a submit; page amounts and link hrefs are reported", async () => {
    const DOC2 = {
      nodeName: "#document",
      documentURL: "https://shop.example.com/checkout",
      backendNodeId: 1,
      children: [
        {
          localName: "form",
          nodeName: "FORM",
          backendNodeId: 10,
          children: [
            { localName: "input", nodeName: "INPUT", backendNodeId: 11, attributes: ["autocomplete", "cc-number"] },
            { localName: "button", nodeName: "BUTTON", backendNodeId: 13, attributes: ["type", "button"] },
          ],
        },
        { nodeName: "#text", nodeType: 3, nodeValue: "Order total: $20.00" },
        { localName: "div", nodeName: "DIV", backendNodeId: 15, children: [{ nodeName: "#text", nodeType: 3, nodeValue: "Customers also bought: $5.00" }] },
        { localName: "a", nodeName: "A", backendNodeId: 14, attributes: ["href", "/pay/invoice-1"] },
      ],
    };
    const AX2: Record<number, { role: string; name: string }> = {
      13: { role: "button", name: "Submit" },
      14: { role: "link", name: "Pay now" },
    };
    const reply2 = (method: string, params: unknown) => {
      if (method === "DOM.getDocument") return { root: DOC2 };
      if (method === "Accessibility.getPartialAXTree") {
        const id = (params as { backendNodeId: number }).backendNodeId;
        const a = AX2[id];
        return { nodes: a ? [{ backendDOMNodeId: id, role: { value: a.role }, name: { value: a.name } }] : [] };
      }
      return {};
    };
    const { cdp } = await attached(reply2);
    const btn = await executeOp(cdp, { op: "resolve", ref: { frame_session: null, backend_node_id: 13 } }, topUrl);
    expect(btn.result).toMatchObject({ is_submit: true, amounts: ["$20.00"], href: null });
    const link = await executeOp(cdp, { op: "resolve", ref: { frame_session: null, backend_node_id: 14 } }, topUrl);
    expect(link.result).toMatchObject({ role: "link", href: "/pay/invoice-1" });
  });

  it("ref null resolves the focused element; Enter in a form field counts as a submit", async () => {
    const { cdp } = await attached(reply);
    const out = await executeOp(cdp, { op: "resolve", ref: null }, topUrl);
    expect(out.result).toMatchObject({ ref: { frame_session: null, backend_node_id: 11 }, is_submit: true, form: { has_card_field: true } });
  });

  it("a node no longer on the page fails (the backend then refuses the step)", async () => {
    const { cdp } = await attached(reply);
    const out = await executeOp(cdp, { op: "resolve", ref: { frame_session: null, backend_node_id: 999 } }, topUrl);
    expect(out).toMatchObject({ status: "failed", result: { error_code: "no_node" } });
  });

  it("uses only read methods: no page script, no input", async () => {
    const { api, cdp } = await attached(reply);
    await executeOp(cdp, { op: "resolve", ref: { frame_session: null, backend_node_id: 12 } }, topUrl);
    await executeOp(cdp, { op: "resolve", ref: null }, topUrl);
    const methods = new Set(api.sent.map((x) => x.method));
    for (const m of methods) expect(m).toMatch(/^(DOM\.getDocument|Accessibility\.(getPartialAXTree|getFullAXTree))$/);
  });

  it("a malformed resolve op is refused", () => {
    expect(parseOp({ op: "resolve", ref: { frame_session: 3, backend_node_id: 1 } })).toBeNull();
    expect(parseOp({ op: "resolve" })).toBeNull();
    expect(parseOp({ op: "resolve", ref: null })).toEqual({ op: "resolve", ref: null });
  });

  it("a frame session that never attached to our tab is refused", async () => {
    const { cdp } = await attached(reply);
    const out = await executeOp(cdp, { op: "resolve", ref: { frame_session: "not-ours", backend_node_id: 12 } }, topUrl);
    expect(out).toMatchObject({ status: "failed", result: { error_code: "unknown_frame" } });
  });
});

describe("step lines (approved copy)", () => {
  it("reads like the approved examples", () => {
    expect(WORKING_BAR).toBe("Zavi is working in this tab");
    expect(STOPPED_BY_YOU).toBe("Stopped. Here's what I did before you stopped me:");
    expect(stepLine({ op: "nav", url: "https://adsmanager.facebook.com/" }, { pageTitle: "Ads Manager" })).toBe("Opened Ads Manager");
    expect(stepLine({ op: "click_ref", ref: { frame_session: null, backend_node_id: 1 } }, { targetName: "Budget" })).toBe("Clicked Budget");
    expect(stepLine({ op: "type_ref", ref: { frame_session: null, backend_node_id: 1 }, text: "$50" }, {})).toBe("Typed $50");
    expect(stepLine({ op: "scroll", dy: 400 }, {})).toBe("Scrolled down");
    expect(stepLine({ op: "ax_snapshot" }, {})).toBeNull();
  });
});

describe("BrowserControl", () => {
  type Call = { method: string; path: string; body: unknown };
  let calls: Call[];
  let queue: ClaimedOp[];
  let sessionIds: string[];

  beforeEach(() => {
    calls = [];
    queue = [];
    sessionIds = ["sess-1", "sess-2"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const u = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method, path: u.pathname, body });
        const reply = (status: number, json?: unknown) => ({
          status,
          ok: status < 300,
          text: async () => (json === undefined ? "" : JSON.stringify(json)),
        });
        if (u.pathname === "/api/extension/sessions" && method === "POST") return reply(201, { session_id: sessionIds.shift() ?? "sess-n" });
        if (u.pathname === "/api/extension/ops/next") {
          const next = queue.shift();
          if (next) return reply(200, { op: next });
          return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
        }
        return reply(204);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const flush = async () => {
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  function control(api: ReturnType<typeof fakeDebugger>, states: unknown[]) {
    return new BrowserControl({
      tabId: OWN,
      getToken: async () => "tok",
      onChange: (s) => states.push(s),
      debuggerApi: api,
      sessionArea: sessionArea(),
      topUrl,
      tabTitle: async () => "Ads Manager",
    });
  }

  it("opens a session for its own tab and attaches the debugger only when an op arrives", async () => {
    const api = fakeDebugger();
    const c = control(api, []);
    await c.start();
    await flush();
    expect(calls.find((x) => x.path === "/api/extension/sessions")?.body).toEqual({ tab_id: OWN });
    expect(api.attach).not.toHaveBeenCalled();
    await c.stop();
  });

  it("runs an op and posts the result with the delivery's token", async () => {
    const api = fakeDebugger();
    queue.push(claimed({ op: { op: "scroll", dy: 200 } }));
    const states: { working: boolean; lines: string[] }[] = [];
    const c = control(api, states);
    await c.start();
    await flush();
    expect(api.attach).toHaveBeenCalledWith({ tabId: OWN }, "1.3");
    const post = calls.find((x) => x.path === "/api/extension/ops/op-1/result");
    expect(post?.body).toMatchObject({
      session_id: "sess-1",
      run_id: "run-1",
      execution_token: "tok-1",
      status: "done",
      result: { top_url: "https://adsmanager.facebook.com/adsmanager/manage" },
    });
    expect(states.at(-1)).toMatchObject({ working: true, lines: ["Scrolled down"] });
    await c.stop();
  });

  it("Stop ends the session and detaches, and says what it did", async () => {
    const api = fakeDebugger();
    queue.push(claimed({ op: { op: "scroll", dy: 200 } }));
    const states: { working: boolean; stopped: boolean; lines: string[] }[] = [];
    const c = control(api, states);
    await c.start();
    await flush();
    await c.stopTask();
    await flush();
    expect(calls.some((x) => x.method === "DELETE" && x.path === "/api/extension/sessions/sess-1")).toBe(true);
    expect(api.detach).toHaveBeenCalledWith({ tabId: OWN });
    expect(states.at(-1)).toMatchObject({ working: false, stopped: true, lines: ["Scrolled down"] });
    await c.stop();
  });

  it("stop() on unload starts the session DELETE synchronously, before any await", async () => {
    const api = fakeDebugger();
    const c = control(api, []);
    await c.start();
    await flush();
    const before = calls.length;
    void c.stop();
    expect(calls.slice(before).some((x) => x.method === "DELETE" && x.path === "/api/extension/sessions/sess-1")).toBe(true);
  });

  it("a step claimed just before Stop does not run once attach finishes", async () => {
    const api = fakeDebugger();
    let finishAttach!: () => void;
    api.attach = vi.fn(() => new Promise<void>((r) => { finishAttach = r; }));
    queue.push(claimed({ op: { op: "scroll", dy: 200 } }));
    const c = control(api, []);
    await c.start();
    await flush();
    expect(api.attach).toHaveBeenCalled();
    await c.stopTask();
    finishAttach();
    await flush();
    expect(api.sent.some((x) => x.method === "Input.dispatchMouseEvent")).toBe(false);
    expect(api.detach).toHaveBeenCalled();
    await c.stop();
  });

  it("a partial attach (CDP init fails after Chrome attached) leaves no debugger on the tab", async () => {
    const api = fakeDebugger((method) => {
      if (method === "Page.enable") throw new Error("init failed");
      return {};
    });
    queue.push(claimed({ op: { op: "scroll", dy: 200 } }));
    const c = control(api, []);
    await c.start();
    await flush();
    expect(api.attach).toHaveBeenCalled();
    expect(api.detach).toHaveBeenCalledWith({ tabId: OWN });
    expect(calls.find((x) => x.path === "/api/extension/ops/op-1/result")?.body).toMatchObject({ status: "failed" });
    await c.stop();
  });

  it("Chrome detaching us (the person cancelled the bar) ends the task", async () => {
    const api = fakeDebugger();
    queue.push(claimed({ op: { op: "scroll", dy: 200 } }));
    const states: { stopped: boolean }[] = [];
    const c = control(api, states);
    await c.start();
    await flush();
    api.fireDetach({ tabId: OWN }, "canceled_by_user");
    await flush();
    expect(calls.some((x) => x.method === "DELETE")).toBe(true);
    expect(states.at(-1)).toMatchObject({ stopped: true });
    await c.stop();
  });
  it("waits for the page to settle after a click before posting the result", async () => {
    let n = 0;
    const api = fakeDebugger((m) => {
      if (m === "Accessibility.getFullAXTree") {
        n += 1;
        return { nodes: [{ role: { value: "StaticText" }, name: { value: n > 2 ? "Report ready" : "Loading" } }] };
      }
      if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return {};
    });
    queue.push(claimed({ op: { op: "click_ref", ref: { frame_session: null, backend_node_id: 3 } } }));
    const c = control(api, []);
    await c.start();
    const post = await (async () => {
      for (let i = 0; i < 60; i++) {
        const p = calls.find((x) => x.path === "/api/extension/ops/op-1/result");
        if (p) return p;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })();
    expect(post?.body).toMatchObject({ status: "done", result: { settle: { settled: true } } });
    expect(n).toBeGreaterThanOrEqual(3);
    await c.stop();
  });
});

describe("H1 ops", () => {
  const REF = { frame_session: null, backend_node_id: 3 };

  it("parses select_option with exactly one of label / value, and set_checked with a boolean", () => {
    expect(parseOp({ op: "select_option", ref: REF, label: "Daily" })).toEqual({ op: "select_option", ref: REF, label: "Daily" });
    expect(parseOp({ op: "select_option", ref: REF, value: "d" })).toEqual({ op: "select_option", ref: REF, value: "d" });
    expect(parseOp({ op: "select_option", ref: REF })).toBeNull();
    expect(parseOp({ op: "select_option", ref: REF, label: "a", value: "b" })).toBeNull();
    expect(parseOp({ op: "set_checked", ref: REF, checked: true })).toEqual({ op: "set_checked", ref: REF, checked: true });
    expect(parseOp({ op: "set_checked", ref: REF, checked: "yes" })).toBeNull();
  });

  it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"])(
    "presses %s as rawKeyDown (no text) + keyUp",
    async (key) => {
      const { api, cdp } = await attached();
      expect((await executeOp(cdp, { op: "key", key }, topUrl)).status).toBe("done");
      const keys = api.sent.filter((s) => s.method === "Input.dispatchKeyEvent").map((s) => s.params as Record<string, unknown>);
      expect(keys.map((k) => k.type)).toEqual(["rawKeyDown", "keyUp"]);
      expect(keys[0]).toMatchObject({ key });
      expect(keys[0].text).toBeUndefined();
    },
  );

  it("presses Space as the DOM key ' ' with its text", async () => {
    const { api, cdp } = await attached();
    await executeOp(cdp, { op: "key", key: "Space" }, topUrl);
    const k = api.sent.find((s) => s.method === "Input.dispatchKeyEvent")?.params;
    expect(k).toMatchObject({ type: "keyDown", key: " ", code: "Space", text: " " });
  });

  it("refuses a click when a big overlay (not an ancestor) is on top; sends no input", async () => {
    const { api, cdp } = await attached((m, p) => {
      if (m === "DOM.getBoxModel") {
        const id = (p as { backendNodeId: number }).backendNodeId;
        return { model: { content: id === 3 ? [10, 10, 30, 10, 30, 30, 10, 30] : [0, 0, 1000, 0, 1000, 800, 0, 800] } };
      }
      if (m === "DOM.getNodeForLocation") return { backendNodeId: 50 };
      if (m === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
      if (m === "DOM.getDocument") return { root: { backendNodeId: 1, children: [{ backendNodeId: 2, children: [{ backendNodeId: 3 }] }, { backendNodeId: 50 }] } };
      return {};
    });
    const r = await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl);
    expect(r).toMatchObject({ status: "failed", result: { error_code: "click_intercepted" } });
    expect(api.sent.some((s) => s.method.startsWith("Input."))).toBe(false);
  });

  it("clicks when the big element on top is the target's own ancestor (a hidden input under its card)", async () => {
    const { api, cdp } = await attached((m, p) => {
      if (m === "DOM.getBoxModel") {
        const id = (p as { backendNodeId: number }).backendNodeId;
        return { model: { content: id === 3 ? [10, 10, 11, 10, 11, 11, 10, 11] : [0, 0, 1000, 0, 1000, 800, 0, 800] } };
      }
      if (m === "DOM.getNodeForLocation") return { backendNodeId: 2 };
      if (m === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
      if (m === "DOM.getDocument") return { root: { backendNodeId: 1, children: [{ backendNodeId: 2, children: [{ backendNodeId: 3 }] }] } };
      return {};
    });
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).status).toBe("done");
    expect(api.sent.filter((s) => s.method === "Input.dispatchMouseEvent")).toHaveLength(3);
  });

  it("a target gone before any input fails as stale_ref; a throw after input is extension_op_unknown", async () => {
    const gone = await attached((m) => {
      if (m === "DOM.scrollIntoViewIfNeeded") throw new Error("No node found for given backend id");
      return {};
    });
    expect((await executeOp(gone.cdp, { op: "click_ref", ref: REF }, topUrl)).result.error_code).toBe("stale_ref");
    const late = await attached((m) => {
      if (m === "Input.insertText") throw new Error("No node found for given backend id");
      return {};
    });
    const r = await executeOp(late.cdp, { op: "type_ref", ref: REF, text: "x" }, topUrl);
    expect(r.result.error_code).toBe("extension_op_unknown");
  });

  function axCheck(checked: string, role = "checkbox") {
    return { nodes: [{ backendDOMNodeId: 3, role: { value: role }, name: { value: "Alerts" }, properties: [{ name: "checked", value: { value: checked } }] }] };
  }

  it("set_checked: already in the wanted state → no click", async () => {
    const { api, cdp } = await attached((m) => (m === "Accessibility.getPartialAXTree" ? axCheck("true") : {}));
    const r = await executeOp(cdp, { op: "set_checked", ref: REF, checked: true }, topUrl);
    expect(r).toMatchObject({ status: "done", result: { checked: true, changed: false } });
    expect(api.sent.some((s) => s.method.startsWith("Input."))).toBe(false);
  });

  it("set_checked: clicks once and verifies the new state", async () => {
    let clicked = false;
    const { api, cdp } = await attached((m) => {
      if (m === "Accessibility.getPartialAXTree") return axCheck(clicked ? "true" : "false");
      if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (m === "Input.dispatchMouseEvent") clicked = true;
      return {};
    });
    const r = await executeOp(cdp, { op: "set_checked", ref: REF, checked: true }, topUrl);
    expect(r).toMatchObject({ status: "done", result: { checked: true, changed: true } });
    expect(api.sent.filter((s) => s.method === "Input.dispatchMouseEvent")).toHaveLength(3);
  });

  it("set_checked: a radio cannot be cleared; a click that did not take is an unknown outcome", async () => {
    const radio = await attached((m) => (m === "Accessibility.getPartialAXTree" ? axCheck("true", "radio") : {}));
    expect((await executeOp(radio.cdp, { op: "set_checked", ref: REF, checked: false }, topUrl)).result.error_code).toBe("radio_uncheck");
    const stuck = await attached((m) =>
      m === "Accessibility.getPartialAXTree" ? axCheck("false") : m === "DOM.getBoxModel" ? { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } } : {},
    );
    const r = await executeOp(stuck.cdp, { op: "set_checked", ref: REF, checked: true }, topUrl);
    expect(r.result.error_code).toBe("extension_op_unknown");
    expect(String(r.result.error_message)).toContain("still unchecked");
  });

  it("select_option refuses a non-select and names the options when one is missing", async () => {
    const DOC = {
      root: {
        backendNodeId: 1,
        children: [
          { backendNodeId: 3, localName: "select", attributes: ["id", "b"], children: [
            { localName: "option", attributes: ["value", "d"], children: [{ nodeType: 3, nodeValue: "Daily" }] },
            { localName: "option", attributes: ["value", "l"], children: [{ nodeType: 3, nodeValue: "Lifetime" }] },
          ] },
          { backendNodeId: 4, localName: "div" },
        ],
      },
    };
    const { api, cdp } = await attached((m) => (m === "DOM.getDocument" ? DOC : {}));
    const missing = await executeOp(cdp, { op: "select_option", ref: REF, label: "Weekly" }, topUrl);
    expect(missing.result).toMatchObject({ error_code: "no_such_option" });
    expect(String(missing.result.error_message)).toContain("Daily | Lifetime");
    const notSel = await executeOp(cdp, { op: "select_option", ref: { frame_session: null, backend_node_id: 4 }, label: "x" }, topUrl);
    expect(notSel.result.error_code).toBe("not_a_select");
    expect(api.sent.some((s) => s.method.startsWith("Input."))).toBe(false);
  });

  it("select_option types the option label into the focused select and reads the result back", async () => {
    let shown = "Daily";
    const DOC = { root: { backendNodeId: 1, children: [{ backendNodeId: 3, localName: "select", children: [
      { localName: "option", attributes: ["value", "d"], children: [{ nodeType: 3, nodeValue: "Daily" }] },
      { localName: "option", attributes: ["value", "l"], children: [{ nodeType: 3, nodeValue: "Lifetime" }] },
    ] }] } };
    const { api, cdp } = await attached((m) => {
      if (m === "DOM.getDocument") return DOC;
      if (m === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 3, role: { value: "combobox" }, value: { value: shown } }] };
      if (m === "Input.dispatchKeyEvent") shown = "Lifetime";
      return {};
    });
    const r = await executeOp(cdp, { op: "select_option", ref: REF, value: "l" }, topUrl);
    expect(r).toMatchObject({ status: "done", result: { value: "Lifetime", changed: true } });
    const typed = api.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && (s.params as { type: string }).type === "keyDown").map((s) => (s.params as { text: string }).text);
    expect(typed.join("")).toBe("Lifetime");
    expect(api.sent.some((s) => s.method === "Runtime.evaluate")).toBe(false);
  });

  it("type_ref on a date field refuses a non-ISO date before any keystroke", async () => {
    const { api, cdp } = await attached((m) =>
      m === "Accessibility.getPartialAXTree" ? { nodes: [{ backendDOMNodeId: 3, role: { value: "Date" } }] } : {},
    );
    const r = await executeOp(cdp, { op: "type_ref", ref: REF, text: "10/15/2026" }, topUrl);
    expect(r.result.error_code).toBe("bad_date");
    expect(api.sent.some((s) => s.method.startsWith("Input."))).toBe(false);
  });
});

describe("H1 snapshot", () => {
  it("reports value / states / placeholder / near label / in_view, on-screen nodes first", async () => {
    const tree = {
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3", "4", "5", "6"] },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Far" }, backendDOMNodeId: 20 },
        { nodeId: "3", parentId: "1", role: { value: "StaticText" }, name: { value: "Rows per page" }, backendDOMNodeId: 30 },
        { nodeId: "4", parentId: "1", role: { value: "button" }, name: { value: "" }, backendDOMNodeId: 40 },
        {
          nodeId: "5",
          parentId: "1",
          role: { value: "textbox" },
          name: { value: "Nickname", sources: [{ type: "placeholder", value: { value: "e.g. Sam" } }] },
          value: { value: "Kit" },
          backendDOMNodeId: 50,
          properties: [{ name: "required", value: { value: true } }],
        },
        { nodeId: "6", parentId: "1", role: { value: "checkbox" }, name: { value: "Alerts" }, backendDOMNodeId: 60, properties: [{ name: "checked", value: { value: "false" } }, { name: "disabled", value: { value: true } }] },
      ],
    };
    const { cdp } = await attached((m, p) => {
      if (m === "Accessibility.getFullAXTree") return tree;
      if (m === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
      if (m === "DOM.getBoxModel") {
        const id = (p as { backendNodeId: number }).backendNodeId;
        const y = id === 20 ? 3000 : 100;
        return { model: { content: [0, y, 50, y, 50, y + 20, 0, y + 20] } };
      }
      return {};
    });
    const r = await executeOp(cdp, { op: "ax_snapshot" }, topUrl);
    const nodes = r.result.nodes as Record<string, unknown>[];
    expect(nodes.map((n) => n.name)).toEqual(["", "Nickname", "Alerts", "Far"]);
    expect(nodes[0]).toMatchObject({ role: "button", near: "Rows per page", in_view: true });
    expect(nodes[1]).toMatchObject({ value: "Kit", desc: "e.g. Sam", states: ["required"] });
    expect(nodes[2]).toMatchObject({ states: ["unchecked", "disabled"] });
    expect(nodes[3]).toMatchObject({ in_view: false });
    expect(r.result.texts).toEqual(["Rows per page"]);
  });

  it("stays under the JSON size cap on a huge page", async () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ role: { value: "button" }, name: { value: `Button number ${i} ${"x".repeat(60)}` }, backendDOMNodeId: i + 1 }));
    const { cdp } = await attached((m) => (m === "Accessibility.getFullAXTree" ? { nodes: many } : {}));
    const snap = await snapshot(cdp);
    expect(snap.nodes.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(snap.nodes).length).toBeLessThanOrEqual(64_000);
    expect(snap.truncated).toBe(true);
  });
});

describe("H1 settle", () => {
  function fakeClock(): SettleClock & { t: number } {
    const c = {
      t: 0,
      now: () => c.t,
      sleep: async (ms: number) => void (c.t += ms),
      timer: (ms: number) => {
        let h: ReturnType<typeof setTimeout> | undefined;
        const done = new Promise<void>((r) => {
          h = setTimeout(() => {
            c.t += ms;
            r();
          }, 0);
        });
        return { done, cancel: () => clearTimeout(h) };
      },
    };
    return c;
  }
  function pageWith(names: (t: number) => string, clock: { t: number }) {
    return attached((m) => (m === "Accessibility.getFullAXTree" ? { nodes: [{ role: { value: "StaticText" }, name: { value: names(clock.t) } }] } : {}));
  }

  it("a page that changed then went quiet settles early", async () => {
    const clock = fakeClock();
    const { cdp } = await pageWith(() => "after", clock);
    const r = await settle(cdp, topUrl, { sig: "before", busy: false }, clock);
    expect(r.settled).toBe(true);
    expect(r.ms).toBeLessThan(600);
  });

  it("a page that has not reacted yet gets time for a late change (an 800ms fetch)", async () => {
    const clock = fakeClock();
    const { cdp } = await pageWith((t) => (t >= 800 ? "report" : "same"), clock);
    const before = { sig: "", busy: false };
    const { pageSignature } = await import("./perceive");
    before.sig = (await pageSignature(cdp, topUrl))!.sig;
    const r = await settle(cdp, topUrl, before, clock);
    expect(r.settled).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(800 + 400);
  });

  it("a loading indicator keeps it waiting, up to the cap", async () => {
    const clock = fakeClock();
    const { cdp } = await pageWith(() => "Loading…", clock);
    const r = await settle(cdp, topUrl, { sig: "x", busy: false }, clock);
    expect(r).toEqual({ settled: false, ms: SETTLE_MAX_MS });
  });
});

describe("review fixes (#3583)", () => {
  const REF = { frame_session: null, backend_node_id: 3 };
  const docWith = (children: unknown[]) => ({ root: { backendNodeId: 1, localName: "body", children } });
  const hitReply = (hit: number, doc: unknown) => (m: string) => {
    if (m === "DOM.getBoxModel") return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } };
    if (m === "DOM.getNodeForLocation") return { backendNodeId: hit };
    if (m === "DOM.getDocument") return doc;
    return {};
  };

  it("F1: a SMALL unrelated element on top → click_intercepted, no input", async () => {
    const { api, cdp } = await attached(hitReply(50, docWith([{ backendNodeId: 3, localName: "button" }, { backendNodeId: 50, localName: "button" }])));
    const r = await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl);
    expect(r.result.error_code).toBe("click_intercepted");
    expect(api.sent.some((s) => s.method.startsWith("Input."))).toBe(false);
  });

  it("F1: a <label for> the target (or text inside it) on top → clicks", async () => {
    const doc = docWith([
      { backendNodeId: 3, localName: "input", attributes: ["id", "dm", "type", "checkbox"] },
      { backendNodeId: 60, localName: "label", attributes: ["for", "dm"], children: [{ backendNodeId: 61, localName: "span" }] },
    ]);
    for (const hit of [60, 61]) {
      const { api, cdp } = await attached(hitReply(hit, doc));
      expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).status).toBe("done");
      expect(api.sent.filter((s) => s.method === "Input.dispatchMouseEvent")).toHaveLength(3);
    }
  });

  it("B1: a <label> that WRAPS the target (no for) on top → clicks", async () => {
    const doc = docWith([
      { backendNodeId: 60, localName: "label", children: [{ backendNodeId: 3, localName: "input", attributes: ["type", "radio"] }, { backendNodeId: 61, localName: "div", children: [{ backendNodeId: 62, localName: "svg" }] }] },
    ]);
    const { cdp } = await attached(hitReply(62, doc));
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).status).toBe("done");
  });

  it("B1: a wrapping label that names ANOTHER field (for=…) → intercepted", async () => {
    const doc = docWith([
      { backendNodeId: 60, localName: "label", attributes: ["for", "x"], children: [{ backendNodeId: 3, localName: "input", attributes: ["id", "y"] }, { backendNodeId: 61, localName: "div" }] },
    ]);
    const { cdp } = await attached(hitReply(61, doc));
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).result.error_code).toBe("click_intercepted");
  });

  const widget = (sibling: Record<string, unknown>) =>
    docWith([
      { backendNodeId: 10, localName: "div", children: [
        { backendNodeId: 11, localName: "div", children: [
          sibling,
          { backendNodeId: 12, localName: "div", children: [{ backendNodeId: 3, localName: "input", attributes: ["role", "combobox"] }] },
        ] },
      ] },
    ]);
  it("B1: a non-interactive part of the same widget on top → clicks", async () => {
    const { cdp } = await attached(hitReply(70, widget({ backendNodeId: 70, localName: "div", children: [] })));
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).status).toBe("done");
  });

  it("B1: another CONTROL in the same widget on top → intercepted", async () => {
    const { cdp } = await attached(hitReply(70, widget({ backendNodeId: 70, localName: "div", attributes: ["role", "button"] })));
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).result.error_code).toBe("click_intercepted");
  });

  it("B1: a non-interactive overlay that only shares <body> → intercepted (a backdrop)", async () => {
    const doc = docWith([{ backendNodeId: 3, localName: "button" }, { backendNodeId: 70, localName: "div" }]);
    const { cdp } = await attached(hitReply(70, doc));
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).result.error_code).toBe("click_intercepted");
  });

  it("F1: a label for ANOTHER field on top → intercepted", async () => {
    const doc = docWith([
      { backendNodeId: 3, localName: "input", attributes: ["id", "dm"] },
      { backendNodeId: 60, localName: "label", attributes: ["for", "other"] },
    ]);
    const { cdp } = await attached(hitReply(60, doc));
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).result.error_code).toBe("click_intercepted");
  });

  it("F1: something else on top and the DOM cannot be read → intercepted (fail closed)", async () => {
    const { cdp } = await attached((m) => {
      if (m === "DOM.getBoxModel") return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } };
      if (m === "DOM.getNodeForLocation") return { backendNodeId: 50 };
      if (m === "DOM.getDocument") throw new Error("boom");
      return {};
    });
    expect((await executeOp(cdp, { op: "click_ref", ref: REF }, topUrl)).result.error_code).toBe("click_intercepted");
  });

  it("F2: a select whose keystrokes landed on the wrong option → extension_op_unknown", async () => {
    const DOC = { root: { backendNodeId: 1, children: [{ backendNodeId: 3, localName: "select", children: [
      { localName: "option", attributes: ["value", "d"], children: [{ nodeType: 3, nodeValue: "Daily" }] },
      { localName: "option", attributes: ["value", "l"], children: [{ nodeType: 3, nodeValue: "Lifetime" }] },
    ] }] } };
    const { cdp } = await attached((m) => {
      if (m === "DOM.getDocument") return DOC;
      if (m === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 3, role: { value: "combobox" }, value: { value: "Daily" } }] };
      return {};
    });
    const r = await executeOp(cdp, { op: "select_option", ref: { frame_session: null, backend_node_id: 3 }, label: "Lifetime" }, topUrl, {
      clock: undefined,
    });
    expect(r.result.error_code).toBe("extension_op_unknown");
  }, 10_000);

  it("F8: a getFullAXTree that never answers ends the settle at the deadline", async () => {
    const clock = (() => {
      const c = {
        t: 0,
        now: () => c.t,
        sleep: async (ms: number) => void (c.t += ms),
        timer: (ms: number) => {
          let h: ReturnType<typeof setTimeout> | undefined;
          const done = new Promise<void>((r) => {
            h = setTimeout(() => {
              c.t += ms;
              r();
            }, 0);
          });
          return { done, cancel: () => clearTimeout(h) };
        },
      };
      return c;
    })();
    const { cdp } = await attached((m) => (m === "Accessibility.getFullAXTree" ? new Promise(() => undefined) : {}));
    const r = await settle(cdp, topUrl, null, clock);
    expect(r).toEqual({ settled: false, ms: SETTLE_MAX_MS });
  });
});

describe("a key pinned to a focused element (combined review F2)", () => {
  const focusedTree = (id: number) => ({
    nodes: [{ backendDOMNodeId: id, role: { value: "textbox" }, properties: [{ name: "focused", value: { value: true } }] }],
  });

  it("focus moved to another element → focus_changed, no key sent", async () => {
    const { api, cdp } = await attached((m) => (m === "Accessibility.getFullAXTree" ? focusedTree(99) : {}));
    const r = await executeOp(cdp, { op: "key", key: "Enter", focus_ref: { frame_session: null, backend_node_id: 5 } }, topUrl);
    expect(r.result.error_code).toBe("focus_changed");
    expect(api.sent.some((s) => s.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("same element still focused → the key is pressed", async () => {
    const { api, cdp } = await attached((m) => (m === "Accessibility.getFullAXTree" ? focusedTree(5) : {}));
    const r = await executeOp(cdp, { op: "key", key: "Space", focus_ref: { frame_session: null, backend_node_id: 5 } }, topUrl);
    expect(r.status).toBe("done");
    expect(api.sent.filter((s) => s.method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });

  it("pinned to 'nothing focused' but something is → refused", async () => {
    const { cdp } = await attached((m) => (m === "Accessibility.getFullAXTree" ? focusedTree(5) : {}));
    expect((await executeOp(cdp, { op: "key", key: "Enter", focus_ref: null }, topUrl)).result.error_code).toBe("focus_changed");
  });

  it("a malformed focus_ref is refused at parse", () => {
    expect(parseOp({ op: "key", key: "Enter", focus_ref: { backend_node_id: "x" } })).toBeNull();
  });
});
