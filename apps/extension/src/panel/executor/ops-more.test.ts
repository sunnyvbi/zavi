
import { describe, expect, it, vi } from "vitest";
import { ALLOWED_CDP_METHODS, CdpNotAllowedError, OwnTabCdp, type DebuggerApi, type DebuggerTarget } from "./cdp";
import { executeOp, parseOp } from "./ops";
import { isAllowedChord, jpegSize, keyChord, matchOption, modifierMask } from "./ops-more";

const OWN = 7;
type Sent = { target: DebuggerTarget; method: string; params: Record<string, unknown> };

function fake(reply: (method: string, params: Record<string, unknown>, target: DebuggerTarget, api: { fire: (s: DebuggerTarget, m: string, p: unknown) => void }) => unknown = () => ({})) {
  const eventFns: ((s: DebuggerTarget, m: string, p: unknown) => void)[] = [];
  const sent: Sent[] = [];
  const fire = (s: DebuggerTarget, m: string, p: unknown) => eventFns.forEach((f) => f(s, m, p));
  const api: DebuggerApi & { sent: Sent[]; fire: typeof fire } = {
    sent,
    fire,
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (target: DebuggerTarget, method: string, params?: object) => {
      sent.push({ target, method, params: (params ?? {}) as Record<string, unknown> });
      return reply(method, (params ?? {}) as Record<string, unknown>, target, { fire });
    }),
    onEvent: {
      addListener: (fn) => eventFns.push(fn),
      removeListener: (fn) => {
        const i = eventFns.indexOf(fn);
        if (i >= 0) eventFns.splice(i, 1);
      },
    },
    onDetach: { addListener: () => undefined, removeListener: () => undefined },
  };
  return api;
}

async function attached(reply?: Parameters<typeof fake>[0]) {
  const api = fake(reply);
  const cdp = new OwnTabCdp(OWN, api);
  await cdp.attach();
  api.sent.length = 0;
  return { api, cdp };
}

const topUrl = async () => "https://app.example.com/page";
const METRICS = { cssVisualViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 } };
const inputs = (sent: Sent[]) => sent.filter((s) => s.method.startsWith("Input."));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("allowlist (B1)", () => {
  it("adds only the B1 methods, still no page script / network / storage", () => {
    for (const m of [
      "Page.handleJavaScriptDialog",
      "Page.getNavigationHistory",
      "Page.navigateToHistoryEntry",
      "Page.reload",
      "Page.setLifecycleEventsEnabled",
      "Page.getFrameTree",
      "DOMSnapshot.captureSnapshot",
      "Input.setInterceptDrags",
      "Input.dispatchDragEvent",
    ]) {
      expect(ALLOWED_CDP_METHODS.has(m)).toBe(true);
    }
    for (const m of ALLOWED_CDP_METHODS) expect(m).not.toMatch(/^(Runtime|Network|Storage|Fetch|Debugger)\./);
  });

  it("still refuses Runtime.evaluate", async () => {
    const { cdp } = await attached();
    await expect(cdp.send("Runtime.evaluate", {})).rejects.toBeInstanceOf(CdpNotAllowedError);
  });
});

