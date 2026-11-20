(function () {
  "use strict";

  if (window.parent === window) return;

  var READY = "zavi:picker-ready";
  var SET = "zavi:picker-set";
  var PICKED = "zavi:element-picked";

  var parentOrigin = null;
  var enabled = false;
  var hovered = null;
  var HIGHLIGHT = "2px solid #d94f2b";
  var prevOutline = "";

  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    if (el.id && /^[A-Za-z0-9_-]+$/.test(el.id)) return "#" + el.id;

    var parts = [];
    var node = el;
    var depth = 0;

    while (node && node.nodeType === 1 && node !== document.body && depth < 4) {
      var tag = node.tagName.toLowerCase();
      var part = tag;

      var testId = node.getAttribute("data-testid");
      if (testId && /^[A-Za-z0-9_-]+$/.test(testId)) {
        part = tag + "[data-testid=" + testId + "]";
      } else if (node.classList && node.classList.length) {
        var cls = null;
        for (var i = 0; i < node.classList.length; i++) {
          if (/^[A-Za-z0-9_-]+$/.test(node.classList[i])) {
            cls = node.classList[i];
            break;
          }
        }
        if (cls) part = tag + "." + cls;
      }

      parts.unshift(part);

      if (part.indexOf("[data-testid=") !== -1) break;

      node = node.parentElement;
      depth++;
    }

    return parts.length ? parts.join(" ") : null;
  }

  function clearHighlight() {
    if (hovered) {
      hovered.style.outline = prevOutline;
      hovered = null;
    }
  }

  function onOver(e) {
    if (!enabled) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === hovered) return;
    clearHighlight();
    hovered = el;
    prevOutline = el.style.outline;
    el.style.outline = HIGHLIGHT;
  }

  function onClick(e) {
    if (!enabled || !parentOrigin) return;
    var selector = selectorFor(e.target);
    if (!selector) return;

    e.preventDefault();
    e.stopPropagation();

    window.parent.postMessage(
      { type: PICKED, selector: selector, tag: e.target.tagName.toLowerCase() },
      parentOrigin
    );

    setEnabled(false);
  }

  function setEnabled(next) {
    enabled = !!next;
    if (!enabled) clearHighlight();
    document.documentElement.style.cursor = enabled ? "crosshair" : "";
  }

  window.addEventListener("message", function (event) {
    if (!event.data || event.data.type !== SET) return;
    if (parentOrigin === null) parentOrigin = event.origin;
    if (event.origin !== parentOrigin) return;
    setEnabled(event.data.enabled);
  });

  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);

  window.parent.postMessage({ type: READY }, "*");
})();
