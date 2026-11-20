
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarkup, type Block, type Span } from "./markup";

function plain(spans: Span[]): string {
  return spans
    .map((s) => {
      if (s.kind === "text") return s.text;
      if (s.kind === "code") return s.text;
      if (s.kind === "link") return s.text;
      return plain(s.spans);
    })
    .join("");
}

function para(block: Block | undefined): Span[] {
  if (!block || block.kind !== "paragraph") throw new Error("expected a paragraph");
  return block.spans;
}

function list(block: Block | undefined): Extract<Block, { kind: "list" }> {
  if (!block || block.kind !== "list") throw new Error("expected a list");
  return block;
}

function strongs(blocks: Block[]): string[] {
  const out: string[] = [];
  const walk = (spans: Span[]): void => {
    for (const s of spans) {
      if (s.kind === "strong") out.push(plain(s.spans));
      if (s.kind === "strong") walk(s.spans);
    }
  };
  for (const b of blocks) {
    if (b.kind === "paragraph") walk(b.spans);
    else for (const item of b.items) walk(item);
  }
  return out;
}

function links(blocks: Block[]): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const walk = (spans: Span[]): void => {
    for (const s of spans) {
      if (s.kind === "link") out.push({ href: s.href, text: s.text });
      if (s.kind === "strong") walk(s.spans);
    }
  };
  for (const b of blocks) {
    if (b.kind === "paragraph") walk(b.spans);
    else for (const item of b.items) walk(item);
  }
  return out;
}

const REAL_REPLY = [
  "Yes — **Reethika Baddula**, based on the PDF filename in the thread (Reethika_Baddula_Resume.pdf).",
  "",
  "- **Role:** Senior Data Engineer",
  "- **Status:** Applied, waiting on a screen",
].join("\n");

describe("the real reply that started this", () => {
  const blocks = parseMarkup(REAL_REPLY);

  it("bolds the name and both labels, and keeps NO asterisks anywhere", () => {
    expect(strongs(blocks)).toEqual(["Reethika Baddula", "Role:", "Status:"]);
    const visible = blocks
      .map((b) => (b.kind === "paragraph" ? plain(b.spans) : b.items.map(plain).join("\n")))
      .join("\n");
    expect(visible).not.toContain("*");
  });

  it("turns the two rows into ONE unordered list of two items", () => {
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list"]);
    const rows = list(blocks[1]);
    expect(rows.ordered).toBe(false);
    expect(rows.items).toHaveLength(2);
    expect(plain(rows.items[0])).toBe("Role: Senior Data Engineer");
    expect(plain(rows.items[1])).toBe("Status: Applied, waiting on a screen");
  });

  it("keeps the lead sentence intact, em dash and parenthetical included", () => {
    expect(plain(para(blocks[0]))).toBe(
      "Yes — Reethika Baddula, based on the PDF filename in the thread (Reethika_Baddula_Resume.pdf).",
    );
  });
});

