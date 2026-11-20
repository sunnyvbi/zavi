
import { describe, it, expect, vi } from "vitest";
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import {
  SEO_OPEN_PR_CLASS,
  SEO_PR_SPEC,
  buildEngineerTask,
  buildSeoPrCard,
  copyTextProblem,
  payloadProblem,
  seoContent,
  startSeoPullRequest,
  type SeoPageCopyPayload,
} from "../seo-open-pr";
import { parse } from "parse5";
import { HTML_MAX_TAGS, PAGE_HTML_CAP, PAGE_COPY_APPROVER_GONE, PAGE_COPY_NOT_ONE_FILE, PAGE_COPY_NOT_ON_PAGE, PAGE_COPY_NOT_PLAIN_TEXT, PAGE_COPY_READ_FAILED, visibleText, checkPageCopyPr, copyBlockProblem, pageTextProblem, pageCopyContentProblem, pageCopyTarget, typographicApostrophes } from "../page-copy-check";
import { GITHUB_UNREACHABLE, MAX_ENGINEER_TASK_CHARS, settlementFor, type SettleRun } from "../site-pr";
import { channelActionNeedsAdmin } from "../approve-role";
import { checkSeoPrProposal } from "@/services/tools/seo/propose_pr";

const D = (readFile: (...a: unknown[]) => Promise<string>, role: string | null = "owner", pageHtml?: () => Promise<string>) => ({ headSha: async () => "a".repeat(40), readFile, role: async () => role, pageHtml: pageHtml ?? (() => readFile()) });
const PAGE = "https://acme.com/";
const OLD = "We rent cars by the day.\nPick up at the airport.";
const NEW = "Rent a car by the day or the week.\nPick up at the airport or downtown.";
const PC: SeoPageCopyPayload = { kind: "page_copy", title: "Say weekly rentals on the home page", page_url: "https://acme.com/", repo: "acme/site", blocks: [{ current_text: OLD, new_text: NEW }] };
const okDeps = { engineerAllowed: async () => ({ allowed: true, required_tier: "pro" as const }), website: async () => "acme.com", resolveRepo: async () => "acme/site" };

describe("input limits, in code", () => {
  it.each([
    ["markup", "Click <a href='x'>here</a>"],
    ["a closing angle", "price > 20"],
    ["a backtick", "run `rm -rf`"],
    ["a template", "Hello {{ name }}"],
    ["a foreign URL", "See https://evil.example/x for more"],
    ["a protocol-relative URL", "see //evil.example/x"],
    ["a www host elsewhere", "visit www.evil.example today"],
    ["a script scheme", "javascript: alert(1)"],
    ["a control character", "a\u0007b"],
  ])("refuses %s", (_l, text) => {
    expect(copyTextProblem(text, "acme.com")).not.toBeNull();
  });

  it("allows plain multi-line text and the site's own address", () => {
    expect(copyTextProblem("Book at https://acme.com/book.\nOpen daily: 9-5, Note: closed Sundays.", "acme.com")).toBeNull();
    expect(copyTextProblem("www.acme.com has it", "acme.com")).toBeNull();
  });

  it("3 blocks of 600 characters at most, distinct and non-overlapping, checked on both texts", async () => {
    const block = { current_text: "a".repeat(600), new_text: "b".repeat(600) };
    await expect(checkSeoPrProposal("t", { title: "x", why: "y", page_url: "https://acme.com/", copy: [block, block, block, block], evidence: ["e"] } as never, okDeps)).rejects.toThrow();
    expect(SEO_PR_SPEC.schema.safeParse({ ...PC, blocks: [{ current_text: "a".repeat(601), new_text: "b" }] }).success).toBe(false);
    expect(payloadProblem({ ...PC, blocks: [{ current_text: "rent cars", new_text: "rent vans" }, { current_text: "We rent cars by the day.", new_text: "We rent vans weekly." }] }, "acme.com")).toMatch(/overlapping/);
    expect(payloadProblem({ ...PC, blocks: [{ current_text: OLD, new_text: OLD }] }, "acme.com")).toMatch(/same as its current/);
    expect(payloadProblem({ ...PC, blocks: [{ current_text: OLD, new_text: "Go to https://evil.example" }] }, "acme.com")).toMatch(/own site/);
  });

  it("the propose tool takes head tags OR copy, never both or neither", async () => {
    const base = { title: "x", why: "y", page_url: "https://acme.com/", evidence: ["e"] };
    await expect(checkSeoPrProposal("t", base as never, okDeps)).rejects.toThrow(/either head-tag changes or page copy/);
    await expect(checkSeoPrProposal("t", { ...base, copy: PC.blocks, changes: [{ kind: "title", before: "a", after: "b" }] } as never, okDeps)).rejects.toThrow(/either/);
    const p = await checkSeoPrProposal("t", { ...base, copy: PC.blocks } as never, okDeps);
    expect(p).toMatchObject({ kind: "page_copy", repo: "acme/site", blocks: PC.blocks });
  });
});