describe("parseOp (B1 shapes)", () => {
  const ref = { frame_session: null, backend_node_id: 5 };
  const pt = { x: 10, y: 20, shot_w: 100, shot_h: 80 };

  it.each([
    [{ op: "key_chord", key: "a", modifiers: ["Mod"] }, true],
    [{ op: "key_chord", key: "Enter", modifiers: ["Control"] }, true],
    [{ op: "key_chord", key: "Tab", modifiers: ["Shift"] }, true],
    [{ op: "key_chord", key: "ArrowLeft", modifiers: ["Alt"] }, true],
    [{ op: "key_chord", key: "Backspace", modifiers: [] }, true],
    [{ op: "key_chord", key: "w", modifiers: ["Control"] }, false],
    [{ op: "key_chord", key: "q", modifiers: ["Meta"] }, false],
    [{ op: "key_chord", key: "a", modifiers: ["Control", "Shift"] }, false],
    [{ op: "key_chord", key: "a", modifiers: [] }, false],
    [{ op: "key_chord", key: "Tab", modifiers: ["Control"] }, false],
    [{ op: "key_chord", key: "toString", modifiers: [] }, false],
  ])("chord %j → %s", (op, ok) => {
    expect(parseOp(op) !== null).toBe(ok);
  });

  it("click variants are validated", () => {
    expect(parseOp({ op: "click_ref", ref, button: "right" })).toMatchObject({ button: "right" });
    expect(parseOp({ op: "click_ref", ref, click_count: 2, modifiers: ["Shift"] })).toMatchObject({ click_count: 2, modifiers: ["Shift"] });
    expect(parseOp({ op: "click_ref", ref, button: "middle" })).toBeNull();
    expect(parseOp({ op: "click_ref", ref, click_count: 4 })).toBeNull();
    expect(parseOp({ op: "click_ref", ref, modifiers: ["Hyper"] })).toBeNull();
  });

  it("coordinates must sit inside the screenshot they name", () => {
    expect(parseOp({ op: "click_xy", ...pt })).not.toBeNull();
    expect(parseOp({ op: "click_xy", ...pt, x: 101 })).toBeNull();
    expect(parseOp({ op: "click_xy", ...pt, shot_w: 0 })).toBeNull();
    expect(parseOp({ op: "drag_xy", ...pt, to_x: 50, to_y: 81 })).toBeNull();
    expect(parseOp({ op: "click_xy", ...pt, hit_ref: { bogus: 1 } })).toBeNull();
  });

  it("wait_until waits on exactly one thing, at most 10s", () => {
    expect(parseOp({ op: "wait_until", text: "Done", timeout_ms: 5000 })).not.toBeNull();
    expect(parseOp({ op: "wait_until", text: "Done", network_quiet: true, timeout_ms: 5000 })).toBeNull();
    expect(parseOp({ op: "wait_until", timeout_ms: 5000 })).toBeNull();
    expect(parseOp({ op: "wait_until", text: "Done", timeout_ms: 10_001 })).toBeNull();
  });

  it("history_go and reload carry http(s) urls only", () => {
    expect(parseOp({ op: "history_go", entry_id: 3, url: "https://a.com/x" })).not.toBeNull();
    expect(parseOp({ op: "history_go", entry_id: 3, url: "javascript:alert(1)" })).toBeNull();
    expect(parseOp({ op: "reload", expect_url: "file:///etc/passwd" })).toBeNull();
  });
});

