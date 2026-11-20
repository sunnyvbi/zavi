
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/app/connectors/ConnectButton", () => ({ startConnectFlow: vi.fn() }));

import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const html = (source: string, breaks = false) =>
  renderToStaticMarkup(<Markdown source={source} breaks={breaks} />);

describe("Markdown breaks prop", () => {
  const facts = "Channel: Meta\nSpend: $1,054\nCAC: $4";

  it("chat (breaks) renders one fact per line", () => {
    expect(html(facts, true)).toContain("Channel: Meta<br/>\nSpend: $1,054<br/>\nCAC: $4");
  });

  it("other surfaces keep CommonMark soft wraps (no <br>)", () => {
    const out = html(facts);
    expect(out).not.toContain("<br/>");
    expect(out).toContain("Channel: Meta\nSpend: $1,054\nCAC: $4");
  });

  it("breaks keeps lists, tables and code parsing normally", () => {
    const out = html("Steps:\n1. First\n2. Second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\nconst b = 2;\n```", true);
    expect(out).toContain("<ol>");
    expect(out).toContain("<table>");
    expect(out).toContain("const a = 1;\nconst b = 2;");
    expect(out).not.toMatch(/<code[^>]*>[^<]*<br/);
  });
});

describe("Markdown renderers", () => {
  it("never leaks react-markdown's node prop into the DOM", () => {
    const out = html("[docs](https://x.com)\n\n```ts\nconst a = 1;\n```\n\n`inline`");
    expect(out).not.toContain("node=");
  });

  it("keeps the language class on fenced code", () => {
    expect(html("```ts\nconst a = 1;\n```")).toMatch(/<code class="language-ts break-words">/);
  });

  it("opens external links in a new tab, keeps in-page anchors in the page", () => {
    expect(html("[docs](https://x.com)")).toContain('target="_blank" rel="noopener noreferrer"');
    const footnote = html("Claim[^1]\n\n[^1]: Source");
    expect(footnote).toMatch(/<a href="#user-content-fn-1"(?![^>]*target)/);
  });

  it("still renders praxis action links as in-app buttons", () => {
    expect(html("[Connect Slack](/__praxis_action__/connect:slack)")).toContain("<button");
  });

  it("model <br> no longer glues words together", () => {
    expect(html("Spend: $1,054<br>CAC: $4", true)).toContain("Spend: $1,054<br/>\nCAC: $4");
  });
});

describe("Markdown reading prop", () => {
  const src = "A paragraph with `an_identifier` in it.";

  it("stays on the chrome sans by default", () => {
    const out = html(src);
    expect(out).not.toContain("font-reading");
    expect(out).toContain("text-[16px]");
  });

  it("does not force the chrome face back onto headings inside a reading answer", () => {
    const out = renderToStaticMarkup(
      <Markdown source={"# A heading\n\nAnd a paragraph."} reading />,
    );
    for (const leak of [
      "prose-headings:font-display",
      "prose-headings:font-body",
      "prose-headings:font-sans",
      "prose-headings:font-mono",
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  it("switches to the serif reading face when opted in", () => {
    const out = renderToStaticMarkup(<Markdown source={src} reading />);
    expect(out).toContain("font-reading");
    expect(out).toContain("text-[16px]");
  });

  it("gives code the dedicated literal face, never the shared font-mono token", () => {
    const out = html(src);
    expect(out).toContain("prose-code:font-code");
    expect(out).not.toContain("prose-code:font-mono");
  });
});

describe("Markdown wide tables and bare URLs", () => {
  const url = "https://www.tiktok.com/@tyautoinvestments/video/7645367489492176142";

  it("wraps a table in a scroll box so it stays inside the chat column", () => {
    expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toContain('<div class="max-w-full overflow-x-auto"><table>');
  });

  it("shows a bare URL as a short label, keeps the full href and title", () => {
    const out = html(`| Link |\n|---|\n| ${url} |`);
    expect(out).toContain(`href="${url}"`);
    expect(out).toContain(`title="${url}"`);
    expect(out).toContain(">tiktok.com/@tyautoinvestments/video…</a>");
  });

  it("leaves a named link's text alone", () => {
    const out = html(`[watch](${url})`);
    expect(out).toContain(">watch</a>");
    expect(out).not.toContain("title=");
  });
});
