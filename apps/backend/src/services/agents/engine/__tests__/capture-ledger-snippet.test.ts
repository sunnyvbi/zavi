
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordWebFetchCapture,
  recordCapture,
  getCapturedText,
  getCaptureLedger,
  markDiscoveryRun,
  isDiscoveryRun,
  __resetCaptureLedgerForTest,
} from "../capture-ledger";

const RUN = "run-snip";

function domTextContent(opts: {
  requested: string;
  final?: string;
  body: string;
}): string {
  return JSON.stringify({
    final_url: opts.final ?? opts.requested,
    status: 200,
    content_type: "text/html",
    body_text: `<untrusted_web_content>\n${opts.body}\n</untrusted_web_content>`,
    capture: "dom_text",
  });
}

function blockedContent(url: string): string {
  return JSON.stringify({
    error: "web_fetch_http_error",
    meta: { status: 403, final_url: url },
    final_url: url,
    status: 403,
    content_type: "text/html",
    body_text: "<untrusted_web_content>[blocked]</untrusted_web_content>",
    capture: "blocked",
  });
}

function emptyShellContent(url: string): string {
  return JSON.stringify({
    error: "web_fetch_empty_shell",
    meta: { status: 200, final_url: url },
    final_url: url,
    status: 200,
    content_type: "text/html",
    body_text: "<untrusted_web_content>[empty_shell]</untrusted_web_content>",
    capture: "empty_shell",
  });
}