describe("JS dialogs (always accepted)", () => {
  it("a dialog opened by a click is accepted on the session that opened it, and reported", async () => {
    const { api, cdp } = await attached((m, p, t, f) => {
      if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (m === "DOM.getNodeForLocation") return { backendNodeId: 5 };
      if (m === "Input.dispatchMouseEvent" && p.type === "mouseReleased") {
        f.fire({ tabId: OWN }, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete row?" });
      }
      return {};
    });
    const r = await executeOp(cdp, { op: "click_ref", ref: { frame_session: null, backend_node_id: 5 } }, topUrl);
    await flush();
    const h = api.sent.find((s) => s.method === "Page.handleJavaScriptDialog");
    expect(h?.params).toEqual({ accept: true });
    expect(r.status).toBe("done");
    expect(r.result.dialogs).toEqual([{ type: "confirm", message: "Delete row?" }]);
  });

  it("a prompt() gets the step's dialog_text, else an empty answer", async () => {
    const fireOn = (text?: string) =>
      attached((m, p, t, f) => {
        if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        if (m === "DOM.getNodeForLocation") return { backendNodeId: 5 };
        if (m === "Input.dispatchMouseEvent" && p.type === "mouseReleased") f.fire({ tabId: OWN }, "Page.javascriptDialogOpening", { type: "prompt", message: "Name?" });
        return {};
      }).then(async ({ api, cdp }) => {
        await executeOp(cdp, { op: "click_ref", ref: { frame_session: null, backend_node_id: 5 }, ...(text !== undefined ? { dialog_text: text } : {}) }, topUrl);
        await flush();
        return api.sent.find((s) => s.method === "Page.handleJavaScriptDialog")?.params;
      });
    expect(await fireOn("Zavi")).toEqual({ accept: true, promptText: "Zavi" });
    expect(await fireOn()).toEqual({ accept: true, promptText: "" });
  });

  it("a beforeunload dialog in a child frame is answered on that frame's session", async () => {
    const { api, cdp } = await attached();
    api.fire({ tabId: OWN }, "Target.attachedToTarget", { sessionId: "child-1" });
    api.fire({ tabId: OWN, sessionId: "child-1" }, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
    await flush();
    const h = api.sent.find((s) => s.method === "Page.handleJavaScriptDialog");
    expect(h?.target).toEqual({ tabId: OWN, sessionId: "child-1" });
    expect(cdp.takeDialogs()).toEqual([{ type: "beforeunload", message: "" }]);
  });

  it("ignores dialogs from another tab", async () => {
    const { api } = await attached();
    api.fire({ tabId: OWN + 1 }, "Page.javascriptDialogOpening", { type: "alert", message: "x" });
    await flush();
    expect(api.sent.some((s) => s.method === "Page.handleJavaScriptDialog")).toBe(false);
  });
});

describe("pointer", () => {
  const boxReply = (m: string) =>
    m === "DOM.getBoxModel" ? { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } } : m === "DOM.getNodeForLocation" ? { backendNodeId: 5 } : m === "Page.getLayoutMetrics" ? METRICS : {};

  it("double click = two press/release pairs with clickCount 1 then 2", async () => {
    const { api, cdp } = await attached(boxReply);
    await executeOp(cdp, { op: "click_ref", ref: { frame_session: null, backend_node_id: 5 }, click_count: 2 }, topUrl);
    const presses = inputs(api.sent).filter((s) => s.params.type === "mousePressed");
    expect(presses.map((s) => s.params.clickCount)).toEqual([1, 2]);
  });

  it("right click uses the right button; modifiers become the CDP bitmask", async () => {
    const { api, cdp } = await attached(boxReply);
    await executeOp(cdp, { op: "click_ref", ref: { frame_session: null, backend_node_id: 5 }, button: "right", modifiers: ["Control", "Shift"] }, topUrl);
    const press = inputs(api.sent).find((s) => s.params.type === "mousePressed");
    expect(press?.params).toMatchObject({ button: "right", modifiers: 2 | 8 });
    expect(modifierMask(["Mod"], true)).toBe(4);
    expect(modifierMask(["Mod"], false)).toBe(2);
  });

  it("click_xy maps screenshot pixels onto CSS pixels", async () => {
    const { api, cdp } = await attached(boxReply);
    const r = await executeOp(cdp, { op: "click_xy", x: 100, y: 50, shot_w: 500, shot_h: 400 }, topUrl);
    expect(r.status).toBe("done");
    const press = inputs(api.sent).find((s) => s.params.type === "mousePressed");
    expect(press?.params).toMatchObject({ x: 200, y: 100 });
  });

  it("click_xy pinned to a node refuses when something else is there now", async () => {
    const { api, cdp } = await attached((m) => (m === "DOM.getNodeForLocation" ? { backendNodeId: 99 } : m === "Page.getLayoutMetrics" ? METRICS : {}));
    const r = await executeOp(cdp, { op: "click_xy", x: 1, y: 1, shot_w: 10, shot_h: 10, hit_ref: { frame_session: null, backend_node_id: 5 } }, topUrl);
    expect(r.result.error_code).toBe("target_changed");
    expect(inputs(api.sent)).toHaveLength(0);
  });

  it("hover moves the pointer and presses nothing", async () => {
    const { api, cdp } = await attached(boxReply);
    await executeOp(cdp, { op: "hover_ref", ref: { frame_session: null, backend_node_id: 5 } }, topUrl);
    expect(inputs(api.sent).map((s) => s.params.type)).toEqual(["mouseMoved"]);
  });
});

describe("drag", () => {
  const two = (m: string, p: Record<string, unknown>) =>
    m === "DOM.getBoxModel"
      ? p.backendNodeId === 5
        ? { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } }
        : { model: { content: [100, 0, 120, 0, 120, 20, 100, 20] } }
      : m === "DOM.getNodeForLocation"
        ? { backendNodeId: (p.x as number) < 50 ? 5 : 6 }
        : {};

  it("pointer drag: press, 8 moves, release at the target", async () => {
    const { api, cdp } = await attached(two);
    const r = await executeOp(cdp, { op: "drag_ref", ref: { frame_session: null, backend_node_id: 5 }, to_ref: { frame_session: null, backend_node_id: 6 } }, topUrl);
    expect(r.result.drag).toBe("pointer");
    const ev = inputs(api.sent).filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(ev.filter((s) => s.params.type === "mouseMoved" && s.params.button === "left")).toHaveLength(8);
    expect(ev.at(-1)?.params).toMatchObject({ type: "mouseReleased", x: 110, y: 10 });
    expect(api.sent.at(-1)).toMatchObject({ method: "Input.setInterceptDrags", params: { enabled: false } });
  });

  it("native HTML5 drag: intercepted data is dropped with dispatchDragEvent", async () => {
    const data = { items: [{ mimeType: "text/plain", data: "a" }], dragOperationsMask: 1 };
    const { api, cdp } = await attached((m, p, t, f) => {
      if (m === "Input.dispatchMouseEvent" && p.type === "mouseMoved" && p.button === "left") f.fire({ tabId: OWN }, "Input.dragIntercepted", { data });
      return two(m, p);
    });
    const r = await executeOp(cdp, { op: "drag_ref", ref: { frame_session: null, backend_node_id: 5 }, to_ref: { frame_session: null, backend_node_id: 6 } }, topUrl);
    expect(r.result.drag).toBe("native");
    const drags = api.sent.filter((s) => s.method === "Input.dispatchDragEvent");
    expect(drags.map((s) => s.params.type)).toEqual(["dragEnter", "dragOver", "drop"]);
    expect(drags[2].params).toMatchObject({ x: 110, y: 10, data });
  });

  it("drag_ref refuses when something covers the drop target", async () => {
    const { api, cdp } = await attached((m, p) => (m === "DOM.getNodeForLocation" ? { backendNodeId: (p.x as number) < 50 ? 5 : 99 } : two(m, p)));
    const r = await executeOp(cdp, { op: "drag_ref", ref: { frame_session: null, backend_node_id: 5 }, to_ref: { frame_session: null, backend_node_id: 6 } }, topUrl);
    expect(r.result.error_code).toBe("click_intercepted");
    expect(inputs(api.sent)).toHaveLength(0);
  });

  it("drag_xy pinned at the drop point refuses when something else is there now", async () => {
    const { api, cdp } = await attached((m, p) =>
      m === "DOM.getNodeForLocation" ? { backendNodeId: (p.x as number) < 50 ? 5 : 99 } : m === "Page.getLayoutMetrics" ? METRICS : {},
    );
    const r = await executeOp(
      cdp,
      { op: "drag_xy", x: 1, y: 1, to_x: 90, to_y: 1, shot_w: 100, shot_h: 80, hit_ref: { frame_session: null, backend_node_id: 5 }, to_hit_ref: { frame_session: null, backend_node_id: 6 } },
      topUrl,
    );
    expect(r.result.error_code).toBe("target_changed");
    expect(inputs(api.sent)).toHaveLength(0);
  });

  it("a drag that fails after input reached the page is an unknown outcome", async () => {
    let n = 0;
    const { cdp } = await attached((m, p) => {
      if (m === "Input.dispatchMouseEvent" && p.type === "mouseMoved" && p.button === "left" && ++n === 3) throw new Error("boom");
      return two(m, p);
    });
    const r = await executeOp(cdp, { op: "drag_ref", ref: { frame_session: null, backend_node_id: 5 }, to_ref: { frame_session: null, backend_node_id: 6 } }, topUrl);
    expect(r.result.error_code).toBe("extension_op_unknown");
  });
});

