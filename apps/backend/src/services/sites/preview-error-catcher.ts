export const PREVIEW_ERROR_CATCHER_SOURCE = String.raw`(function () {
  try {
    if (window.parent === window || window.__zaviErrorCatcher) return;
    window.__zaviErrorCatcher = true;
  } catch (e) {
    return;
  }
  var ALLOWED = /^(?:https:\/\/(?:www\.|latest\.)?zaviagent\.com|http:\/\/(?:localhost|127\.0\.0\.1):30\d{2})$/;
  var MAX = 20;
  var MESSAGE_MAX = 500;
  var STACK_MAX = 2000;
  var STACK_LINES = 12;
  var errors = [];
  var parentOrigin = null;
  var timer = null;
  function scrub(text) {
    return String(text == null ? "" : text)
      .replace(/(https?:\/\/[^\s?#"'()<>]+)\?[^\s#"'()<>]*?((?::\d+){0,2})(?=[\s#"'()<>]|$)/g, "$1$2")
      .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted]")
      .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[redacted]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(/((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|access[_-]?key|client[_-]?secret|signature)["']?\s*[:=]\s*["']?)[^\s"',;&)]+/gi, "$1[redacted]")
      .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
  }
  function clip(text, max) {
    var s = scrub(text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  function page() {
    try {
      return location.pathname || "/";
    } catch (e) {
      return "/";
    }
  }
  function ours(text) {
    return /zavi-editor-runtime|zavi-picker|__zaviErrorCatcher/.test(String(text || ""));
  }
  function flush() {
    timer = null;
    if (!parentOrigin) return;
    try {
      window.parent.postMessage({ type: "zavi:preview-errors", errors: errors.slice() }, parentOrigin);
    } catch (e) {}
  }
  function schedule() {
    if (!parentOrigin || timer) return;
    timer = setTimeout(flush, 50);
  }
  function record(kind, message, stack, source) {
    var text = String(message == null ? "" : message).trim();
    if (!text) return;
    if (/^(?:Uncaught\s+)?Script error\.?$/i.test(text)) return;
    if (/^(?:[A-Za-z]*Error:\s*)?Warning:/.test(text)) return;
    if (ours(source) || ours(stack)) return;
    var m = clip(text, MESSAGE_MAX);
    var st = clip(String(stack || "").split("\n").slice(0, STACK_LINES).join("\n"), STACK_MAX);
    var p = clip(page(), 200);
    for (var i = 0; i < errors.length; i++) {
      if (errors[i].message === m) {
        errors[i].count += 1;
        errors[i].at = Date.now();
        errors[i].page = p;
        schedule();
        return;
      }
    }
    errors.push({ kind: kind, message: m, stack: st, page: p, at: Date.now(), count: 1 });
    if (errors.length > MAX) errors.shift();
    schedule();
  }
  function describe(err) {
    if (err && typeof err === "object") {
      var name = err.name ? String(err.name) : "Error";
      var msg = err.message != null ? String(err.message) : "";
      if (!msg) {
        try {
          msg = JSON.stringify(err);
        } catch (e) {
          msg = "";
        }
      }
      return { message: msg ? name + ": " + msg : name, stack: err.stack ? String(err.stack) : "" };
    }
    return { message: String(err), stack: "" };
  }
  window.addEventListener(
    "error",
    function (ev) {
      try {
        var target = ev && ev.target;
        if (target && target !== window && target.tagName) {
          if (String(target.tagName).toUpperCase() === "SCRIPT" && target.src) {
            record("load", "Failed to load script " + target.src, "", target.src);
            if (sameOriginModule(target)) renderFailed();
          }
          return;
        }
        if (!ev.error && /^(?:Uncaught\s+)?Script error\.?$/i.test(String(ev.message || ""))) return;
        var d = ev.error ? describe(ev.error) : { message: ev.message, stack: "" };
        var where = ev.filename ? ev.filename + (ev.lineno ? ":" + ev.lineno + (ev.colno ? ":" + ev.colno : "") : "") : "";
        record("error", d.message, d.stack || (where ? "at " + where : ""), ev.filename || "");
      } catch (e) {}
    },
    true,
  );
  window.addEventListener("unhandledrejection", function (ev) {
    try {
      var d = describe(ev.reason);
      record("rejection", d.message, d.stack, "");
    } catch (e) {}
  });
  var original = console.error;
  console.error = function () {
    try {
      var first = arguments[0];
      if (!(typeof first === "string" && /^Warning:/.test(first))) {
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (a instanceof Error || (a && typeof a === "object" && typeof a.message === "string" && typeof a.stack === "string")) {
            var d = describe(a);
            record("console", d.message, d.stack, "");
            break;
          }
        }
      }
    } catch (e) {}
    return original.apply(this, arguments);
  };
  function overlayText(el) {
    try {
      var root = el.shadowRoot;
      if (!root) return null;
      var q = function (sel) {
        var n = root.querySelector(sel);
        return n ? String(n.textContent || "").trim() : "";
      };
      var body = q(".message-body") || q(".message");
      return { message: body.split("\n")[0], stack: [q(".file"), body, q(".frame"), q(".stack")].filter(Boolean).join("\n") };
    } catch (e) {
      return null;
    }
  }
  var scanQueued = false;
  var overlaySeen = null;
  function scan() {
    scanQueued = false;
    var overlay = document.querySelector("vite-error-overlay");
    var removed = false;
    for (var i = errors.length - 1; i >= 0; i--) {
      if (errors[i].kind === "compile" && !overlay) {
        errors.splice(i, 1);
        removed = true;
      }
    }
    if (overlay) {
      if (overlay === overlaySeen) return;
      var t = overlayText(overlay);
      if (t && t.message) {
        overlaySeen = overlay;
        record("compile", "Build error: " + t.message, t.stack, "");
      }
    } else if (removed) {
      overlaySeen = null;
      schedule();
    }
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver(function () {
      if (scanQueued) return;
      scanQueued = true;
      setTimeout(scan, 0);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener("message", function (ev) {
    try {
      if (ev.source && ev.source !== window.parent) return;
      var d = ev.data;
      if (!d || d.type !== "zavi:preview-errors-hello") return;
      if (!ALLOWED.test(String(ev.origin))) return;
      parentOrigin = ev.origin;
      flush();
    } catch (e) {}
  });
  try {
    window.parent.postMessage({ type: "zavi:preview-errors-ready" }, "*");
  } catch (e) {}
  // Did the page actually render? This script runs inline in <head>, so it is
  // there even when every app module fails to load. The Build view reloads a
  // frame that stays empty (a dev server restarting under it) instead of
  // showing a blank pane. Only a state word is sent, never page content.
  var renderState = "pending";
  var renderObserver = null;
  function tellRender() {
    try {
      window.parent.postMessage({ type: "zavi:preview-render", state: renderState }, "*");
    } catch (e) {}
  }
  function setRender(state) {
    if (renderState === state || renderState === "rendered") return;
    renderState = state;
    if (state === "rendered" && renderObserver) {
      try {
        renderObserver.disconnect();
      } catch (e) {}
      renderObserver = null;
    }
    tellRender();
  }
  function hasContent() {
    var root = document.getElementById("root");
    var scope = root || document.body;
    if (!scope) return false;
    for (var n = scope.firstElementChild; n; n = n.nextElementSibling) {
      var tag = String(n.tagName).toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "TEMPLATE" || tag === "NOSCRIPT") continue;
      if (tag === "VITE-ERROR-OVERLAY") continue;
      return true;
    }
    return false;
  }
  function sameOriginModule(el) {
    try {
      return String(el.type || "").toLowerCase() === "module" && new URL(el.src, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }
  function renderFailed() {
    if (!hasContent()) setRender("failed");
  }
  function settle() {
    if (renderState === "rendered") return;
    if (hasContent()) return setRender("rendered");
    if (renderState === "failed") return;
    for (var i = 0; i < errors.length; i++) {
      if (errors[i].kind !== "load") return setRender("errored");
    }
    setRender("empty");
  }
  if (typeof MutationObserver === "function") {
    renderObserver = new MutationObserver(function () {
      if (renderState !== "rendered" && hasContent()) setRender("rendered");
    });
    renderObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener("load", function () {
    setTimeout(settle, 4000);
  });
  window.addEventListener("message", function (ev) {
    try {
      if (ev.source && ev.source !== window.parent) return;
      var d = ev.data;
      if (d && d.type === "zavi:preview-render-hello") tellRender();
    } catch (e) {}
  });
  tellRender();
})();`;
