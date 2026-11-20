(function () {
  "use strict";

  if (window.parent === window) {
    runPublishedOverlay();
    return;
  }

  var ALLOWED_PARENTS = [
    "https://www.zaviagent.com",
    "https://zaviagent.com",
    "https://latest.zaviagent.com",
    "https://staging.zaviagent.com",
  ];
  var LOCAL_PARENT = /^http:\/\/(?:localhost|127\.0\.0\.1):30\d{2}$/;
  function isAllowedParent(origin) {
    return ALLOWED_PARENTS.indexOf(origin) !== -1 || LOCAL_PARENT.test(origin);
  }
  var parentOrigin = null;
  try {
    if (document.referrer) parentOrigin = new URL(document.referrer).origin;
  } catch (e) {
  }
  if (parentOrigin && !isAllowedParent(parentOrigin)) return;

  var T = {
    MODE: "zavi:editor-mode",
    APPLY: "zavi:editor-apply",
    DELETE: "zavi:editor-delete",
    UNDO: "zavi:editor-undo",
    REDO: "zavi:editor-redo",
    DESELECT: "zavi:editor-deselect",
    READY: "zavi:editor-ready",
    SELECTED: "zavi:editor-selected",
    DESELECTED: "zavi:editor-deselected",
    HISTORY: "zavi:editor-history",
    ROUTES: "zavi:editor-routes",
    LOCATION: "zavi:editor-location",
    OUTLINE_REQUEST: "zavi:editor-outline-request",
    OUTLINE: "zavi:editor-outline",
    APPLIED: "zavi:editor-applied",
    TEXT_EDITED: "zavi:editor-text-edited",
    TEXT_SUBMIT: "zavi:editor-text-submit",
    TEXT_REVERT: "zavi:editor-text-revert",
    COMMENT_PICK: "zavi:editor-comment-pick",
    RECTS_REQUEST: "zavi:editor-rects-request",
    RECTS: "zavi:editor-rects",
    THEME_DRAFT: "zavi:editor-theme-draft",
    KEY: "zavi:editor-key",
  };
  var PROTOCOL = 5;
  var STYLE_KEYS = [
    "color",
    "backgroundColor",
    "fontSize",
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "textDecoration",
    "textAlign",
  ];
  var SAFE_SELECTOR = /^[A-Za-z0-9_\-.#[\]=:()>+~*, \t]+$/;
  var SAFE_STYLE_VALUE = /^[A-Za-z0-9 #%().,'"/-]+$/;
  var FORBIDDEN_STYLE = /url\s*\(|javascript:|expression\s*\(|@import|<|>/i;

  var ATTR_KEYS = ["href", "src"];
  var MAX_URL = 2048;
  var HREF_SCHEMES = { "http:": 1, "https:": 1, "mailto:": 1, "tel:": 1 };
  var SRC_SCHEMES = { "https:": 1 };
  function runtimeSanitizeUrl(key, raw) {
    if (typeof raw !== "string") return null;
    var t = raw.trim();
    if (t.length === 0 || t.length > MAX_URL) return null;
    if (/[\u0000-\u001f\u007f]/.test(t)) return null;
    if (/\s/.test(t)) return null;
    if (/\\/.test(t)) return null;
    if (/%00/i.test(t)) return null;
    if (t.indexOf("//") === 0) return null;
    var scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme) {
      var proto;
      try {
        proto = new URL(t).protocol.toLowerCase();
      } catch (e) {
        return null;
      }
      var allowed = key === "href" ? HREF_SCHEMES : SRC_SCHEMES;
      return allowed[proto] ? t : null;
    }
    if (t.charAt(0) === "#") return key === "href" ? t : null;
    try {
      if (new URL(t, "https://base.invalid/").protocol.toLowerCase() !== "https:") return null;
    } catch (e) {
      return null;
    }
    return t;
  }
  function attrElementOk(el, key) {
    return (key === "href" && el.tagName === "A") || (key === "src" && el.tagName === "IMG");
  }
  function applyAttrs(el, attrs, trusted) {
    for (var k in attrs) {
      if (ATTR_KEYS.indexOf(k) === -1) continue;
      if (!attrElementOk(el, k)) continue;
      var v = attrs[k];
      if (trusted) {
        if (v == null) el.removeAttribute(k);
        else el.setAttribute(k, v);
      } else {
        var safe = runtimeSanitizeUrl(k, v);
        if (safe != null) el.setAttribute(k, safe);
      }
    }
  }

  var editing = false;
  var textTool = false;
  var commentTool = false;
  var watchedSelectors = [];
  var rectsPending = false;
  var MAX_WATCHED = 100;
  var inlineEl = null;
  var inlineSelector = null;
  var inlineOriginal = "";
  var inlineOutline = null;
  var inlineField = null;
  var inlineFieldStart = "";
  var inlineDraft = "";
  var draftTimer = 0;
  var DRAFT_IDLE_MS = 450;
  var hovered = null;
  var selectedSelector = null;
  var undoStack = [];
  var redoStack = [];

  function post(msg) {
    var target = parentOrigin || "*";
    window.parent.postMessage(msg, target);
  }

  function allowedOrigin(origin) {
    if (parentOrigin) return origin === parentOrigin;
    return isAllowedParent(origin);
  }

  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return "#" + el.id;
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 6) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      var sameTag = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) sameTag.push(parent.children[i]);
      }
      if (sameTag.length > 1) {
        parts.unshift(tag + ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")");
      } else {
        parts.unshift(tag);
      }
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift("#" + node.id);
        break;
      }
      node = parent;
      depth++;
    }
    var sel = parts.join(" > ");
    return SAFE_SELECTOR.test(sel) ? sel : null;
  }

  function currentStyle(el) {
    var cs = window.getComputedStyle(el);
    var out = {};
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var k = STYLE_KEYS[i];
      var cssProp = k.replace(/[A-Z]/g, function (m) {
        return "-" + m.toLowerCase();
      });
      out[k] = cs.getPropertyValue(cssProp);
    }
    return out;
  }

  function buildOutline() {
    var TAGS =
      "h1,h2,h3,h4,h5,h6,p,span,a,button,img,li,small,strong,em,b,i,label,figcaption,blockquote";
    var nodes = document.querySelectorAll(TAGS);
    var out = [];
    var seen = {};
    for (var i = 0; i < nodes.length && out.length < 150; i++) {
      var el = nodes[i];
      var tag = el.tagName.toLowerCase();
      var sel = selectorFor(el);
      if (!sel || seen[sel]) continue;
      var text = "";
      if (tag === "img") {
        text = el.getAttribute("alt") || "";
      } else if (el.childElementCount === 0) {
        text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!text) continue;
      } else if (tag === "a") {
        text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
      } else {
        continue;
      }
      seen[sel] = 1;
      out.push({ selector: sel, tag: tag, text: text });
    }
    return out;
  }

  function placeBox(box, el) {
    var r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  var overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4f46e5;background:rgba(79,70,229,0.08);border-radius:4px;transition:all .05s;display:none";
  function showOverlay(el) {
    placeBox(overlay, el);
  }
  function hideOverlay() {
    overlay.style.display = "none";
  }

  var selectedEl = null;
  var selectedOverlay = document.createElement("div");
  selectedOverlay.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #3b5bdb;background:rgba(59,91,219,0.06);border-radius:2px;transition:all .05s;display:none";
  function showSelectedOverlay(el) {
    selectedEl = el;
    placeBox(selectedOverlay, el);
  }
  function hideSelectedOverlay() {
    selectedEl = null;
    selectedOverlay.style.display = "none";
  }

  var NO_INLINE_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };
  function inlineTextLeaf(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (el === overlay || el === selectedOverlay) return false;
    if (NO_INLINE_TAGS[el.tagName.toUpperCase()] || el.childElementCount !== 0) return false;
    if (el.closest && el.closest(NO_TEXT_RUNS)) return false;
    return !!(el.textContent && el.textContent.trim());
  }

  function caretAt(el, x, y) {
    var range = null;
    try {
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
      else if (document.caretPositionFromPoint) {
        var pos = document.caretPositionFromPoint(x, y);
        if (pos) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
        }
      }
    } catch (e) {
      range = null;
    }
    var selection = window.getSelection && window.getSelection();
    if (!selection) return;
    if (!range || !el.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function onInlineKeyDown(e) {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (finishInline(true)) post({ type: T.TEXT_SUBMIT, protocol: PROTOCOL });
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishInline(false);
    }
  }
  function onInlineKeyUp(e) {
    e.stopPropagation();
    if (e.key === " ") e.preventDefault();
    if (inlineEl) showSelectedOverlay(inlineEl);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(postDraft, DRAFT_IDLE_MS);
  }
  function inlineText() {
    return (inlineField ? inlineField.value : inlineEl.textContent || "").replace(/[\r\n]+/g, " ").slice(0, 5000);
  }
  function postDraft() {
    if (!inlineEl) return;
    var next = inlineText();
    if (!next.trim() || next === inlineOriginal || next === inlineDraft) return;
    if (inlineField && next === inlineFieldStart) return;
    inlineDraft = next;
    post({ type: T.TEXT_EDITED, selector: inlineSelector, text: next, before: inlineOriginal, protocol: PROTOCOL });
  }
  function revertText(edits) {
    if (!Array.isArray(edits)) return;
    var bySelector = {};
    for (var i = 0; i < edits.length; i++) {
      var edit = edits[i];
      if (!edit || typeof edit.selector !== "string" || typeof edit.text !== "string") continue;
      if (!SAFE_SELECTOR.test(edit.selector)) continue;
      bySelector[edit.selector] = edit.text.slice(0, 5000);
    }
    if (inlineEl && Object.prototype.hasOwnProperty.call(bySelector, inlineSelector)) {
      inlineDraft = "";
      finishInline(false);
    }
    var dropped = false;
    for (var sel in bySelector) {
      var el = null;
      try {
        el = document.querySelector(sel);
      } catch (e) {}
      if (el) el.textContent = bySelector[sel];
    }
    var keep = function (op) {
      var hit = Object.prototype.hasOwnProperty.call(bySelector, op.selector);
      if (hit) dropped = true;
      return !hit;
    };
    undoStack = undoStack.filter(keep);
    redoStack = redoStack.filter(keep);
    if (dropped) emitHistory();
    hideOverlay();
    reemitSelected();
  }
  function onInlineBlur() {
    finishInline(true);
  }
  function onInlinePaste(e) {
    if (!inlineEl || inlineEl.contentEditable === "plaintext-only") return;
    e.preventDefault();
    var text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    try {
      document.execCommand("insertText", false, text);
    } catch (err) {
      return;
    }
  }

  var FIELD_TAGS = { BUTTON: 1, SUMMARY: 1 };
  var FIELD_STYLE_KEYS = [
    "font", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "textTransform", "textAlign",
    "color", "lineHeight", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "borderRadius", "backgroundColor",
  ];
  function startField(el) {
    var rect = el.getBoundingClientRect();
    var field = document.createElement("input");
    field.type = "text";
    field.setAttribute("data-zavi-inline-field", "");
    field.setAttribute("spellcheck", "false");
    field.setAttribute("autocomplete", "off");
    field.value = inlineOriginal.replace(/\s+/g, " ").trim();
    inlineFieldStart = field.value;
    var cs = window.getComputedStyle(el);
    for (var i = 0; i < FIELD_STYLE_KEYS.length; i++) {
      try {
        field.style[FIELD_STYLE_KEYS[i]] = cs[FIELD_STYLE_KEYS[i]];
      } catch (e) {}
    }
    field.style.cssText +=
      ";position:fixed;box-sizing:border-box;margin:0;border:0;outline:none;z-index:2147483646;" +
      "left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;";
    field.addEventListener("keydown", onInlineKeyDown, true);
    field.addEventListener("keyup", onInlineKeyUp, true);
    field.addEventListener("blur", onInlineBlur);
    inlineField = field;
    document.body.appendChild(field);
    field.focus();
    try {
      field.setSelectionRange(field.value.length, field.value.length);
    } catch (e) {}
  }

  function startInline(el, x, y) {
    var sel = selectorFor(el);
    if (!sel) return;
    inlineEl = el;
    inlineSelector = sel;
    inlineOriginal = el.textContent || "";
    inlineOutline = { outline: el.style.outline, boxShadow: el.style.boxShadow };
    el.style.outline = "none";
    el.style.boxShadow = "none";
    if (FIELD_TAGS[el.tagName.toUpperCase()]) {
      startField(el);
      hideOverlay();
      showSelectedOverlay(el);
      return;
    }
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "false");
    el.addEventListener("keydown", onInlineKeyDown, true);
    el.addEventListener("keyup", onInlineKeyUp, true);
    el.addEventListener("blur", onInlineBlur);
    el.addEventListener("paste", onInlinePaste, true);
    el.focus();
    caretAt(el, x, y);
    hideOverlay();
    showSelectedOverlay(el);
  }

  function finishInline(keep) {
    var el = inlineEl;
    if (!el) return false;
    var sel = inlineSelector;
    var original = inlineOriginal;
    var field = inlineField;
    var next = inlineText();
    var drafted = inlineDraft;
    clearTimeout(draftTimer);
    inlineDraft = "";
    inlineEl = null;
    inlineSelector = null;
    inlineField = null;
    if (field) {
      field.removeEventListener("keydown", onInlineKeyDown, true);
      field.removeEventListener("keyup", onInlineKeyUp, true);
      field.removeEventListener("blur", onInlineBlur);
      if (field.parentNode) field.parentNode.removeChild(field);
    } else {
      el.removeEventListener("keydown", onInlineKeyDown, true);
      el.removeEventListener("keyup", onInlineKeyUp, true);
      el.removeEventListener("blur", onInlineBlur);
      el.removeEventListener("paste", onInlinePaste, true);
      el.removeAttribute("contenteditable");
      el.removeAttribute("spellcheck");
    }
    if (inlineOutline) {
      el.style.outline = inlineOutline.outline;
      el.style.boxShadow = inlineOutline.boxShadow;
      inlineOutline = null;
    }
    hideSelectedOverlay();
    if (!keep || !next.trim() || next === original || (field && next === inlineFieldStart)) {
      el.textContent = original;
      if (drafted) post({ type: T.TEXT_EDITED, selector: sel, text: original, before: drafted, protocol: PROTOCOL });
      return false;
    }
    el.textContent = next;
    undoStack.push({ selector: sel, prev: { text: original, style: {} }, patch: { text: next } });
    redoStack.length = 0;
    emitHistory();
    if (next !== drafted) post({ type: T.TEXT_EDITED, selector: sel, text: next, before: original, protocol: PROTOCOL });
    return true;
  }

  function onOver(e) {
    if (!editing) return;
    if (textTool) {
      hovered = inlineTextLeaf(e.target) && e.target !== inlineEl ? e.target : null;
      if (hovered) showOverlay(hovered);
      else hideOverlay();
      return;
    }
    hovered = e.target;
    if (hovered === selectedEl) {
      hideOverlay();
      return;
    }
    showOverlay(hovered);
  }
  function readAttrs(el) {
    var a = {};
    for (var i = 0; i < ATTR_KEYS.length; i++) {
      var k = ATTR_KEYS[i];
      if (attrElementOk(el, k)) {
        var v = runtimeSanitizeUrl(k, el.getAttribute(k));
        if (v != null) a[k] = v;
      }
    }
    return a;
  }
  var NO_TEXT_RUNS = "script,style,noscript,template,svg,textarea,select";
  var MAX_SEGMENTS = 40;
  var MAX_RUN_CHARS = 4000;
  function textRuns(el, charCap) {
    var runs = [];
    var chars = 0;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      var skip = n.parentElement && n.parentElement.closest(NO_TEXT_RUNS);
      if (skip && (skip === el || el.contains(skip))) continue;
      runs.push(n);
      chars += n.nodeValue.length;
      if (runs.length > MAX_SEGMENTS || (charCap && chars > charCap)) return null;
    }
    return runs.length ? runs : null;
  }
  function applySegments(el, segments, trusted) {
    if (!Array.isArray(segments) || el.childElementCount === 0) return false;
    if (segments.length > MAX_SEGMENTS) return false;
    var runs = textRuns(el, 0);
    if (!runs || runs.length !== segments.length) return false;
    var words = 0;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i] === null) continue;
      if (typeof segments[i] !== "string" || !segments[i].trim()) return false;
      words++;
    }
    if (!words) return false;
    for (var j = 0; j < runs.length; j++) {
      if (segments[j] === null) continue;
      runs[j].nodeValue = trusted ? segments[j] : segments[j].slice(0, 5000);
    }
    return true;
  }
  var SECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  function sectionOf(el) {
    var s = el.closest ? el.closest("[data-zavi-section]") : null;
    var id = s ? s.getAttribute("data-zavi-section") : null;
    return id && SECTION_ID_RE.test(id) ? id : undefined;
  }
  function emitSelected(el, sel) {
    var leaf = el.childElementCount === 0;
    var runs = leaf ? null : textRuns(el, MAX_RUN_CHARS);
    var segments = null;
    if (runs) {
      segments = [];
      for (var i = 0; i < runs.length; i++) segments.push(runs[i].nodeValue);
    }
    post({
      type: T.SELECTED,
      selector: sel,
      tag: el.tagName,
      text: leaf ? el.textContent || "" : "",
      textEditable: leaf,
      segments: segments || undefined,
      style: currentStyle(el),
      attrs: readAttrs(el),
      section: sectionOf(el),
      protocol: PROTOCOL,
    });
  }

  function reemitSelected() {
    if (!selectedSelector) return;
    var el;
    try {
      el = document.querySelector(selectedSelector);
    } catch (e) {
      return;
    }
    if (el) {
      emitSelected(el, selectedSelector);
      if (selectedEl) showSelectedOverlay(el);
    }
  }

  function clamp01(n) {
    return typeof n === "number" && isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
  }
  function emitCommentPick(el, e) {
    var sel = selectorFor(el);
    if (!sel) return;
    var r = el.getBoundingClientRect();
    post({
      type: T.COMMENT_PICK,
      selector: sel,
      tag: el.tagName,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
      section: sectionOf(el),
      rel_x: clamp01(r.width > 0 ? (e.clientX - r.left) / r.width : 0.5),
      rel_y: clamp01(r.height > 0 ? (e.clientY - r.top) / r.height : 0.5),
      protocol: PROTOCOL,
    });
    hideOverlay();
  }
  function rectsFor(selectors) {
    var out = [];
    for (var i = 0; i < selectors.length; i++) {
      var s = selectors[i];
      var el = null;
      try {
        el = document.querySelector(s);
      } catch (err) {
        el = null;
      }
      if (!el) {
        out.push({ selector: s, found: false });
        continue;
      }
      var r = el.getBoundingClientRect();
      out.push({ selector: s, found: true, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }
  function emitRects() {
    rectsPending = false;
    if (!watchedSelectors.length) return;
    post({ type: T.RECTS, rects: rectsFor(watchedSelectors), vw: window.innerWidth, vh: window.innerHeight, protocol: PROTOCOL });
  }
  function scheduleRects() {
    if (rectsPending || !watchedSelectors.length) return;
    rectsPending = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(emitRects);
    else setTimeout(emitRects, 16);
  }
  function watchSelectors(list) {
    var next = [];
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length && next.length < MAX_WATCHED; i++) {
        var s = list[i];
        if (typeof s !== "string") continue;
        s = s.trim();
        if (!s || s.length > 400 || !SAFE_SELECTOR.test(s) || next.indexOf(s) !== -1) continue;
        next.push(s);
      }
    }
    watchedSelectors = next;
  }

  function onClick(e) {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (commentTool) {
      emitCommentPick(el, e);
      return;
    }
    if (textTool) {
      if (el === inlineEl || el === inlineField) return;
      if (inlineEl) finishInline(true);
      if (inlineTextLeaf(el)) startInline(el, e.clientX, e.clientY);
      return;
    }
    var sel = selectorFor(el);
    if (!sel) return;
    selectedSelector = sel;
    emitSelected(el, sel);
    showSelectedOverlay(el);
    hideOverlay();
  }

  function setEditing(on, tool) {
    if (inlineEl) finishInline(true);
    textTool = !!on && tool === "text";
    commentTool = !!on && tool === "comment";
    overlay.style.borderStyle = textTool ? "dashed" : "solid";
    overlay.style.borderColor = textTool ? "#3d6fe5" : "#4f46e5";
    overlay.style.background = textTool ? "transparent" : "rgba(79,70,229,0.08)";
    selectedOverlay.style.borderStyle = textTool ? "dashed" : "solid";
    selectedOverlay.style.borderColor = textTool ? "#3d6fe5" : "#3b5bdb";
    selectedOverlay.style.background = textTool ? "transparent" : "rgba(59,91,219,0.06)";
    if (commentTool) {
      overlay.style.borderStyle = "solid";
      overlay.style.borderColor = "#d97706";
      overlay.style.background = "rgba(217,119,6,0.08)";
    }
    if (editing && !!on) {
      hideOverlay();
      hideSelectedOverlay();
      selectedSelector = null;
      return;
    }
    editing = !!on;
    if (editing) {
      document.documentElement.appendChild(overlay);
      document.documentElement.appendChild(selectedOverlay);
      document.addEventListener("mouseover", onOver, true);
      document.addEventListener("click", onClick, true);
    } else {
      hideOverlay();
      hideSelectedOverlay();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (selectedOverlay.parentNode) selectedOverlay.parentNode.removeChild(selectedOverlay);
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("click", onClick, true);
      selectedSelector = null;
      post({ type: T.DESELECTED });
    }
  }

  function safeStyleValue(v) {
    return typeof v === "string" && SAFE_STYLE_VALUE.test(v) && !FORBIDDEN_STYLE.test(v);
  }

  function snapshot(el, patch) {
    var prev = { text: null, style: {} };
    if (patch.text != null) prev.text = el.textContent;
    if (patch.segments) {
      var runs = textRuns(el, 0);
      if (runs) {
        prev.segments = [];
        for (var i = 0; i < runs.length; i++) prev.segments.push(runs[i].nodeValue);
      }
    }
    if (patch.style) {
      for (var k in patch.style) {
        if (STYLE_KEYS.indexOf(k) !== -1) prev.style[k] = el.style[k] || "";
      }
    }
    if (patch.attrs) {
      prev.attrs = {};
      for (var ak in patch.attrs) {
        if (ATTR_KEYS.indexOf(ak) !== -1) prev.attrs[ak] = el.getAttribute(ak);
      }
    }
    return prev;
  }

  function applyRaw(el, patch, trusted) {
    var ok = true;
    if (patch.text != null) {
      if (el.childElementCount === 0) {
        el.textContent = trusted ? String(patch.text) : String(patch.text).slice(0, 5000);
      } else {
        ok = false;
      }
    }
    if (patch.segments && !applySegments(el, patch.segments, trusted)) ok = false;
    if (patch.style) {
      for (var k in patch.style) {
        if (STYLE_KEYS.indexOf(k) === -1) continue;
        if (safeStyleValue(patch.style[k]) || (trusted && patch.style[k] === "")) {
          el.style[k] = patch.style[k];
        }
      }
    }
    if (patch.attrs) {
      for (var ak in patch.attrs) {
        if (ATTR_KEYS.indexOf(ak) === -1) continue;
        if (!attrElementOk(el, ak)) ok = false;
        else if (!trusted && runtimeSanitizeUrl(ak, patch.attrs[ak]) == null) ok = false;
      }
      applyAttrs(el, patch.attrs, trusted);
    }
    return ok;
  }

  function apply(selector, patch, record, strict) {
    if (!SAFE_SELECTOR.test(selector)) return { el: null, ok: false };
    var el;
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { el: null, ok: false };
    }
    if (!el) return { el: null, ok: false };
    var prev = snapshot(el, patch);
    var ok = applyRaw(el, patch);
    if (strict && !ok) {
      applyRaw(el, prev, true);
      reemitSelected();
      return { el: el, ok: false };
    }
    if (record) {
      undoStack.push({ selector: selector, prev: prev, patch: patch });
      redoStack.length = 0;
      emitHistory();
    }
    if (editing && hovered === el) showOverlay(el);
    reemitSelected();
    return { el: el, ok: ok };
  }

  var revealBox = null;
  var revealTimer = null;
  function flashReveal(el) {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
      try {
        el.scrollIntoView();
      } catch (e2) {
      }
    }
    if (!revealBox) {
      revealBox = document.createElement("div");
      revealBox.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #0e9f6e;" +
        "background:rgba(14,159,110,0.16);border-radius:6px;box-shadow:0 0 0 4px rgba(14,159,110,0.22);" +
        "transition:opacity .35s ease;display:none;opacity:0";
      (document.body || document.documentElement).appendChild(revealBox);
    }
    setTimeout(function () {
      placeBox(revealBox, el);
      revealBox.style.display = "block";
      revealBox.getBoundingClientRect();
      revealBox.style.opacity = "1";
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = setTimeout(function () {
        revealBox.style.opacity = "0";
        setTimeout(function () {
          if (revealBox) revealBox.style.display = "none";
        }, 350);
      }, 1500);
    }, 280);
  }

  function remove(selector, record) {
    if (!SAFE_SELECTOR.test(selector)) return;
    var el;
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return;
    }
    if (!el) return;
    if (record) {
      undoStack.push({ selector: selector, prevDisplay: el.style.display, removed: true });
      redoStack.length = 0;
      emitHistory();
    }
    el.style.display = "none";
    if (selector === selectedSelector) {
      selectedSelector = null;
      hideSelectedOverlay();
    }
  }

  function undo() {
    var op = undoStack.pop();
    if (!op) return;
    var el;
    try {
      el = document.querySelector(op.selector);
    } catch (e) {
      return;
    }
    if (el) {
      if (op.removed) el.style.display = op.prevDisplay || "";
      else applyRaw(el, op.prev, true);
    }
    redoStack.push(op);
    emitHistory();
    reemitSelected();
  }
  function redo() {
    var op = redoStack.pop();
    if (!op) return;
    var el;
    try {
      el = document.querySelector(op.selector);
    } catch (e) {
      return;
    }
    if (el) {
      if (op.removed) el.style.display = "none";
      else applyRaw(el, op.patch);
    }
    undoStack.push(op);
    emitHistory();
    reemitSelected();
  }
  function emitHistory() {
    post({ type: T.HISTORY, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  }

  var THEME_HEX = /^#[0-9a-fA-F]{6}$/;
  var THEME_FONT = /^[A-Za-z0-9 ]{1,48}$/;
  var THEME_RADIUS = /^(0|\d{1,2}(\.\d{1,3})?(rem|px|em))$/;
  var THEME_DRAFT_ID = "zavi-theme-draft";
  var THEME_FONTS_ID = "zavi-theme-draft-fonts";
  function themeRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function themeTriple(hex) {
    return themeRgb(hex).join(" ");
  }
  function themeOnColor(hex) {
    var lum = themeRgb(hex).map(function (c) {
      var v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    var l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
    return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.05) ? "255 255 255" : "11 13 18";
  }
  function themeFontStack(family) {
    return '"' + family + '", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  }
  function removeThemeDraft() {
    var style = document.getElementById(THEME_DRAFT_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
    var link = document.getElementById(THEME_FONTS_ID);
    if (link && link.parentNode) link.parentNode.removeChild(link);
  }
  function applyThemeDraft(theme) {
    if (!theme || typeof theme !== "object") {
      removeThemeDraft();
      return;
    }
    var decls = [];
    var families = [];
    var colors = theme.colors && typeof theme.colors === "object" ? theme.colors : {};
    function color(key) {
      var v = colors[key];
      return typeof v === "string" && THEME_HEX.test(v) ? v : null;
    }
    var primary = color("primary");
    if (primary) {
      decls.push("--primary: " + themeTriple(primary), "--ring: " + themeTriple(primary), "--primary-foreground: " + themeOnColor(primary));
    }
    var background = color("background");
    if (background) decls.push("--background: " + themeTriple(background), "--card: " + themeTriple(background));
    var foreground = color("foreground");
    if (foreground) decls.push("--foreground: " + themeTriple(foreground), "--card-foreground: " + themeTriple(foreground));
    var accent = color("accent");
    if (accent) decls.push("--accent: " + themeTriple(accent), "--accent-foreground: " + themeOnColor(accent));
    var fonts = theme.fonts && typeof theme.fonts === "object" ? theme.fonts : {};
    if (typeof fonts.display === "string" && THEME_FONT.test(fonts.display)) {
      decls.push("--font-display: " + themeFontStack(fonts.display));
      families.push(fonts.display);
    }
    if (typeof fonts.body === "string" && THEME_FONT.test(fonts.body)) {
      decls.push("--font-body: " + themeFontStack(fonts.body));
      if (families.indexOf(fonts.body) === -1) families.push(fonts.body);
    }
    if (typeof theme.radius === "string" && THEME_RADIUS.test(theme.radius)) decls.push("--radius: " + theme.radius);
    if (!decls.length) {
      removeThemeDraft();
      return;
    }
    var head = document.head || document.documentElement;
    var link = document.getElementById(THEME_FONTS_ID);
    if (families.length) {
      var href =
        "https://fonts.googleapis.com/css2?" +
        families
          .map(function (f) {
            return "family=" + f.replace(/ /g, "+");
          })
          .join("&") +
        "&display=swap";
      if (!link) {
        link = document.createElement("link");
        link.id = THEME_FONTS_ID;
        link.rel = "stylesheet";
      }
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
      head.appendChild(link);
    } else if (link && link.parentNode) {
      link.parentNode.removeChild(link);
    }
    var style = document.getElementById(THEME_DRAFT_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = THEME_DRAFT_ID;
    }
    style.textContent = ":root { " + decls.join(" !important; ") + " !important; }";
    head.appendChild(style);
  }

  window.addEventListener("message", function (event) {
    if (!allowedOrigin(event.origin)) return;
    var d = event.data;
    if (!d || typeof d !== "object") return;
    switch (d.type) {
      case T.MODE:
        setEditing(!!d.enabled, d.tool);
        break;
      case T.APPLY:
        if (typeof d.selector === "string" && d.patch) {
          var confirm = !!(d.reveal || d.ack);
          var result = apply(d.selector, d.patch, true, confirm);
          if (d.reveal && result.ok) flashReveal(result.el);
          if (confirm) {
            post({ type: T.APPLIED, selector: d.selector, ok: result.ok, protocol: PROTOCOL });
          }
        }
        break;
      case T.DELETE:
        if (typeof d.selector === "string") remove(d.selector, true);
        break;
      case T.TEXT_REVERT:
        revertText(d.edits);
        break;
      case T.THEME_DRAFT:
        applyThemeDraft(d.theme);
        break;
      case T.UNDO:
        undo();
        break;
      case T.REDO:
        redo();
        break;
      case T.DESELECT:
        selectedSelector = null;
        hideSelectedOverlay();
        break;
      case T.RECTS_REQUEST:
        watchSelectors(d.selectors);
        emitRects();
        break;
      case T.OUTLINE_REQUEST:
        post({ type: T.OUTLINE, elements: buildOutline() });
        break;
    }
  });

  window.addEventListener(
    "scroll",
    function () {
      if (!editing) return;
      if (hovered && hovered !== selectedEl) showOverlay(hovered);
      if (selectedEl) placeBox(selectedOverlay, selectedEl);
    },
    true,
  );
  window.addEventListener("resize", function () {
    if (editing && selectedEl) placeBox(selectedOverlay, selectedEl);
  });
  window.addEventListener("scroll", scheduleRects, true);
  window.addEventListener("resize", scheduleRects);

  var SHORTCUT_KEYS = { e: 1, t: 1, a: 1, c: 1 };
  window.addEventListener("keydown", function (e) {
    if (e.repeat || e.defaultPrevented || inlineEl) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
    if (t && t.closest && t.closest('[contenteditable]:not([contenteditable="false"])')) return;
    var mod = e.metaKey || e.ctrlKey;
    if (e.altKey || e.shiftKey) return;
    var key;
    if (e.key === "Escape") {
      if (mod) return;
      key = "Escape";
    } else {
      key = typeof e.key === "string" ? e.key.toLowerCase() : "";
      if (mod ? key !== "." : SHORTCUT_KEYS[key] !== 1) return;
    }
    var meta = !!e.metaKey;
    var ctrl = !!e.ctrlKey;
    setTimeout(function () {
      if (e.defaultPrevented) return;
      post({ type: T.KEY, key: key, metaKey: meta, ctrlKey: ctrl });
    }, 0);
  });

  function normalizeDynamic(p) {
    return p
      .replace(/\[\[?\.\.\.[^\]]+\]?\]/g, "*")
      .replace(/\[([^\]]+)\]/g, ":$1");
  }

  function collectRoutes() {
    var seen = {};
    var order = [];
    function add(raw) {
      if (typeof raw !== "string" || raw.charAt(0) !== "/") return;
      var path = raw.split("#")[0];
      var query = "";
      var qi = path.indexOf("?");
      if (qi !== -1) {
        query = path.slice(qi);
        path = path.slice(0, qi);
      }
      if (/^\/_next\b/.test(path) || /^\/api\b/.test(path)) return;
      if (/\.[a-z0-9]{1,8}$/i.test(path)) return;
      if (path.length > 1 && path.charAt(path.length - 1) === "/") {
        path = path.slice(0, -1);
      }
      var full = (path || "/") + query;
      if (full.length > 200) return;
      if (!seen[full]) {
        seen[full] = 1;
        order.push(full);
      }
    }
    try {
      var bm = window.__BUILD_MANIFEST;
      if (bm && bm.sortedPages && bm.sortedPages.length) {
        for (var i = 0; i < bm.sortedPages.length; i++) {
          var pg = bm.sortedPages[i];
          if (pg === "/_app" || pg === "/_error" || pg === "/_document") continue;
          add(normalizeDynamic(pg));
        }
      }
    } catch (e) {
    }
    try {
      var links = document.querySelectorAll("a[href]");
      for (var j = 0; j < links.length; j++) {
        var href = links[j].getAttribute("href");
        if (!href) continue;
        if (href.charAt(0) === "/") {
          add(href);
        } else if (/^https?:/i.test(href)) {
          try {
            var u = new URL(href);
            if (u.origin === location.origin) add(u.pathname + (u.search || ""));
          } catch (e2) {
          }
        }
      }
    } catch (e3) {
    }
    if (!seen["/"]) order.unshift("/");
    add(location.pathname || "/");
    return order;
  }

  var lastRoutes = "";
  function emitRoutes() {
    var routes = collectRoutes();
    if (!routes.length) return;
    var key = routes.join("|");
    if (key === lastRoutes) return;
    lastRoutes = key;
    post({ type: T.ROUTES, routes: routes });
  }

  var routeTimer = null;
  function scheduleRoutes() {
    if (routeTimer) return;
    routeTimer = setTimeout(function () {
      routeTimer = null;
      emitRoutes();
    }, 500);
  }

  var lastPath = null;
  function emitLocation() {
    var p = location.pathname || "/";
    if (p === lastPath) return;
    lastPath = p;
    post({ type: T.LOCATION, path: p });
  }
  var locTimer = null;
  function scheduleLocation() {
    if (locTimer) return;
    locTimer = setTimeout(function () {
      locTimer = null;
      emitLocation();
    }, 60);
  }
  var historyHooked = false;
  function hookHistory() {
    if (historyHooked) return;
    historyHooked = true;
    try {
      var _push = history.pushState;
      var _replace = history.replaceState;
      history.pushState = function () {
        var r = _push.apply(this, arguments);
        scheduleLocation();
        scheduleRoutes();
        return r;
      };
      history.replaceState = function () {
        var r = _replace.apply(this, arguments);
        scheduleLocation();
        return r;
      };
    } catch (e) {
    }
    window.addEventListener("popstate", scheduleLocation);
    window.addEventListener("hashchange", scheduleLocation);
  }

  function announce() {
    post({ type: T.READY, protocol: PROTOCOL, comments: 1 });
    emitRoutes();
    emitLocation();
    hookHistory();
    try {
      var mo = new MutationObserver(scheduleRoutes);
      mo.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {
    }
    window.addEventListener("popstate", scheduleRoutes);
    setTimeout(emitRoutes, 1200);
    setTimeout(emitRoutes, 3500);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announce);
  } else {
    announce();
  }

  function runPublishedOverlay() {
    var API = "https://api.zaviagent.com/api/website/edits/published?app=";
    var STYLE_KEYS = [
      "color",
      "backgroundColor",
      "fontSize",
      "fontFamily",
      "fontWeight",
      "fontStyle",
      "textDecoration",
      "textAlign",
    ];
    var SAFE_SELECTOR = /^[A-Za-z0-9_\-.#[\]=:()>+~*, \t]+$/;
    var SAFE_STYLE_VALUE = /^[A-Za-z0-9 #%().,'"/-]+$/;
    var FORBIDDEN_STYLE = /url\s*\(|javascript:|expression\s*\(|@import|<|>/i;

    var ATTR_KEYS = ["href", "src"];
    var MAX_URL = 2048;
    var HREF_SCHEMES = { "http:": 1, "https:": 1, "mailto:": 1, "tel:": 1 };
    var SRC_SCHEMES = { "https:": 1 };
    function sanitizeUrl(key, raw) {
      if (typeof raw !== "string") return null;
      var t = raw.trim();
      if (t.length === 0 || t.length > MAX_URL) return null;
      if (/[\u0000-\u001f\u007f]/.test(t)) return null;
      if (/\s/.test(t) || /\\/.test(t) || /%00/i.test(t)) return null;
      if (t.indexOf("//") === 0) return null;
      var scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
      if (scheme) {
        var proto;
        try {
          proto = new URL(t).protocol.toLowerCase();
        } catch (e) {
          return null;
        }
        return (key === "href" ? HREF_SCHEMES : SRC_SCHEMES)[proto] ? t : null;
      }
      if (t.charAt(0) === "#") return key === "href" ? t : null;
      try {
        if (new URL(t, "https://base.invalid/").protocol.toLowerCase() !== "https:") return null;
      } catch (e) {
        return null;
      }
      return t;
    }
    function attrElementOk(el, key) {
      return (key === "href" && el.tagName === "A") || (key === "src" && el.tagName === "IMG");
    }

    var NO_TEXT_RUNS = "script,style,noscript,template,svg,textarea,select";
    function applyPublishedSegments(el, segments) {
      if (!Array.isArray(segments) || el.childElementCount === 0 || segments.length > 40) return;
      var runs = [];
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        var skip = n.parentElement && n.parentElement.closest(NO_TEXT_RUNS);
        if (skip && (skip === el || el.contains(skip))) continue;
        runs.push(n);
        if (runs.length > 40) return;
      }
      if (runs.length !== segments.length) return;
      var words = 0;
      for (var j = 0; j < segments.length; j++) {
        if (segments[j] === null) continue;
        if (typeof segments[j] !== "string" || !segments[j].trim()) return;
        words++;
      }
      if (!words) return;
      for (var k = 0; k < runs.length; k++) {
        if (segments[k] !== null) runs[k].nodeValue = segments[k].slice(0, 5000);
      }
    }

    function applyOne(edit) {
      if (!edit || typeof edit.selector !== "string" || !SAFE_SELECTOR.test(edit.selector)) {
        return;
      }
      var el;
      try {
        el = document.querySelector(edit.selector);
      } catch (e) {
        return;
      }
      if (!el) return;
      if (edit.removed) {
        el.style.display = "none";
        return;
      }
      var patch = edit.patch || {};
      if (patch.text != null && el.childElementCount === 0) {
        el.textContent = String(patch.text).slice(0, 5000);
      }
      if (patch.segments) applyPublishedSegments(el, patch.segments);
      if (patch.style) {
        for (var k in patch.style) {
          if (STYLE_KEYS.indexOf(k) === -1) continue;
          var v = patch.style[k];
          if (typeof v === "string" && SAFE_STYLE_VALUE.test(v) && !FORBIDDEN_STYLE.test(v)) {
            el.style[k] = v;
          }
        }
      }
      if (patch.attrs) {
        for (var ak in patch.attrs) {
          if (ATTR_KEYS.indexOf(ak) === -1 || !attrElementOk(el, ak)) continue;
          var av = sanitizeUrl(ak, patch.attrs[ak]);
          if (av != null) el.setAttribute(ak, av);
        }
      }
    }

    var published = null;
    function applyAll() {
      if (!published) return;
      for (var i = 0; i < published.length; i++) applyOne(published[i]);
    }

    function renderZaviBadge(badgeHidden, reserveSpace) {
      try {
        var existing = document.getElementById("zavi-made-badge");
        var spacer = document.getElementById("zavi-badge-spacer");
        if (badgeHidden !== false) {
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
          return;
        }
        var compact = reserveSpace === true;
        if (compact && !spacer) {
          spacer = document.createElement("div");
          spacer.id = "zavi-badge-spacer";
          spacer.setAttribute("aria-hidden", "true");
          spacer.setAttribute(
            "style",
            "all:revert;display:block !important;width:100% !important;height:52px !important;" +
              "margin:0 !important;padding:0 !important;pointer-events:none;",
          );
          (document.body || document.documentElement).appendChild(spacer);
        }
        if (!compact && spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
        if (existing) {
          if (existing.getAttribute("data-compact") === (compact ? "1" : "0")) return;
          if (existing.parentNode) existing.parentNode.removeChild(existing);
        }

        var PILL = "#17181b";
        var FONT = compact
          ? '600 12px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'
          : '600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
        var EDGE = compact ? "12px" : "16px";
        var TILE = compact ? "18px" : "22px";
        var MARK_SIZE = compact ? "14px" : "17px";

        var a = document.createElement("a");
        a.id = "zavi-made-badge";
        a.setAttribute("data-compact", compact ? "1" : "0");
        a.href = "https://www.zaviagent.com/?ref=badge";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", "Made with Zavi");
        a.setAttribute(
          "style",
          "all:revert;" +
            "position:fixed !important;bottom:" +
            EDGE +
            " !important;right:" +
            EDGE +
            " !important;" +
            "z-index:2147483000 !important;display:inline-flex !important;" +
            "align-items:center;" +
            (compact ? "gap:6px;padding:5px 10px 5px 5px;" : "gap:8px;padding:7px 14px 7px 7px;") +
            "background:" +
            PILL +
            ";color:#fff;font:" +
            FONT +
            ";border-radius:9999px;text-decoration:none;white-space:nowrap;" +
            "box-shadow:0 4px 14px rgba(0,0,0,.28);",
        );

        var tile = document.createElement("span");
        tile.setAttribute(
          "style",
          "all:revert;box-sizing:border-box;position:relative !important;" +
            "display:inline-flex !important;align-items:center;justify-content:center;" +
            "flex:none;width:" +
            TILE +
            " !important;height:" +
            TILE +
            " !important;" +
            "background:#fff;border-radius:7px;",
        );
        var NS = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 171 171");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute(
          "style",
          "all:revert;box-sizing:border-box;display:block !important;" +
            "width:" +
            MARK_SIZE +
            " !important;height:" +
            MARK_SIZE +
            " !important;flex:none;",
        );
        var MARK = [
          "M52.3358 111.675L100.767 61.1648H77.6401L40.0637 100.355C24.9741 116.092 35.6612 143 57.0011 143H114.386C135.726 143 146.412 116.092 131.323 100.355L121.829 90.453L109.027 103.805L117.983 113.145C122.145 117.487 119.197 124.91 113.31 124.91H57.5922C50.9695 124.91 47.6528 116.559 52.3358 111.675Z",
          "M119.464 59.3246L71.0323 109.835H94.1593L131.736 70.6455C146.825 54.9081 136.138 28 114.798 28H57.4139C36.0742 28 25.3871 54.9081 40.4767 70.6455L49.9702 80.5464L62.7727 67.1945L53.8166 57.854C49.654 53.5127 52.6021 46.0897 58.489 46.0897H114.207C120.83 46.0897 124.147 54.4406 119.464 59.3246Z",
        ];
        for (var mi = 0; mi < MARK.length; mi++) {
          var p = document.createElementNS(NS, "path");
          p.setAttribute("d", MARK[mi]);
          p.setAttribute("fill", "#1F1F1F");
          svg.appendChild(p);
        }
        tile.appendChild(svg);

        var label = document.createElement("span");
        label.setAttribute(
          "style",
          "all:revert;display:inline !important;font:" + FONT + ";color:#fff;",
        );
        label.textContent = "Made with Zavi";

        a.appendChild(tile);
        a.appendChild(label);
        (document.body || document.documentElement).appendChild(a);
      } catch (e) {
      }
    }

    function load() {
      var url;
      try {
        url = API + encodeURIComponent(location.host);
      } catch (e) {
        return;
      }
      try {
        fetch(url, { credentials: "omit" })
          .then(function (r) {
            return r && r.ok ? r.json() : null;
          })
          .then(function (j) {
            renderZaviBadge(j && j.badge_hidden, !!(j && j.badge_reserve === true));
            if (!j || !Array.isArray(j.edits) || j.edits.length === 0) return;
            published = j.edits;
            applyAll();
            setTimeout(applyAll, 600);
            setTimeout(applyAll, 2500);
          })
          .catch(function () {
          });
      } catch (e) {
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", load);
    } else {
      load();
    }
  }
})();
