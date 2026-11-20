import { describe, it, expect } from "vitest";
import { sanitizeSvg } from "../svg";

describe("sanitizeSvg", () => {
  it("strips scripts, foreignObject, event handlers and javascript: links", () => {
    const out = sanitizeSvg(
      '<svg onload="x()"><script>alert(1)</script><foreignObject><div/></foreignObject><a href="javascript:x">t</a><path d="M0 0"/></svg>',
    );
    expect(out).not.toMatch(/script|foreignObject|onload|javascript:/i);
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("returns null for non-SVG input", () => {
    expect(sanitizeSvg("<html></html>")).toBeNull();
  });

  it("keeps ordinary drawing markup untouched", () => {
    const src = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#027bff"/></svg>';
    expect(sanitizeSvg(src)).toBe(src);
  });

  it("strips a self-closing script tag", () => {
    expect(sanitizeSvg('<svg><script src="https://evil/x.js"/><path d="M0 0"/></svg>')).not.toMatch(/script/i);
  });

  it("strips xlink:href javascript: links too", () => {
    expect(sanitizeSvg(`<svg><a xlink:href='javascript:alert(1)'>t</a></svg>`)).not.toMatch(/javascript:/i);
  });

  it("strips unquoted and non-javascript script urls on every link attribute", () => {
    const out = sanitizeSvg('<svg><a href=javascript:alert(1)>x</a><image xlink:href="data:text/html;base64,PHNjcmlwdD4=" /><use src=vbscript:msgbox /></svg>')!;
    expect(out).not.toMatch(/javascript:|data:text\/html|vbscript:/i);
    expect(out).toContain("<svg>");
  });
  it("strips a self-closing foreignObject and embedded HTML elements", () => {
    const out = sanitizeSvg('<svg><foreignObject/><iframe src="//evil"></iframe><embed/><object data="//evil"></object></svg>')!;
    expect(out).not.toMatch(/foreignObject|iframe|embed|object/i);
  });
  it("strips animate/set that would drive an href after load", () => {
    const out = sanitizeSvg('<svg><a><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"></set></a></svg>')!;
    expect(out).not.toMatch(/animate|<set|javascript:/i);
  });
  it("keeps a Recraft logo's <metadata> block whole so the SVG stays well-formed", () => {
    const src =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0L8 8" fill="rgb(243,89,43)"></path>' +
      '<metadata><recraft-signature>{"signed_by": "recraft", "signing_algo": "Ed25519"}</recraft-signature></metadata></svg>';
    const out = sanitizeSvg(src)!;
    expect(out).toBe(src);
    expect(out.match(/<metadata>/g)?.length).toBe(out.match(/<\/metadata>/g)?.length);
  });
  it("keeps elements whose names only start with a stripped tag name", () => {
    const src = '<svg viewBox="0 0 8 8"><metadata/><linkage/><settings/><baseline/><animateWidget/></svg>';
    expect(sanitizeSvg(src)).toBe(src);
  });
  it("still strips meta, link, base and animateColor tags", () => {
    const out = sanitizeSvg('<svg><meta http-equiv="refresh" content="0;url=//evil"/><link href="//evil"/><base href="//evil"/><animateColor attributeName="fill"/></svg>')!;
    expect(out).toBe("<svg></svg>");
  });
  it("keeps ordinary paint markup untouched", () => {
    const out = sanitizeSvg('<svg viewBox="0 0 64 64"><path d="M0 0L8 8" fill="#123456"/><circle cx="4" cy="4" r="2"/></svg>')!;
    expect(out).toContain('<path d="M0 0L8 8" fill="#123456"/>');
    expect(out).toContain("<circle");
  });
});