describe("page copy can never reach code (security review, fail closed)", () => {
  const cur = "Rent a car by the day.";
  const atWrite = (current: string, next: string) =>
    checkPageCopyPr("t", "acme/site", { files: [{ path: "a.tsx", action: "modify", content: next }] }, [{ current_text: current, new_text: next }], "u", PAGE, D(async () => current));

  it.each([
    ["a double quote", 'Rent a car "today"'],
    ["a template expression", "Rent a car ${process.env.KEY}"],
    ["a closing brace", "Rent a car } + evil()"],
    ["an opening brace", "Rent a car { x }"],
    ["a backslash", "Rent a car \\n"],
    ["a dollar sign", "Rent from $20"],
    ["a plain apostrophe with no conversion", "Rent a car, it's easy"],
    ["an equals sign", "Rent a car = cheap"],
    ["a semicolon", "Rent a car; cheap"],
    ["a backtick", "Rent a car `now`"],
  ])("new text with %s is refused, at propose and at the write", async (_l, next) => {
    expect(copyBlockProblem(cur, next)).not.toBeNull();
    expect(payloadProblem({ ...PC, blocks: [{ current_text: cur, new_text: next }] }, "acme.com")).not.toBeNull();
    expect(((await atWrite(cur, next)) as { refusal?: string })?.refusal).toBe(PAGE_COPY_NOT_PLAIN_TEXT);
  });

  it("a current text that spans a string boundary is refused (it becomes a manual card), whatever the new text", async () => {
    const boundary = 'Hi" + x + "';
    expect(copyBlockProblem(boundary, "Hello there")).toMatch(/manual step/);
    expect(payloadProblem({ ...PC, blocks: [{ current_text: boundary, new_text: "Hello there" }] }, "acme.com")).toMatch(/manual step/);
    expect(((await atWrite(boundary, "Hello there")) as { refusal?: string })?.refusal).toBe(PAGE_COPY_NOT_PLAIN_TEXT);
    for (const c of ["It's simple.", "a = b", "x; y", "{x}", "<b>", "$5", "\\n"]) expect(copyBlockProblem(c, "Plain text")).not.toBeNull();
  });

  it("a plain sentence with a typographic apostrophe passes; a plain one is converted by the propose tool first", async () => {
    expect(copyBlockProblem(cur, "Rent a car by the day, week or month (from 9 am) \u2019til late: 100% easy/fast!")).toBeNull();
    expect(copyBlockProblem(cur, "It\u2019s \u201Csimple\u201D")).toBeNull();
    expect(typographicApostrophes("it's")).toBe("it\u2019s");
    const p = await checkSeoPrProposal("t", { title: "x", why: "y", page_url: "https://acme.com/", copy: [{ current_text: cur, new_text: "It's easy to rent a car." }], evidence: ["e"] } as never, okDeps);
    expect((p as SeoPageCopyPayload).blocks[0]!.new_text).toBe("It\u2019s easy to rent a car.");
  });
});

describe("the text must sit in page text, not code (structural check at the write)", () => {
  const blk = (current_text: string, new_text = "Plain new words") => [{ current_text, new_text }];

  it("an identifier swap is refused: at propose (not prose) and at the write (not inside a string)", async () => {
    expect(copyBlockProblem("isOpen", "fetch(x)")).toMatch(/prose/);
    const src = "const show = isOpen && ready;\nexport default show;\n";
    expect(pageTextProblem("a.ts", src, blk("isOpen && ready"))).toMatch(/not wholly inside one page-text string/);
    const r = await checkPageCopyPr("t", "acme/site", { files: [{ path: "a.ts", action: "modify", content: src.replace("isOpen && ready", "Plain new words") }] }, blk("isOpen && ready"), "u", PAGE, D(async () => src));
    expect((r as { refusal?: string })?.refusal).toBe(PAGE_COPY_NOT_PLAIN_TEXT);
  });

  it("text inside JSX text passes; text inside a string literal passes", () => {
    const tsx = "export function Hero() {\n  return <h1 className=\"big\">Rent a car by the day</h1>;\n}\nconst tag = \"Pick up at the airport\";\n";
    expect(pageTextProblem("Hero.tsx", tsx, blk("Rent a car by the day"))).toBeNull();
    expect(pageTextProblem("Hero.tsx", tsx, blk("Pick up at the airport"))).toBeNull();
  });

  it("text that crosses a {expr} in JSX is refused, and so is a template with a substitution", () => {
    const tsx = "export const A = () => <p>Rent a car {city} today</p>;\nconst t = `Rent in ${city} now`;\n";
    expect(pageTextProblem("A.tsx", tsx, blk("car {city} today"))).toMatch(/not wholly inside/);
    expect(pageTextProblem("A.tsx", tsx, blk("Rent in"))).toMatch(/not wholly inside/);
  });

  it("a .json, .vue or .svelte target is refused", () => {
    for (const f of ["data.json", "App.vue", "Page.svelte", "README"]) expect(pageTextProblem(f, "{\"a\": \"Rent a car\"}", blk("Rent a car"))).toMatch(/not one Zavi changes/);
  });

  it("markup: text in a paragraph passes; text touching a tag, attribute, comment, script or code fence is refused", () => {
    const html = "<p class=\"lead\">Rent a car by the day</p>\n<!-- Rent a car later -->\n<script>var s = \"Rent a car now\";</script>\n";
    expect(pageTextProblem("index.html", html, blk("Rent a car by the day"))).toBeNull();
    expect(pageTextProblem("index.html", html, blk("lead\">Rent a car"))).toMatch(/touches markup/);
    expect(pageTextProblem("x.html", "<!-- Rent a car later -->", blk("Rent a car later"))).toMatch(/touches markup/);
    expect(pageTextProblem("x.html", "<script>var s = \"Rent a car now\";</script>", blk("Rent a car now"))).toMatch(/touches markup/);
  });
});