describe("markers that do not match render as the characters they are", () => {
  it("leaves an unmatched ** alone", () => {
    const blocks = parseMarkup("the **start of something that never closes");
    expect(strongs(blocks)).toEqual([]);
    expect(plain(para(blocks[0]))).toBe(
      "the **start of something that never closes",
    );
  });

  it("leaves a lone closing ** alone", () => {
    const blocks = parseMarkup("closed** but never opened");
    expect(strongs(blocks)).toEqual([]);
    expect(plain(para(blocks[0]))).toBe("closed** but never opened");
  });

  it("does not bold across a space-flanked pair", () => {
    const blocks = parseMarkup("2 ** 3 and 4 ** 5");
    expect(strongs(blocks)).toEqual([]);
    expect(plain(para(blocks[0]))).toBe("2 ** 3 and 4 ** 5");
  });

  it("leaves an asterisk inside a word alone", () => {
    const blocks = parseMarkup("the file is called foo*bar and the rate is 3*4");
    expect(strongs(blocks)).toEqual([]);
    expect(plain(para(blocks[0]))).toBe(
      "the file is called foo*bar and the rate is 3*4",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
  });

  it("does not bold a mid-word __ run", () => {
    const blocks = parseMarkup("call snake__case__name in the worker");
    expect(strongs(blocks)).toEqual([]);
    expect(plain(para(blocks[0]))).toBe(
      "call snake__case__name in the worker",
    );
  });

  it("does bold a standalone __run__", () => {
    const blocks = parseMarkup("the answer is __yes__ today");
    expect(strongs(blocks)).toEqual(["yes"]);
    expect(plain(para(blocks[0]))).toBe("the answer is yes today");
  });

  it("keeps the inner underscores literal in **a _b_ c**", () => {
    const blocks = parseMarkup("**a _b_ c** rest");
    expect(strongs(blocks)).toEqual(["a _b_ c"]);
    expect(plain(para(blocks[0]))).toBe("a _b_ c rest");
  });

  it("renders a fenced-looking block as its literal characters", () => {
    const src = "run this:\n```js\nconst a = 1;\n```\nthen reload";
    const blocks = parseMarkup(src);
    expect(blocks).toHaveLength(1);
    expect(para(blocks[0]).every((s) => s.kind === "text")).toBe(true);
    expect(plain(para(blocks[0]))).toBe(src);
  });

  it("does not treat a line that is only a hyphen as a list", () => {
    const blocks = parseMarkup("before\n-\nafter");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
    expect(plain(para(blocks[0]))).toBe("before\n-\nafter");
  });

  it("does not treat a bullet with no content as a list", () => {
    const blocks = parseMarkup("- ");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph"]);
  });
});

describe("links, and the scheme that is not one", () => {
  it("renders NO link for a javascript: url, in either form", () => {
    const labelled = parseMarkup("[click me](javascript:alert(document.cookie))");
    expect(links(labelled)).toEqual([]);
    expect(plain(para(labelled[0]))).toBe(
      "[click me](javascript:alert(document.cookie))",
    );

    const bare = parseMarkup("go to javascript:alert(1) now");
    expect(links(bare)).toEqual([]);
    expect(plain(para(bare[0]))).toBe("go to javascript:alert(1) now");
  });

  it("renders no link for data:, file: or chrome-extension:", () => {
    for (const url of [
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "chrome-extension://abc/panel.html",
    ]) {
      const blocks = parseMarkup(`see [here](${url}) and ${url}`);
      expect(links(blocks)).toEqual([]);
    }
  });

  it("links a labelled https url and shows the label, not the url", () => {
    const blocks = parseMarkup("read the [Privacy Policy](https://www.zaviagent.com/privacy).");
    expect(links(blocks)).toEqual([
      { href: "https://www.zaviagent.com/privacy", text: "Privacy Policy" },
    ]);
    expect(plain(para(blocks[0]))).toBe("read the Privacy Policy.");
  });

  it("links a bare url and leaves the sentence's full stop outside it", () => {
    const blocks = parseMarkup("it is at https://api.zaviagent.com/health.");
    expect(links(blocks)).toEqual([
      { href: "https://api.zaviagent.com/health", text: "https://api.zaviagent.com/health" },
    ]);
    expect(plain(para(blocks[0]))).toBe(
      "it is at https://api.zaviagent.com/health.",
    );
  });

  it("does not eat a closing paren the url never opened", () => {
    const blocks = parseMarkup("(see https://zaviagent.com/x)");
    expect(links(blocks)).toEqual([
      { href: "https://zaviagent.com/x", text: "https://zaviagent.com/x" },
    ]);
  });
});

describe("code spans", () => {
  it("renders a backticked run as code and drops the backticks", () => {
    const blocks = parseMarkup("run `npm run build -w @zavi/extension` first");
    const code = para(blocks[0]).filter((s) => s.kind === "code");
    expect(code).toEqual([{ kind: "code", text: "npm run build -w @zavi/extension" }]);
  });

  it("keeps a marker inside a code span literal", () => {
    const blocks = parseMarkup("the syntax is `**bold**` in markdown");
    expect(strongs(blocks)).toEqual([]);
    expect(para(blocks[0]).filter((s) => s.kind === "code")).toEqual([
      { kind: "code", text: "**bold**" },
    ]);
  });

  it("leaves an unclosed backtick as a backtick", () => {
    const blocks = parseMarkup("the ` is a backtick");
    expect(plain(para(blocks[0]))).toBe("the ` is a backtick");
  });
});

describe("lists", () => {
  it("numbers an ordered list from the number the model used", () => {
    const blocks = parseMarkup("3. third\n4. fourth");
    const ol = list(blocks[0]);
    expect(ol.ordered).toBe(true);
    expect(ol.start).toBe(3);
    expect(ol.items.map(plain)).toEqual(["third", "fourth"]);
  });

  it("splits a bullet run and a numbered run into two lists", () => {
    const blocks = parseMarkup("- a\n- b\n1. c");
    expect(blocks.map((b) => b.kind)).toEqual(["list", "list"]);
    expect(list(blocks[0]).ordered).toBe(false);
    expect(list(blocks[1]).ordered).toBe(true);
  });

  it("keeps a paragraph's own line breaks", () => {
    const blocks = parseMarkup("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(1);
    expect(plain(para(blocks[0]))).toBe("one\ntwo\n\nthree");
  });

  it("drops the blank line between a paragraph and a list rather than emitting an empty block", () => {
    const blocks = parseMarkup("lead\n\n- a");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list"]);
  });
});

describe("the empty and the ordinary", () => {
  it("returns nothing for an empty or whitespace-only body", () => {
    expect(parseMarkup("")).toEqual([]);
    expect(parseMarkup("   \n\n  ")).toEqual([]);
  });

  it("returns one plain paragraph for a sentence with no markers", () => {
    const blocks = parseMarkup("There is no recruiter assigned to this thread yet.");
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        spans: [{ kind: "text", text: "There is no recruiter assigned to this thread yet." }],
      },
    ]);
  });
});