describe("key chords", () => {
  it("mac: Cmd+A carries the selectAll command; other platforms do not (no double action)", async () => {
    const mac = await attached();
    await keyChord(mac.cdp, { dispatched: false }, "a", ["Mod"], true);
    const keyA = mac.api.sent.find((s) => s.params.key === "a" && s.params.type === "rawKeyDown");
    expect(keyA?.params).toMatchObject({ modifiers: 4, commands: ["selectAll"] });
    const win = await attached();
    await keyChord(win.cdp, { dispatched: false }, "a", ["Mod"], false);
    const keyA2 = win.api.sent.find((s) => s.params.key === "a" && s.params.type === "rawKeyDown");
    expect(keyA2?.params).toMatchObject({ modifiers: 2 });
    expect(keyA2?.params.commands).toBeUndefined();
  });

  it("modifiers go down in order and come up in reverse", async () => {
    const { api, cdp } = await attached();
    await keyChord(cdp, { dispatched: false }, "Tab", ["Shift"], false);
    expect(api.sent.map((s) => `${s.params.type}:${s.params.key}`)).toEqual(["rawKeyDown:Shift", "rawKeyDown:Tab", "keyUp:Tab", "keyUp:Shift"]);
  });

  it("paste is refused, even right after a Mod+C", async () => {
    const { api, cdp } = await attached();
    const before = await executeOp(cdp, { op: "key_chord", key: "v", modifiers: ["Mod"] }, topUrl);
    expect(before.result.error_code).toBe("paste_not_allowed");
    await executeOp(cdp, { op: "key_chord", key: "c", modifiers: ["Mod"] }, topUrl);
    api.sent.length = 0;
    const after = await executeOp(cdp, { op: "key_chord", key: "v", modifiers: ["Control"] }, topUrl);
    expect(after.result.error_code).toBe("paste_not_allowed");
    expect(inputs(api.sent)).toHaveLength(0);
  });

  it("isAllowedChord rejects duplicates", () => {
    expect(isAllowedChord("a", ["Mod", "Mod"])).toBe(false);
  });
});