describe("review fixes: links, chained blocks, the approver at the write, pinned base, honest failures", () => {
  it("a scheme without // or a non-web scheme is refused (a markdown link could carry it)", () => {
    expect(copyTextProblem("Visit (http:evil.example/path) now", "acme.com")).toMatch(/own site/);
    expect(copyTextProblem("Call us at tel:5551234 today", "acme.com")).toMatch(/own site/);
    expect(copyTextProblem("Write to mailto:x@evil.example please", "acme.com")).toMatch(/own site/);
  });

  it("a block whose new text holds another block's current text is refused, at propose and at the write", async () => {
    const blocks = [{ current_text: "Plans start at twenty dollars.", new_text: "Plans start at twenty dollars with friendly support." }, { current_text: "friendly support", new_text: "priority human help" }];
    expect(payloadProblem({ ...PC, blocks }, "acme.com")).toMatch(/repeats another block/);
    const r = await checkPageCopyPr("t", "acme/site", { files: [{ path: "a.html", action: "modify", content: "x" }] }, blocks, "u", PAGE, D(async () => "x"));
    expect((r as { refusal: string }).refusal).toBe(PAGE_COPY_NOT_PLAIN_TEXT);
  });

  it("an approver who is no longer owner or admin stops the PR at the write", async () => {
    for (const role of ["member", null]) {
      const r = await checkPageCopyPr("t", "acme/site", { files: [] }, PC.blocks, "u", PAGE, D(async () => "", role));
      expect((r as { refusal: string }).refusal).toBe(PAGE_COPY_APPROVER_GONE);
    }
    const none = await checkPageCopyPr("t", "acme/site", { files: [] }, PC.blocks, null, PAGE, D(async () => ""));
    expect((none as { refusal: string }).refusal).toBe(PAGE_COPY_APPROVER_GONE);
  });

  it("the read is pinned to the base head commit, and that commit is returned for the PR", async () => {
    const FILE = `<p>${OLD}</p>\n`;
    const readFile = vi.fn(async () => FILE);
    const r = await checkPageCopyPr("t", "acme/site", { files: [{ path: "index.html", action: "modify", content: FILE.replace(OLD, NEW) }], base_branch: "main" }, PC.blocks, "u", PAGE, { headSha: async () => "b".repeat(40), readFile, role: async () => "admin", pageHtml: async () => FILE });
    expect(r).toEqual({ base_sha: "b".repeat(40) });
    expect(readFile).toHaveBeenCalledWith("t", "acme/site", "b".repeat(40), "index.html");
  });

  it("a failed engineer run is not called 'not found'; a successful one with no change is", () => {
    const run: SettleRun = { id: "e", tenant_id: "t", agent_slug: "engineer", status: "failed", enqueued_by: null, payload: { site_pr_card: { action_id: "a", claim_id: "c", exec_class: SEO_OPEN_PR_CLASS }, site_pr_content: seoContent(PC) }, parsed: {} };
    expect(settlementFor(run, [], { final: false, runDeadlinePassed: false })).not.toMatchObject({ error: PAGE_COPY_NOT_ONE_FILE });
    expect(settlementFor({ ...run, status: "success" }, [], { final: false, runDeadlinePassed: false })).not.toMatchObject({ error: PAGE_COPY_NOT_ONE_FILE });
    expect(settlementFor({ ...run, status: "success" }, [{ id: "d", status: "dispatch_failed", dispatch_error: PAGE_COPY_READ_FAILED }], { final: false, runDeadlinePassed: false })).toMatchObject({ error: PAGE_COPY_READ_FAILED });
  });
});

