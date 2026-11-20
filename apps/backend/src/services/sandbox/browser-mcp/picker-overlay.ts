
import { chromium } from "playwright-core";

export const PICKER_OVERLAY_SCRIPT = String.raw`
(function () {
  var MARK = "data-praxis-picker";
  if (window.__praxisPickerInstalled) return;
  window.__praxisPickerInstalled = true;

  var picking = false;

  // Self-owned highlight box: fixed, pointer-events:none so it never intercepts
  // the operator's pointer and never becomes an event target.
  var box = document.createElement("div");
  box.setAttribute(MARK, "highlight");
  box.style.cssText =
    "position:fixed;z-index:2147483646;pointer-events:none;display:none;top:0;left:0;" +
    "background:rgba(37,99,235,0.18);border:1px solid rgba(37,99,235,0.9);border-radius:2px;";

  // Self-owned toggle button — the ONLY visible affordance; needs no web change.
  var btn = document.createElement("button");
  btn.setAttribute(MARK, "toggle");
  btn.type = "button";
  btn.style.cssText =
    "position:fixed;z-index:2147483647;bottom:12px;right:12px;padding:6px 10px;" +
    "font:600 12px system-ui,-apple-system,sans-serif;color:#fff;background:#2563eb;" +
    "border:none;border-radius:6px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.3);";
  function label() { btn.textContent = picking ? "Click an element…" : "Pick element"; }
  label();

  function mount() {
    var root = document.body || document.documentElement;
    if (!root) return;
    if (!box.isConnected) root.appendChild(box);
    if (!btn.isConnected) root.appendChild(btn);
  }

  function isOurs(el) {
    return !!(el && el.closest && el.closest("[" + MARK + "]"));
  }

  // Build a stable CSS path: prefer a syntactically-safe #id (unique → stop),
  // else tag + up-to-3 structural classes + :nth-child when siblings collide.
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var tag = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift("#" + node.id);
        break;
      }
      var seg = tag;
      if (node.classList && node.classList.length) {
        var cls = Array.prototype.slice
          .call(node.classList)
          .filter(function (c) { return /^[A-Za-z_-][\w-]*$/.test(c); })
          .slice(0, 3);
        if (cls.length) seg += "." + cls.join(".");
      }
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) {
          seg += ":nth-child(" + (Array.prototype.indexOf.call(parent.children, node) + 1) + ")";
        }
      }
      parts.unshift(seg);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  // ONLY structural/layout properties — never text, never input values.
  var STYLE_KEYS = [
    "display","position","flexDirection","justifyContent","alignItems",
    "gridTemplateColumns","width","height",
    "marginTop","marginRight","marginBottom","marginLeft",
    "paddingTop","paddingRight","paddingBottom","paddingLeft",
    "fontSize","fontWeight","color","backgroundColor"
  ];
  function structuralStyles(el) {
    var out = {};
    try {
      var cs = window.getComputedStyle(el);
      if (!cs) return out;
      for (var i = 0; i < STYLE_KEYS.length; i++) {
        var v = cs[STYLE_KEYS[i]];
        if (v != null && v !== "") out[STYLE_KEYS[i]] = String(v).slice(0, 64);
      }
    } catch (e) {}
    return out;
  }

  function pick(el) {
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    var testid = null;
    try { testid = el.getAttribute("data-testid"); } catch (e) {}
    window.__praxis_picked = {
      selector: cssPath(el).slice(0, 1024),
      tag: el.tagName.toLowerCase(),
      testid: testid || null,
      styles: structuralStyles(el)
    };
  }

  function setPicking(on) {
    picking = !!on;
    if (!picking) box.style.display = "none";
    label();
  }

  function onMove(e) {
    if (!picking) return;
    var el = e.target;
    if (!el || isOurs(el)) { box.style.display = "none"; return; }
    var r;
    try { r = el.getBoundingClientRect(); } catch (err) { return; }
    box.style.display = "block";
    box.style.top = r.top + "px";
    box.style.left = r.left + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  function onClick(e) {
    if (!picking) return;
    var el = e.target;
    if (isOurs(el)) return; // our own button handles itself
    // Swallow the click so it NEVER submits a form / follows a link / fires the
    // page's own handlers — the pick is purely observational.
    e.preventDefault();
    e.stopPropagation();
    pick(el);
    setPicking(false);
  }

  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setPicking(!picking);
  }, true);

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && picking) setPicking(false);
  }, true);

  mount();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
})();
`;

export interface PickerOverlayInjector {
  inject(args: { cdpUrl: string }): Promise<void>;
}

function createCdpInjector(): PickerOverlayInjector {
  return {
    async inject({ cdpUrl }) {
      const browser = await chromium.connectOverCDP(cdpUrl);
      try {
        const ctx = browser.contexts()[0] ?? (await browser.newContext());
        await ctx.addInitScript(PICKER_OVERLAY_SCRIPT);
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.evaluate(PICKER_OVERLAY_SCRIPT).catch(() => {
        });
      } finally {
        await browser.close().catch(() => {
        });
      }
    },
  };
}

let injectorImpl: PickerOverlayInjector | null = null;
let defaultInjector: PickerOverlayInjector | null = null;

export function _setPickerOverlayInjector(i: PickerOverlayInjector | null): void {
  injectorImpl = i;
}

export function getPickerOverlayInjector(): PickerOverlayInjector {
  if (injectorImpl) return injectorImpl;
  if (!defaultInjector) defaultInjector = createCdpInjector();
  return defaultInjector;
}

export interface PickedElement {
  selector: string;
  tag: string;
  testid: string | null;
  styles: Record<string, string>;
}

const STRUCTURAL_STYLE_KEYS: ReadonlySet<string> = new Set([
  "display", "position", "flexDirection", "justifyContent", "alignItems",
  "gridTemplateColumns", "width", "height",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontSize", "fontWeight", "color", "backgroundColor",
]);

const MAX_SELECTOR_LEN = 1024;
const MAX_TESTID_LEN = 128;
const MAX_TAG_LEN = 32;
const MAX_STYLE_VALUE_LEN = 64;

export function sanitizePickedElement(raw: unknown): PickedElement | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const selector =
    typeof o.selector === "string" ? o.selector.slice(0, MAX_SELECTOR_LEN) : "";
  if (!selector) return null;

  const tag =
    typeof o.tag === "string" ? o.tag.slice(0, MAX_TAG_LEN).toLowerCase() : "";
  const testid =
    typeof o.testid === "string" ? o.testid.slice(0, MAX_TESTID_LEN) : null;

  const styles: Record<string, string> = {};
  if (o.styles && typeof o.styles === "object" && !Array.isArray(o.styles)) {
    for (const [k, v] of Object.entries(o.styles as Record<string, unknown>)) {
      if (!STRUCTURAL_STYLE_KEYS.has(k)) continue;
      if (typeof v !== "string") continue;
      styles[k] = v.slice(0, MAX_STYLE_VALUE_LEN);
    }
  }

  return { selector, tag, testid, styles };
}