describe("back / forward / reload", () => {
  const hist = { currentIndex: 1, entries: [{ id: 10, url: "https://a.com/1" }, { id: 11, url: "https://a.com/2" }, { id: 12, url: "https://a.com/3" }] };

  it("nav_history reports the entries behind and ahead", async () => {
    const { cdp } = await attached((m) => (m === "Page.getNavigationHistory" ? hist : {}));
    const r = await executeOp(cdp, { op: "nav_history" }, topUrl);
    expect(r.result).toMatchObject({ back: { entry_id: 10, url: "https://a.com/1" }, forward: { entry_id: 12, url: "https://a.com/3" } });
  });

  it("history_go refuses an entry whose url changed", async () => {
    const { api, cdp } = await attached((m) => (m === "Page.getNavigationHistory" ? hist : {}));
    const r = await executeOp(cdp, { op: "history_go", entry_id: 10, url: "https://evil.com/" }, topUrl);
    expect(r.result.error_code).toBe("history_changed");
    expect(api.sent.some((s) => s.method === "Page.navigateToHistoryEntry")).toBe(false);
  });

  it("reload refuses when the tab is not on the url that was checked", async () => {
    const { api, cdp } = await attached();
    const r = await executeOp(cdp, { op: "reload", expect_url: "https://other.com/" }, topUrl);
    expect(r.result.error_code).toBe("url_changed");
    expect(api.sent.some((s) => s.method === "Page.reload")).toBe(false);
  });
});