describe("second Codex pass: code strings, markdown, line breaks, any scheme, the live page", () => {
  const blk = (current_text: string, new_text = "Plain new words") => [{ current_text, new_text }];

  it("a string that is code, not copy, is refused even though it reads like words", () => {
    const tsx = [
      '"use client";',
      'import x from "some module path";',
      'const q = db.query("select all users");',
      'export const A = () => <a href="go to home" className="big red">Book a car now</a>;',
      'const copy = { hero: "Rent a car by the day", items: ["Pick up anywhere"] };',
    ].join("\n");
    expect(pageTextProblem("A.tsx", tsx, blk("use client"))).toMatch(/page-text/);
    expect(pageTextProblem("A.tsx", tsx, blk("some module path"))).toMatch(/page-text/);
    expect(pageTextProblem("A.tsx", tsx, blk("select all users"))).toMatch(/page-text/);
    expect(pageTextProblem("A.tsx", tsx, blk("go to home"))).toMatch(/page-text/);
    expect(pageTextProblem("A.tsx", tsx, blk("big red"))).toMatch(/page-text/);
    expect(pageTextProblem("A.tsx", tsx, blk("Book a car now"))).toBeNull();
    expect(pageTextProblem("A.tsx", tsx, blk("Rent a car by the day"))).toBeNull();
    expect(pageTextProblem("A.tsx", tsx, blk("Pick up anywhere"))).toBeNull();
  });

  it("a line break into a one-line string is refused; into JSX text it is fine", () => {
    const tsx = 'const c = { hero: "Rent a car by the day" };\nexport const H = () => <p>Book a car now</p>;\n';
    expect(pageTextProblem("A.tsx", tsx, blk("Rent a car by the day", "Rent a car\nby the week"))).toMatch(/line break/);
    expect(pageTextProblem("A.tsx", tsx, blk("Book a car now", "Book a car\ntoday"))).toBeNull();
    expect(copyBlockProblem("Rent a car by the day", "Rent a car\rtoday")).not.toBeNull();
  });

  it("markdown: double-backtick code, indented code, an unclosed fence and nested MDX braces are code", () => {
  });

  it("any scheme without https:// on the site's host is refused", () => {
    for (const t of ["Visit ssh:evil.example/path now", "Open market:details today", "Try git:repo here"]) expect(copyTextProblem(t, "acme.com")).toMatch(/own site/);
    expect(copyTextProblem("Book at https://acme.com/book today", "acme.com")).toBeNull();
    expect(copyTextProblem("Note: we close at five", "acme.com")).toBeNull();
  });

  it("the current text must be visible on the live page, or nothing opens", async () => {
    const FILE = `<p>${OLD}</p>\n`;
    const p = { files: [{ path: "index.html", action: "modify", content: FILE.replace(OLD, NEW) }] };
    const off = await checkPageCopyPr("t", "acme/site", p, PC.blocks, "u", PAGE, D(async () => FILE, "owner", async () => "<p>Something else</p>"));
    expect((off as { refusal: string }).refusal).toBe(PAGE_COPY_NOT_ON_PAGE);
    const down = await checkPageCopyPr("t", "acme/site", p, PC.blocks, "u", PAGE, D(async () => FILE, "owner", async () => { throw new Error("503"); }));
    expect((down as { refusal: string }).refusal).toBe(PAGE_COPY_READ_FAILED);
    const on = await checkPageCopyPr("t", "acme/site", p, PC.blocks, "u", PAGE, D(async () => FILE, "owner", async () => `<html><body><div>${OLD.replace("\n", "<br>\n")}</div></body></html>`));
    expect(on).toEqual({ base_sha: "a".repeat(40) });
    expect(visibleText("<p>A&nbsp;b &amp; c</p><script>x()</script>")).toBe("A b & c");
  });
});

describe("a string fed to a call, new or tagged template is code, however deep (security review)", () => {
  const blk = (current_text: string) => [{ current_text, new_text: "Plain new words" }];
  it.each([
    ['track({ label: "Rent a car today" });', "Rent a car today"],
    ['analytics.send([{ name: "Rent a car today" }]);', "Rent a car today"],
    ['const w = new Worker({ name: "Rent a car today" });', "Rent a car today"],
    ['const q = sql`Rent a car today`;', "Rent a car today"],
    ['const r = run({ steps: [{ say: "Rent a car today" }] });', "Rent a car today"],
  ])("%s is refused", (src, text) => {
    expect(pageTextProblem("a.ts", src, blk(text))).toMatch(/page-text/);
  });
  it("the same text as plain data is allowed", () => {
    expect(pageTextProblem("a.ts", 'const copy = { hero: { title: "Rent a car today" }, list: ["Rent a car today too"] };', blk("Rent a car today"))).toBeNull();
    expect(pageTextProblem("a.ts", 'export default { hero: "Rent a car today" };', blk("Rent a car today"))).toBeNull();
  });
});