describe("no dangerouslySetInnerHTML anywhere in the panel", () => {
  it("does not appear in any source file", () => {
    const root = resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const src = readFileSync(full, "utf8");
        if (full === __filename) continue;
        for (const line of src.split("\n")) {
          if (!line.includes("dangerouslySetInnerHTML") && !line.includes("innerHTML")) continue;
          const code = line.replace(/^\s*(\{?\/\*|\/\/|\*).*$/, "");
          if (code.includes("dangerouslySetInnerHTML") || code.includes("innerHTML")) {
            hits.push(`${full}: ${line.trim()}`);
          }
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("a link may not name a host it does not go to", () => {
  it("renders a mismatched host label as literal characters, not a link", () => {
    const src = "[https://www.zaviagent.com/login](https://evil.example/steal)";
    const blocks = parseMarkup(src);
    expect(links(blocks)).toEqual([]);
    expect(plain(para(blocks[0]))).toBe(src);
  });

  it("still links when the label names the SAME host", () => {
    const blocks = parseMarkup(
      "[https://www.zaviagent.com/login](https://www.zaviagent.com/login?next=/x)",
    );
    expect(links(blocks)).toEqual([
      {
        href: "https://www.zaviagent.com/login?next=/x",
        text: "https://www.zaviagent.com/login",
      },
    ]);
  });

  it("leaves ordinary prose labels alone", () => {
    const blocks = parseMarkup("[the login page](https://evil.example/steal)");
    expect(links(blocks)).toEqual([
      { href: "https://evil.example/steal", text: "the login page" },
    ]);
  });

  it("refuses a label that looks like a URL but will not parse", () => {
    const blocks = parseMarkup("[https://](https://www.zaviagent.com)");
    expect(links(blocks)).toEqual([]);
  });
});

describe("scheme checks hold in the shapes a reviewer reaches for", () => {
  it("accepts an uppercase http scheme", () => {
    expect(links(parseMarkup("[x](HTTPS://WWW.ZAVIAGENT.COM/a)"))).toHaveLength(1);
  });

  it("refuses a protocol-relative url", () => {
    const src = "[x](//evil.example/steal)";
    const blocks = parseMarkup(src);
    expect(links(blocks)).toEqual([]);
    expect(plain(para(blocks[0]))).toBe(src);
  });
});

describe("one run too long to scan is left literal rather than scanned", () => {
  it("returns a run past the cap without scanning it", () => {
    const src = "**a ".repeat(10_001);
    const started = Date.now();
    const spans = para(parseMarkup(src)[0]);
    expect(Date.now() - started).toBeLessThan(250);
    expect(spans).toEqual([{ kind: "text", text: src }]);
    expect(plain(spans)).toBe(src);
  });

  it("still formats a run just under the cap", () => {
    const spans = para(parseMarkup(`**bold** ${"x".repeat(39_000)}`)[0]);
    expect(spans[0]).toEqual({ kind: "strong", spans: [{ kind: "text", text: "bold" }] });
  });
});