describe("get_page_text", () => {
  const strings = ["", "#text", "SCRIPT", "DIV", "Row A", "evil()", "Row B", "hunter2", "INPUT", "cell 2"];
  const doc = {
    scrollOffsetY: 1000,
    nodes: {
      parentIndex: [-1, 0, 1, 0, 3, 0, 5, 0, 3],
      nodeType: [9, 1, 3, 1, 3, 1, 3, 1, 3],
      nodeName: [0, 2, 1, 3, 1, 3, 1, 8, 1],
      inputValue: { index: [7], value: [7] },
    },
    layout: {
      nodeIndex: [2, 4, 6, 8],
      bounds: [[0, 0, 10, 10], [0, 10, 50, 10], [0, 1100, 50, 10], [60, 1101, 50, 10]],
      text: [5, 4, 6, 9],
    },
  };

  it("on-screen lines first, row pieces joined, no scripts, never form values", async () => {
    const { cdp } = await attached((m) =>
      m === "DOMSnapshot.captureSnapshot" ? { documents: [doc], strings } : m === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 1000 } } : {},
    );
    const r = await executeOp(cdp, { op: "get_page_text" }, topUrl);
    expect(r.result.text).toBe("Row B cell 2\nRow A");
    expect(String(r.result.text)).not.toContain("evil");
    expect(String(r.result.text)).not.toContain("hunter2");
  });

  it("bounded by max_chars", async () => {
    const { cdp } = await attached((m) => (m === "DOMSnapshot.captureSnapshot" ? { documents: [doc], strings } : {}));
    const r = await executeOp(cdp, { op: "get_page_text", max_chars: 8 }, topUrl);
    expect(r.result.truncated).toBe(true);
    expect(String(r.result.text).length).toBeLessThanOrEqual(8);
  });
});

describe("wait_until network quiet", () => {
  it("met once the top frame reports networkAlmostIdle after its last init", async () => {
    const { api, cdp } = await attached((m) => (m === "Page.getFrameTree" ? { frameTree: { frame: { id: "F" } } } : {}));
    api.fire({ tabId: OWN }, "Page.lifecycleEvent", { frameId: "F", name: "init" });
    expect(cdp.isNetworkIdle()).toBe(false);
    api.fire({ tabId: OWN }, "Page.lifecycleEvent", { frameId: "OTHER", name: "networkAlmostIdle" });
    expect(cdp.isNetworkIdle()).toBe(false);
    api.fire({ tabId: OWN }, "Page.lifecycleEvent", { frameId: "F", name: "networkAlmostIdle" });
    const r = await executeOp(cdp, { op: "wait_until", network_quiet: true, timeout_ms: 0 }, topUrl);
    expect(r.result.met).toBe(true);
  });

  it("times out honestly when the page never reported", async () => {
    const { cdp } = await attached();
    const r = await executeOp(cdp, { op: "wait_until", network_quiet: true, timeout_ms: 0 }, topUrl);
    expect(r.result.error_code).toBe("wait_timeout");
  });
});

describe("resolve at a point", () => {
  it("a hit on a span inside a button resolves the button (what a person clicks)", async () => {
    const DOC = {
      nodeName: "#document",
      documentURL: "https://shop.example.com/cart",
      backendNodeId: 1,
      children: [{ nodeName: "BUTTON", localName: "button", backendNodeId: 2, attributes: ["type", "button"], children: [{ nodeName: "SPAN", localName: "span", backendNodeId: 3, children: [] }] }],
    };
    const { cdp } = await attached((m, p) => {
      if (m === "Page.getLayoutMetrics") return METRICS;
      if (m === "DOM.getNodeForLocation") return { backendNodeId: 3 };
      if (m === "DOM.getDocument") return { root: DOC };
      if (m === "Accessibility.getPartialAXTree") {
        const id = p.backendNodeId;
        return id === 2
          ? { nodes: [{ backendDOMNodeId: 2, role: { value: "button" }, name: { value: "Pay now" } }] }
          : { nodes: [{ backendDOMNodeId: id, role: { value: "generic" }, name: { value: "" } }] };
      }
      return {};
    });
    const r = await executeOp(cdp, { op: "resolve", ref: null, at: { x: 5, y: 5, shot_w: 100, shot_h: 80 } }, topUrl);
    expect(r.result).toMatchObject({ name: "Pay now", role: "button", hit_kind: "element", hit_ref: { backend_node_id: 3 }, ref: { backend_node_id: 2 } });
  });

  it("a canvas hit is reported as canvas", async () => {
    const DOC = { nodeName: "#document", documentURL: "https://draw.example.com/", backendNodeId: 1, children: [{ nodeName: "CANVAS", localName: "canvas", backendNodeId: 4, children: [] }] };
    const { cdp } = await attached((m) =>
      m === "Page.getLayoutMetrics" ? METRICS : m === "DOM.getNodeForLocation" ? { backendNodeId: 4 } : m === "DOM.getDocument" ? { root: DOC } : m === "Accessibility.getPartialAXTree" ? { nodes: [{ backendDOMNodeId: 4, role: { value: "generic" } }] } : {},
    );
    const r = await executeOp(cdp, { op: "resolve", ref: null, at: { x: 5, y: 5, shot_w: 100, shot_h: 80 } }, topUrl);
    expect(r.result.hit_kind).toBe("canvas");
  });
});