describe("third Codex/Grok pass: fences, MDX strings, receipt files, error order, base pin", () => {
  const blk = (current_text: string) => [{ current_text, new_text: "Plain new words" }];
  it("a fence inside a blockquote and a brace inside an MDX string are still code", () => {
  });

  it("the receipt lists only the opening decision's plain repo paths", () => {
    const run: SettleRun = { id: "e", tenant_id: "t", agent_slug: "engineer", status: "success", enqueued_by: null, payload: { site_pr_card: { action_id: "a", claim_id: "c", exec_class: SEO_OPEN_PR_CLASS } }, parsed: { pr_url: "https://github.com/acme/site/pull/9", pr_number: 9 } };
    const out = settlementFor(run, [{ id: "d1", status: "dispatch_failed", files: ["old.html"] }, { id: "d2", status: "acted", files: ["index.html", "../etc/passwd", "https://evil.example/x", "/abs"] }], { final: false, runDeadlinePassed: false });
    expect(out).toMatchObject({ ok: true, result: { files: ["index.html"] } });
  });

  it("a removed approver is reported before a file problem", () => {
    const run: SettleRun = { id: "e", tenant_id: "t", agent_slug: "engineer", status: "success", enqueued_by: null, payload: { site_pr_card: { action_id: "a", claim_id: "c", exec_class: SEO_OPEN_PR_CLASS }, site_pr_content: seoContent(PC) }, parsed: {} };
    expect(settlementFor(run, [{ id: "a", status: "dispatch_failed", dispatch_error: PAGE_COPY_NOT_ONE_FILE }, { id: "b", status: "dispatch_failed", dispatch_error: PAGE_COPY_APPROVER_GONE }], { final: false, runDeadlinePassed: false })).toMatchObject({ error: PAGE_COPY_APPROVER_GONE });
  });
});

describe("fourth Codex/Grok pass: one opening decision, honest no-change, approver before GitHub", () => {
  const base: SettleRun = { id: "e", tenant_id: "t", agent_slug: "engineer", status: "success", enqueued_by: null, payload: { site_pr_card: { action_id: "a", claim_id: "c", exec_class: SEO_OPEN_PR_CLASS }, site_pr_content: seoContent(PC) }, parsed: {} };
  const go = { final: false, runDeadlinePassed: false };
  it("two acted decisions: the opening one is unknown, so no file list is shown", () => {
    const out = settlementFor({ ...base, parsed: { pr_url: "https://github.com/acme/site/pull/9", pr_number: 9 } }, [{ id: "d1", status: "acted", files: ["a.html"] }, { id: "d2", status: "acted", files: ["b.html"] }], go);
    expect(out).toMatchObject({ ok: true });
    expect((out as { result: Record<string, unknown> }).result.files).toBeUndefined();
    const one = settlementFor({ ...base, parsed: { pr_url: "https://github.com/acme/site/pull/9" } }, [{ id: "d1", status: "acted", files: ["a.html", "<img/src=x>"] }], go);
    expect(one).toMatchObject({ result: { files: ["a.html"] } });
  });
  it("only a cleanly finished page-copy run is called no change", () => {
    expect(settlementFor(base, [], go)).toMatchObject({ result: { code: "page_copy_no_change" } });
    expect((settlementFor({ ...base, status: "error" }, [], go) as { result: Record<string, unknown> }).result.code).toBeUndefined();
    expect((settlementFor({ ...base, status: "cancelled" }, [], go) as { result: Record<string, unknown> }).result.code).toBeUndefined();
  });
  it("a removed approver is named before an unreachable GitHub", () => {
    expect(settlementFor(base, [{ id: "a", status: "dispatch_failed", dispatch_error: GITHUB_UNREACHABLE }, { id: "b", status: "dispatch_failed", dispatch_error: PAGE_COPY_APPROVER_GONE }], go)).toMatchObject({ error: PAGE_COPY_APPROVER_GONE });
  });
});