describe("capture-ledger text_snippet + getCapturedText", () => {
  beforeEach(() => __resetCaptureLedgerForTest());

  it("stores a snippet for a successful dom_text capture", () => {
    const url = "https://fund.example/portfolio";
    recordWebFetchCapture(
      RUN,
      { url },
      domTextContent({ requested: url, body: "Acme Ventures led the seed round." }),
    );
    const ledger = getCaptureLedger(RUN);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].capture).toBe("dom_text");
    expect(ledger[0].text_snippet).toContain("Acme Ventures led the seed round.");
    expect(getCapturedText(RUN, url)).toContain("Acme Ventures led the seed round.");
  });

  it("stores a snippet for a rendered capture (recorded directly by the funnel)", () => {
    const url = "https://spa.example/page";
    recordCapture(RUN, {
      requested_url: url,
      final_url: url,
      capture: "rendered",
      status: 200,
      truncated: false,
      text_snippet: "<untrusted_web_content>\nNorthwind Capital invests in marketplaces.\n</untrusted_web_content>",
    });
    expect(getCapturedText(RUN, url)).toContain(
      "Northwind Capital invests in marketplaces.",
    );
  });

  it("stores NO snippet for a blocked capture", () => {
    const url = "https://blocked.example/x";
    recordWebFetchCapture(RUN, { url }, blockedContent(url));
    expect(getCaptureLedger(RUN)[0].text_snippet).toBeUndefined();
    expect(getCapturedText(RUN, url)).toBeNull();
  });

  it("stores NO snippet for an empty_shell capture", () => {
    const url = "https://spa.example/";
    recordWebFetchCapture(RUN, { url }, emptyShellContent(url));
    expect(getCaptureLedger(RUN)[0].text_snippet).toBeUndefined();
    expect(getCapturedText(RUN, url)).toBeNull();
  });

  it("matches by final_url when the requested URL redirected", () => {
    const requested = "https://fund.example/p";
    const final = "https://www.fund.example/portfolio/seed";
    recordWebFetchCapture(
      RUN,
      { url: requested },
      domTextContent({ requested, final, body: "Real page after redirect." }),
    );
    expect(getCapturedText(RUN, final)).toContain("Real page after redirect.");
    expect(getCapturedText(RUN, requested)).toContain("Real page after redirect.");
  });

  it("normalizes host case + trailing slash when matching", () => {
    const url = "https://Fund.Example.com/Portfolio";
    recordWebFetchCapture(
      RUN,
      { url },
      domTextContent({ requested: url, body: "Cased host page." }),
    );
    expect(getCapturedText(RUN, "https://fund.example.com/Portfolio/")).toContain(
      "Cased host page.",
    );
  });

  it("returns null for a URL the run never fetched", () => {
    const url = "https://fund.example/p";
    recordWebFetchCapture(RUN, { url }, domTextContent({ requested: url, body: "x" }));
    expect(getCapturedText(RUN, "https://other.example/never")).toBeNull();
    expect(getCapturedText("no-such-run", url)).toBeNull();
  });

  it("caps the stored snippet at 16KB", () => {
    const url = "https://big.example/page";
    const big = "x".repeat(40000);
    recordWebFetchCapture(RUN, { url }, domTextContent({ requested: url, body: big }));
    const snip = getCapturedText(RUN, url);
    expect(snip).not.toBeNull();
    expect((snip as string).length).toBeLessThanOrEqual(16000);
  });

  it("drops snippets once a run exceeds the per-run snippet-bytes cap", () => {
    const body = "y".repeat(16000);
    const urls: string[] = [];
    for (let i = 0; i < 40; i++) {
      const url = `https://many.example/p${i}`;
      urls.push(url);
      recordWebFetchCapture(RUN, { url }, domTextContent({ requested: url, body }));
    }
    expect(getCaptureLedger(RUN)).toHaveLength(40);
    expect(getCapturedText(RUN, urls[0])).not.toBeNull();
    expect(getCapturedText(RUN, urls[39])).toBeNull();
    const totalSnippetBytes = getCaptureLedger(RUN).reduce(
      (n, e) => n + (e.text_snippet?.length ?? 0),
      0,
    );
    expect(totalSnippetBytes).toBeLessThanOrEqual(512_000);
  });

  it("a discovery run retains a LARGER (24KB) per-entry snippet than the 16KB default", () => {
    markDiscoveryRun(RUN);
    expect(isDiscoveryRun(RUN)).toBe(true);
    const url = "https://disc.example/big-list";
    const big = "z".repeat(80000);
    recordWebFetchCapture(RUN, { url }, domTextContent({ requested: url, body: big }));
    const snip = getCapturedText(RUN, url);
    expect(snip).not.toBeNull();
    expect((snip as string).length).toBeGreaterThan(24 * 1024);
    expect((snip as string).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("a discovery run's per-run snippet cap is 4MB (multi-call list pages keep snippets)", () => {
    markDiscoveryRun(RUN);
    const body = "y".repeat(64 * 1024);
    const urls: string[] = [];
    for (let i = 0; i < 40; i++) {
      const url = `https://disc.example/p${i}`;
      urls.push(url);
      recordWebFetchCapture(RUN, { url }, domTextContent({ requested: url, body }));
    }
    expect(getCapturedText(RUN, urls[30])).not.toBeNull();
    const totalSnippetBytes = getCaptureLedger(RUN).reduce(
      (n, e) => n + (e.text_snippet?.length ?? 0),
      0,
    );
    expect(totalSnippetBytes).toBeLessThanOrEqual(4_000_000);
  });

  it("a NON-discovery run is unaffected (still 16KB per entry)", () => {
    const url = "https://plain.example/page";
    const big = "x".repeat(40000);
    recordWebFetchCapture(RUN, { url }, domTextContent({ requested: url, body: big }));
    expect((getCapturedText(RUN, url) as string).length).toBeLessThanOrEqual(16000);
    expect(isDiscoveryRun(RUN)).toBe(false);
  });

  it("refunds a URL's snippet bytes when its entry is overwritten (blocked→rendered)", () => {
    const url = "https://upgrade.example/p";
    recordWebFetchCapture(RUN, { url }, blockedContent(url));
    expect(getCapturedText(RUN, url)).toBeNull();
    recordCapture(RUN, {
      requested_url: url,
      final_url: url,
      capture: "rendered",
      status: 200,
      truncated: false,
      text_snippet: "<untrusted_web_content>\nReal rendered text here.\n</untrusted_web_content>",
    });
    expect(getCapturedText(RUN, url)).toContain("Real rendered text here.");
  });
});