describe("helpers", () => {
  it("jpegSize reads a SOF0 header", () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0];
    expect(jpegSize(btoa(String.fromCharCode(...bytes)))).toEqual({ w: 640, h: 400 });
  });

  it("matchOption: exact first, else a unique prefix / substring, never a guess between two", () => {
    const o = (name: string, id: number) => ({ name, ref: { frame_session: null, backend_node_id: id } });
    const opts = [o("Chocolate", 1), o("Strawberry", 2), o("Strawberry jam", 3), o("Vanilla", 4)];
    expect(matchOption(opts, "strawberry")?.ref.backend_node_id).toBe(2);
    expect(matchOption(opts, "choc")?.ref.backend_node_id).toBe(1);
    expect(matchOption(opts, "straw")).toBeNull();
  });
});

describe("perception (e2e:sites findings)", () => {
  it("an element under 1px is not reported as on screen", async () => {
    const { snapshot } = await import("./perceive");
    const { cdp } = await attached((m, p) => {
      if (m === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            { nodeId: "1", childIds: ["2", "3"], role: { value: "RootWebArea" } },
            { nodeId: "2", parentId: "1", role: { value: "combobox" }, name: { value: "" }, backendDOMNodeId: 20 },
            { nodeId: "3", parentId: "1", role: { value: "combobox" }, name: { value: "Real" }, backendDOMNodeId: 30 },
          ],
        };
      }
      if (m === "Page.getLayoutMetrics") return METRICS;
      if (m === "DOM.getBoxModel") {
        return p.backendNodeId === 20
          ? { model: { border: [469, 180, 469.01, 180, 469.01, 180.18, 469, 180.18] } }
          : { model: { border: [10, 10, 200, 10, 200, 40, 10, 40] } };
      }
      return {};
    });
    const snap = await snapshot(cdp);
    expect(snap.nodes.map((n) => [n.name, n.in_view])).toEqual([["Real", true], ["", false]]);
  });
});

describe("choose keyboard fallback", () => {
  const trigger = (expanded: boolean) => ({
    nodes: [{ backendDOMNodeId: 5, role: { value: "combobox" }, name: { value: "Country" }, properties: [{ name: "expanded", value: { value: expanded } }] }],
  });
  const reply = (expandedAfter: boolean) => {
    let axCalls = 0;
    return (m: string) => {
      if (m === "Accessibility.getPartialAXTree") return trigger(++axCalls > 1 ? expandedAfter : false);
      if (m === "Accessibility.getFullAXTree") return { nodes: [] };
      if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } };
      if (m === "DOM.getNodeForLocation") return { backendNodeId: 5 };
      return {};
    };
  };

  it("no list open after ArrowDown → no Enter is pressed", async () => {
    const { api, cdp } = await attached(reply(false));
    const r = await executeOp(cdp, { op: "choose", ref: { frame_session: null, backend_node_id: 5 }, option: "Peru" }, topUrl);
    expect(api.sent.some((s) => s.method === "Input.dispatchKeyEvent" && s.params.key === "Enter")).toBe(false);
    expect(r.status).toBe("failed");
  }, 15_000);

  it("list open but no matching option → no Enter, no_such_option", async () => {
    const { api, cdp } = await attached(reply(true));
    const r = await executeOp(cdp, { op: "choose", ref: { frame_session: null, backend_node_id: 5 }, option: "Peru" }, topUrl);
    expect(api.sent.some((s) => s.method === "Input.dispatchKeyEvent" && s.params.key === "Enter")).toBe(false);
    expect(r.status).toBe("failed");
  }, 15_000);
});