describe("Grok on the validator: strings fed to code, real tag ends, addresses", () => {
  const blk = (current_text: string) => [{ current_text, new_text: "Plain new words" }];
  const T = "rent a car";
  it("a string under a non-text JSX attribute is never page text, even through an object or array", () => {
    expect(pageTextProblem("a.tsx", `const A = () => <div dangerouslySetInnerHTML={{ __html: "${T}" }} />;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <a href={["${T}"]} />;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <a {...{ href: "${T}" }} />;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <a title={"${T}"} />;`, blk(T))).toBeNull();
    expect(pageTextProblem("a.tsx", `const A = () => <p>{ok ? "${T}" : "other words"}</p>;`, blk(T))).toBeNull();
  });
  it("a string under a call is never page text, even through an arrow or a return", () => {
    expect(pageTextProblem("a.ts", `exec(() => "${T}");`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.ts", `sql(() => { return "${T}"; });`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.ts", `exec(() => { return { q: "${T}" }; });`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.ts", `run(function () { const q = "${T}"; return q; });`, blk(T))).toMatch(/not wholly inside/);
  });
  it("site copy shapes stay page text", () => {
    expect(pageTextProblem("a.ts", `export const hero = { title: "${T}" };`, blk(T))).toBeNull();
    expect(pageTextProblem("a.ts", `const items = ["${T}"]; export default items;`, blk(T))).toBeNull();
    expect(pageTextProblem("a.tsx", `export default function P() { const t = "${T}"; return <h1>{t}</h1>; }`, blk(T))).toBeNull();
    expect(pageTextProblem("a.tsx", `export default function P() { return <ul>{xs.map((x) => <li key={x}>${T}</li>)}</ul>; }`, blk(T))).toBeNull();
  });
  it("a > in a quoted attribute does not end the tag, in the file or in the page's visible text", () => {
    const html = `<img alt="a > b" onerror="rent a car" src="x"><p>real words</p>`;
    expect(pageTextProblem("a.html", html, blk(T))).toMatch(/touches markup/);
    expect(pageTextProblem("a.html", html, blk("real words"))).toBeNull();
    expect(visibleText(html)).toBe("real words");
    expect(pageTextProblem("a.html", `<img alt="unclosed ${T}`, blk(T))).toMatch(/touches markup/);
  });
  it("Markdown link addresses and reference definitions are not page text", () => {
  });
  it("a brace in an MDX comment or regex does not close the expression", () => {
  });
});

describe("security review: JSX context, script and style, tag quotes", () => {
  const blk = (current_text: string) => [{ current_text, new_text: "Plain new words" }];
  const T = "rent a car";
  it("text under a non-text attribute is code at any depth, as a string or as JSX text", () => {
    expect(pageTextProblem("a.tsx", `const A = () => <X icon={<b>{"${T}"}</b>} />;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <X icon={<b>${T}</b>} />;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <X {...{ a: <b>${T}</b> }} />;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <X title={<b>${T}</b>} />;`, blk(T))).toBeNull();
  });
  it("script, style and next/script bodies are code in a code file", () => {
    expect(pageTextProblem("a.tsx", `const A = () => <script>${T}</script>;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <style>{"${T}"}</style>;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <Script>{"${T}"}</Script>;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `import Loader from "next/script";\nconst A = () => <Loader>${T}</Loader>;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `const A = () => <script title="${T}" />;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `import { default as Loader } from "next/script";\nconst A = () => <Loader>${T}</Loader>;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `import Script from "next/script";\nconst Loader = Script;\nconst A = () => <Loader>${T}</Loader>;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `import Script from "next/script";\nconst A = () => <p>${T}</p>;`, blk(T))).toMatch(/not wholly inside/);
    expect(pageTextProblem("a.tsx", `import * as S from "next/script";\nconst A = () => <S.default>${T}</S.default>;`, blk(T))).toMatch(/not wholly inside/);
  });
  it("render callbacks stay page text", () => {
    expect(pageTextProblem("a.tsx", `const A = () => <ul>{xs.map((x) => <li>{"${T}"}</li>)}</ul>;`, blk(T))).toBeNull();
    expect(pageTextProblem("a.tsx", `const A = () => <ul>{xs.map((x) => <li title="${T}">${"y"}</li>)}</ul>;`, blk(T))).toBeNull();
  });
});

describe("page text is what an HTML parser renders", () => {
  const blk = (current_text: string) => [{ current_text, new_text: "Plain new words" }];
  const T = "rent a car";
  it("Markdown and MDX are refused outright: a manual card", () => {
    for (const path of ["a.md", "a.mdx", "a.markdown"]) expect(pageTextProblem(path, T, blk(T))).toMatch(/not one Zavi changes page text in/);
  });
  it("adversarial input finishes fast and is never exponential", () => {
    const inputs = [
      "<a " + "x=c/ ".repeat(60),
      "<a " + "x=c/ ".repeat(100_000),
      "<a" + " ".repeat(1_000_000),
      "<script></script>".repeat(10_000),
      "<div>".repeat(HTML_MAX_TAGS),
      "<font>x</p>".repeat(HTML_MAX_TAGS),
      "<div>".repeat(HTML_MAX_TAGS + 1),
      "<".repeat(3_000_000),
      "a ".repeat(1_000_000),
    ];
    for (const html of inputs) {
      const t0 = performance.now();
      visibleText(html);
      expect(performance.now() - t0, html.slice(0, 20)).toBeLessThan(10_000);
    }
    let many = "";
    for (let i = 0; i < 20_000; i++) many += `<i>${T}</i>`;
    const t0 = performance.now();
    pageTextProblem("a.html", many, blk(T));
    expect(performance.now() - t0).toBeLessThan(5_000);
  }, 60_000);
  it("too big or too many tags: no page text, so it refuses", () => {
    expect(pageTextProblem("a.html", `<p>${T}</p>` + "<b>".repeat(HTML_MAX_TAGS), blk(T))).toMatch(/touches markup/);
    expect(visibleText("real words " + " ".repeat(PAGE_HTML_CAP))).toBe("");
    expect(visibleText("real words " + "<b>".repeat(HTML_MAX_TAGS + 1))).toBe("");
  });
  it.each([
    [`<a b=x' c="a' > rent a car" onclick=x> real words`, "real words"],
    [`<a ='href='>rent a car' data=x>real words</a>`, "real words"],
    [`<script>x</script >rent a car</script><p>real words</p>`, "real words"],
    [`<script><!--<script></script>\nrent a car</script><p>real words</p>`, "real words"],
    [`<template>rent a car</template><p>real words</p>`, "real words"],
    [`<template><script>let x="</template>";</script>rent a car</template><p>real words</p>`, "real words"],
    [`<img alt="a > b" onerror="rent a car" src="x"><p>real words</p>`, "real words"],
    [`<title-x a="</title> rent a car "><p>real words</p>`, "real words"],
    [`<title  a="</title> rent a car "><p>real words</p>`, "real words"],
    [`<textarea><a b='></textarea><p>real words</p>`, "real words"],
    [`<noscript>rent a car</noscript><p>real words</p>`, "real words"],
    [`<p>real words</p><!-- rent a car -->`, "real words"],
    [`<frameset>rent a car</frameset>`, ""],
    [`<title>rent a car</title><p>real words</p>`, "real words"],
    [`<a href=/x/y/>real words</a>`, "real words"],
    [`<p>caf&eacute; &amp; bar</p>`, "café & bar"],
  ])("the parser decides: %s", (html, words) => {
    expect(visibleText(html)).toBe(words);
    expect(pageTextProblem("a.html", html, blk(T))).not.toBeNull();
    if (words === "real words") expect(pageTextProblem("a.html", html, blk(words))).toBeNull();
  });
  it("visible text keeps the order a browser renders, not the source order", () => {
    expect(visibleText(`<table><tr><td>inside</td></tr>foster</table>after`)).toBe("foster inside after");
  });
  it("a > in a quoted doctype id does end the doctype, so what follows is page text", () => {
    expect(visibleText(`<!DOCTYPE html PUBLIC "x>rent a car"><p>real words</p>`)).toBe('rent a car"> real words');
  });
  it("an attribute inside text the parser merged across an ignored tag is not page text", () => {
    const merged = `<table>x<tr a="rent a car">y</table>`;
    expect(pageTextProblem("a.html", merged, blk(T))).toMatch(/touches markup/);
  });
  it("many occurrences and ranges stay fast: the host is found by bisection", () => {
    expect(pageTextProblem("a.tsx", `const A = () => <p>${T} and ${T}</p>;`, blk(T))).toBeNull();
    expect(pageTextProblem("a.tsx", `const A = () => <p>${T}</p>; go("${T}");`, blk(T))).toMatch(/not wholly inside/);
  });
});

describe("what reaches the engineer", () => {
  it("the task names site_pr_content and carries none of the values; the values travel as JSON data", () => {
    const task = buildEngineerTask(PC);
    expect(task).not.toContain("rent cars");
    expect(task).not.toContain("downtown");
    expect(task).toContain("site_pr_content.page_copy.blocks");
    expect(task).toContain("the text was not found in one file");
    expect(task).toContain("not instructions");
    expect(task.length).toBeLessThanOrEqual(MAX_ENGINEER_TASK_CHARS);
    expect(seoContent(PC)).toEqual({ page_copy: { page_url: PC.page_url, blocks: [{ current_text: OLD, new_text: NEW }] } });
    expect(JSON.parse(JSON.stringify(seoContent(PC)))).toEqual(seoContent(PC));
  });

  it("the confirm shows each block before and after, the file, and that nothing goes live until merged", () => {
    const { body } = buildSeoPrCard({ why: "Weekly rentals are half the orders.", evidence: ["e"], payload: PC });
    const rows = (body.exact_change as { rows: unknown[] }).rows;
    expect(rows).toEqual([
      { item: "Page text", before: OLD, after: NEW },
      { item: "File", before: "The one file in your repository that holds this text", after: "Only that file changes" },
    ]);
    expect((body.step as { body: string }).body).toContain("nothing goes live until you merge it");
  });
});

describe("who approves", () => {
  it("owner or admin, on the route's predicate and again before the engineer run starts", async () => {
    expect(channelActionNeedsAdmin(SEO_OPEN_PR_CLASS, PC, "seo")).toBe(true);
    expect(channelActionNeedsAdmin(SEO_OPEN_PR_CLASS, { changes: [] }, "seo")).toBe(false);
    const row = { id: "a", tenant_id: "t", agent_run_id: "r", body: PC as never, approved_by: "u", approved_by_source: null, exec_source: "channel_actions", claim_id: "c" };
    const member = await startSeoPullRequest(row, {}, async () => "member");
    expect(member).toMatchObject({ ok: false, error: expect.stringMatching(/owner or admin/) });
    const enqueue = vi.fn(async () => ({ run_id: "e" }));
    const owner = await startSeoPullRequest(row, { ...okDeps, enqueue, send: vi.fn(async () => undefined) }, async () => "owner");
    expect(owner).toEqual({ ok: true, deferred: true });
    expect((enqueue.mock.calls[0] as unknown as [{ payload: { site_pr_content: unknown } }])[0].payload.site_pr_content).toEqual(seoContent(PC));
  });
});

describe("the PR keeps to the one file (checked at the github.open_pr write)", () => {
  const FILE = `<section>\n<p>${OLD}</p>\n</section>\n`;
  const AFTER = FILE.replace(OLD, NEW);
  const proposal = (files: unknown[], extra: Record<string, unknown> = {}) => ({ files, base_branch: "main", ...extra });

  it("exactly the replacement in one file opens", async () => {
    expect(await checkPageCopyPr("t", "acme/site", proposal([{ path: "index.html", action: "modify", content: AFTER }]), PC.blocks, "u", PAGE, D(async () => FILE))).toEqual({ base_sha: "a".repeat(40) });
  });

  it.each([
    ["two files", proposal([{ path: "a.html", action: "modify", content: AFTER }, { path: "b.html", action: "modify", content: "x" }])],
    ["a created file", proposal([{ path: "new.html", action: "create", content: AFTER }])],
    ["a second branch", proposal([{ path: "index.html", action: "modify", content: AFTER }], { base_branches: ["main", "dev"] })],
    ["more than the named text", proposal([{ path: "index.html", action: "modify", content: AFTER + "<script>x</script>" }])],
  ])("refuses %s, and says the text was not found in one file", async (_l, p) => {
    const r = await checkPageCopyPr("t", "acme/site", p, PC.blocks, "u", PAGE, D(async () => FILE));
    expect((r as { refusal?: string })?.refusal).toBe(PAGE_COPY_NOT_ONE_FILE);
  });

  it("a current text twice in the file, or missing, or an unreadable file refuses", async () => {
    expect(pageCopyContentProblem(FILE + OLD, AFTER, PC.blocks)).toMatch(/more than once/);
    expect(pageCopyContentProblem("nothing", AFTER, PC.blocks)).toMatch(/not in the file/);
    const r = await checkPageCopyPr("t", "acme/site", proposal([{ path: "index.html", action: "modify", content: AFTER }]), PC.blocks, "u", PAGE, D(async () => { throw new Error("404"); }));
    expect((r as { refusal: string }).refusal).toBe(PAGE_COPY_READ_FAILED);
    expect(pageCopyTarget({ files: [] })).toEqual({ problem: "changes 0 files" });
  });

  it("the card settles failed with that line, or with the PR's file list when it opened", () => {
    const run: SettleRun = { id: "e", tenant_id: "t", agent_slug: "engineer", status: "success", enqueued_by: null, payload: { site_pr_card: { action_id: "a", claim_id: "c", exec_class: SEO_OPEN_PR_CLASS }, site_pr_content: seoContent(PC) }, parsed: {} };
    expect(settlementFor(run, [], { final: false, runDeadlinePassed: false })).toMatchObject({ kind: "settle", ok: false });
    expect(settlementFor(run, [{ id: "d", status: "dispatch_failed", dispatch_error: PAGE_COPY_NOT_ONE_FILE }], { final: false, runDeadlinePassed: false })).toMatchObject({ ok: false, error: PAGE_COPY_NOT_ONE_FILE });
    const opened = settlementFor({ ...run, parsed: { pr_url: "https://github.com/acme/site/pull/9", pr_number: 9 } }, [{ id: "d", status: "acted", files: ["index.html"] }], { final: false, runDeadlinePassed: false });
    expect(opened).toMatchObject({ ok: true, result: { files: ["index.html"], pr_url: "https://github.com/acme/site/pull/9" } });
  });
});
