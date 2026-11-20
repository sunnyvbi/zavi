// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  BUILD_STEP_PHRASE,
  READ_ONLY_TOOLS,
  buildRunPanel,
  describeTool,
  isReadOnlyTool,
  type RunActivityRow,
  type RunPanel as RunPanelModel,
} from "@zavi/shared";
import type { ChatRow } from "@/lib/workspace/useChatThread";
import { RunPanel } from "./RunPanel";

let seq = 0;
function chatRow(teKind: string, body: Record<string, unknown>): ChatRow {
  seq += 1;
  return {
    id: String(seq),
    kind: "chat_activity",
    agent_run_id: "run-1",
    body: { teKind, ...body },
    citations: [],
    created_at: "2026-10-05T05:30:00Z",
  };
}

const callOpen = (name: string, callId: string, target = "{}") =>
  chatRow("tool_call", { tool_name: name, call_id: callId, target, ms: 0, code: "ok", output_preview: "" });
const callDone = (name: string, callId: string, output: string) =>
  chatRow("tool_call", { tool_name: name, call_id: callId, target: "", ms: 0, code: "ok", output_preview: output });
const say = (text: string) => chatRow("reasoning", { text });

const LIST_BUILDS = "mcp__server__praxis__list_product_builds";
const LIST_BUILDS_RESULT =
  '{"product_builds":1,"refines":0,"currently_live":false,"live_reason":"None of the 1 apps in this workspace is live right now; each app\'s own verdict is in `apps`.","live_url":null,"apps":[{"kind":"site"}]}';

function qaReply(name = LIST_BUILDS): ChatRow[] {
  return [
    say("Let me check what you have built so far."),
    callOpen(name, "c1"),
    callDone(name, "c1", LIST_BUILDS_RESULT),
    say("You have one site and it is not live yet."),
  ];
}

function mount(rows: ChatRow[], state: RunPanelModel["state"] = "finished") {
  return render(<RunPanel rows={rows} agentSlug="operator" state={state} />).container;
}

afterEach(cleanup);

describe("l2.14: a plain answer carries no build-step footer", () => {
  it("draws nothing under the QA reply that only looked up the builds", () => {
    const c = mount(qaReply());
    expect(c.innerHTML).toBe("");
    expect(c.textContent).not.toMatch(/build step/i);
    expect(c.textContent).not.toContain("Product builds");
  });

  it("hides the bare server form the dispatcher also writes", () => {
    expect(mount(qaReply("praxis__list_product_builds")).innerHTML).toBe("");
  });

  it("still shows the live line while the same lookup is running, in plain words", () => {
    const rows = [say("Let me check what you have built so far."), callOpen(LIST_BUILDS, "c1")];
    const c = mount(rows, "running");
    expect(c.textContent).toContain("Looked up your builds");
    expect(c.textContent).not.toMatch(/build step/i);
  });

  it("keeps the receipt when a read and a write share one label", () => {
    const rows = [
      callOpen("mcp__server__meta_ads__list_campaigns", "a1"),
      callDone("mcp__server__meta_ads__list_campaigns", "a1", '{"campaigns":3}'),
      callOpen("mcp__server__meta_ads__propose_budget_change", "a2", '{"daily_budget":50}'),
      callDone("mcp__server__meta_ads__propose_budget_change", "a2", '{"proposed":true}'),
    ];
    const panel = buildRunPanel(
      rows.map((r) => ({ id: r.id, kind: "tool_call", body: r.body as Record<string, unknown> })),
      { state: "finished" },
    );
    const g = panel.items.filter((i) => i.type === "group");
    expect(g).toHaveLength(1);
    expect(panel.readOnly).toBe(false);
    expect(mount(rows).textContent).toContain("Done · checked your ads");
  });

  it("keeps the receipt when a write was cut off mid-call", () => {
    const rows = [
      callOpen(LIST_BUILDS, "c1"),
      callDone(LIST_BUILDS, "c1", LIST_BUILDS_RESULT),
      callOpen("mcp__server__slack__post_message", "c2", '{"channel":"#general"}'),
    ];
    const c = mount(rows);
    expect(c.textContent).toContain("Checked your team chat");
  });

  it("hides two parallel lookups that settle out of order", () => {
    const rows = [
      callOpen(LIST_BUILDS, "p1"),
      callOpen("mcp__server__operator_db__query", "p2", '{"collection":"trips"}'),
      callDone("mcp__server__operator_db__query", "p2", '{"rows":[]}'),
      callDone(LIST_BUILDS, "p1", LIST_BUILDS_RESULT),
    ];
    expect(mount(rows).innerHTML).toBe("");
  });

  it("does not hide a stopped or failed run, even when it only looked", () => {
    expect(mount(qaReply(), "stopped").textContent).toContain("Stopped");
    expect(mount(qaReply(), "failed").textContent).toContain("Stopped: something went wrong");
  });

  it("reads a file read as looking and a file edit as a change", () => {
    expect(mount([chatRow("file_read", { path: "src/app.tsx" })]).innerHTML).toBe("");
    const edited = mount([chatRow("file_read", { path: "src/app.tsx" }), chatRow("file_edit", { path: "src/app.tsx" })]);
    expect(edited.textContent).toContain("edited code");
  });

  it("shows a panel folded by an older backend that never set readOnly", () => {
    const old = buildRunPanel(
      [
        { id: "1", kind: "tool_call", body: { tool_name: LIST_BUILDS, call_id: "c1", target: "{}", ms: 0, code: "ok", output_preview: "" } },
        { id: "2", kind: "tool_call", body: { tool_name: LIST_BUILDS, call_id: "c1", target: "", ms: 0, code: "ok", output_preview: "{}" } },
      ],
      { state: "finished" },
    );
    expect(old.readOnly).toBe(true);
    const { readOnly: _drop, ...legacy } = old;
    const c = render(<RunPanel model={legacy as RunPanelModel} agentSlug="operator" />).container;
    expect(c.textContent).toContain("Done · looked up your builds");
  });

  it("keeps the receipt for a finished run whose only call was a paid browse", () => {
    const BROWSE = "mcp__server__browser__task";
    const rows = [
      say("Let me open their pricing page."),
      callOpen(BROWSE, "b1", '{"goal":"What plans are on the pricing page?","start_url":"https://acme.com/pricing"}'),
      callDone(BROWSE, "b1", '{"status":"done","page_content":"Starter $20, Growth $120"}'),
      say("They have two plans."),
    ];
    const c = mount(rows);
    expect(c.innerHTML).not.toBe("");
    expect(c.textContent).toContain("Read a web page");
    const panel = buildRunPanel(
      rows.filter((r) => (r.body as Record<string, unknown>).teKind === "tool_call").map((r) => ({ id: r.id, kind: "tool_call", body: r.body as Record<string, unknown> })),
      { state: "finished" },
    );
    expect(panel.readOnly).toBe(false);
  });

  it("keeps the receipt for every paid read, alone or beside a free lookup", () => {
    for (const name of [
      "mcp__server__browser__task",
      "browser__task",
      "mcp__server__apify__rag_web_browser",
      "mcp__server__apify__scrape_instagram",
      "mcp__server__apify__scrape_meta_ads",
      "mcp__server__apify__scrape_pinterest",
      "mcp__server__apify__scrape_reddit",
      "mcp__server__apify__scrape_tiktok",
      "mcp__server__web_search__search",
      "mcp__server__web_fetch__fetch",
      "mcp__server__competitor_intel__http_fetch",
      "mcp__server__memory__search",
      "mcp__server__operator_db__codeact",
      "mcp__server__code_index__code_def",
      "mcp__server__investor_discovery__search",
      "mcp__server__reddit__thread_read",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(false);
      expect(mount([callOpen(name, "x"), callDone(name, "x", "{}")]).innerHTML, name).not.toBe("");
      const mixed = [
        callOpen(LIST_BUILDS, "p1"),
        callOpen(name, "p2"),
        callDone(name, "p2", "{}"),
        callDone(LIST_BUILDS, "p1", LIST_BUILDS_RESULT),
      ];
      expect(mount(mixed).innerHTML, name).not.toBe("");
    }
  });

  it("does not trust a lookalike name or a customer server that reuses ours", () => {
    for (const name of [
      "mcp__server__praxis__list_product_builds_and_deploy",
      "mcp__server__acme__list_product_builds",
      "list_product_builds",
      "mcp__server__praxis__run_site_check",
      "mcp__sandbox__run_bash",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(false);
      expect(mount([callOpen(name, "x"), callDone(name, "x", "ok")]).innerHTML, name).not.toBe("");
    }
  });
});

const callFailed = (name: string, callId: string, message: string) =>
  chatRow("tool_call", { tool_name: name, call_id: callId, target: "", ms: 0, code: "err", output_preview: "", error_message: message });

const foldRows = (rows: ChatRow[], state: RunPanelModel["state"] = "finished") =>
  buildRunPanel(
    rows.filter((r) => (r.body as Record<string, unknown>).teKind === "tool_call").map((r) => ({ id: r.id, kind: "tool_call", body: r.body as Record<string, unknown> })),
    { state },
  );

const failedMarks = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("span")).filter((s) => s.textContent === "failed" && s.className.includes("text-[#c0392b]"));
const redCrosses = (c: HTMLElement) => c.querySelectorAll('svg.text-\\[\\#c0392b\\] path[d="M6 6l12 12M18 6L6 18"]');

describe("l2.14: a read-only run that failed keeps its panel", () => {
  const QUERY = "mcp__server__operator_db__query";

  it("keeps the panel and the failed line when the only lookup failed", () => {
    const rows = [
      say("Let me check what you have built so far."),
      callOpen(LIST_BUILDS, "c1"),
      callFailed(LIST_BUILDS, "c1", "permission denied for table product_builds"),
      say("I could not read your builds."),
    ];
    expect(isReadOnlyTool(LIST_BUILDS)).toBe(true);
    const panel = foldRows(rows);
    expect(panel.readOnly).toBe(false);
    const c = mount(rows);
    expect(c.innerHTML).not.toBe("");
    expect(c.textContent).toContain("Looked up your builds");
    expect(failedMarks(c)).toHaveLength(1);
    expect(redCrosses(c).length).toBeGreaterThanOrEqual(1);
    expect(c.textContent).toContain("permission denied for table product_builds");
  });

  it("keeps the panel when one of two parallel lookups fails and they settle out of order", () => {
    const rows = [
      callOpen(LIST_BUILDS, "p1"),
      callOpen(QUERY, "p2", '{"collection":"trips"}'),
      callFailed(QUERY, "p2", "relation trips does not exist"),
      callDone(LIST_BUILDS, "p1", LIST_BUILDS_RESULT),
    ];
    expect(isReadOnlyTool(QUERY)).toBe(true);
    const c = mount(rows);
    expect(c.innerHTML).not.toBe("");
    expect(failedMarks(c)).toHaveLength(1);
    expect(c.textContent).toContain("relation trips does not exist");
  });

  it("keeps the panel when a lookup was still open as the run finished", () => {
    const rows = [callOpen(LIST_BUILDS, "c1"), callOpen(QUERY, "c2", '{"collection":"trips"}'), callDone(QUERY, "c2", '{"rows":[]}')];
    const panel = foldRows(rows);
    expect(panel.readOnly).toBe(false);
    const c = mount(rows);
    expect(c.innerHTML).not.toBe("");
    expect(failedMarks(c)).toHaveLength(1);
  });

  it("keeps the panel for a backend-folded model of the same failed lookup", () => {
    const rows = [callOpen(LIST_BUILDS, "c1"), callFailed(LIST_BUILDS, "c1", "timeout")];
    const c = render(<RunPanel model={foldRows(rows)} agentSlug="operator" />).container;
    expect(c.innerHTML).not.toBe("");
    expect(failedMarks(c)).toHaveLength(1);
  });

  it("still hides the same lookups once every one succeeded", () => {
    const rows = [
      callOpen(LIST_BUILDS, "p1"),
      callOpen(QUERY, "p2", '{"collection":"trips"}'),
      callDone(QUERY, "p2", '{"rows":[]}'),
      callDone(LIST_BUILDS, "p1", LIST_BUILDS_RESULT),
    ];
    expect(foldRows(rows).readOnly).toBe(true);
    expect(mount(rows).innerHTML).toBe("");
  });
});

describe("l2.14: read-only tools get their own words", () => {
  it("never calls a read-only tool a build step", () => {
    const offenders: string[] = [];
    for (const [server, tools] of READ_ONLY_TOOLS) {
      for (const tool of tools) {
        for (const name of [`${server}__${tool}`, `mcp__server__${server}__${tool}`, `mcp__${server}__${tool}`]) {
          if (!isReadOnlyTool(name)) offenders.push(`not read-only: ${name}`);
          if (describeTool(name) === BUILD_STEP_PHRASE) offenders.push(`build step: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names the tools QA and the registry found under the catch-all", () => {
    expect(describeTool(LIST_BUILDS)).toBe("Looked up your builds");
    expect(describeTool("mcp__server__praxis_corpus__read_run_output")).toBe("Looked through earlier work");
    expect(describeTool("mcp__server__praxis__run_site_check")).toBe("Checked your site");
    expect(describeTool("mcp__server__google_analytics__run_report")).toBe("Checked your analytics");
    expect(describeTool("mcp__sandbox__view")).toBe("Read your project");
    expect(describeTool("mcp__sandbox__run_bash")).toBe(BUILD_STEP_PHRASE);
    expect(describeTool("mcp__sandbox__write_file")).toBe(BUILD_STEP_PHRASE);
  });

  it("gives the receipt the same words the label uses", () => {
    const rows: RunActivityRow[] = [
      { id: "1", kind: "tool_call", body: { tool_name: LIST_BUILDS, call_id: "c1", target: "{}", ms: 0, code: "ok", output_preview: "" } },
      { id: "2", kind: "tool_call", body: { tool_name: LIST_BUILDS, call_id: "c1", target: "", ms: 0, code: "ok", output_preview: "{}" } },
      { id: "3", kind: "file_edit", body: { path: "src/app.tsx" } },
    ];
    const panel = buildRunPanel(rows, { state: "finished" });
    expect(panel.readOnly).toBe(false);
    expect(panel.summary).toBe("Done · looked up your builds, edited code");
  });
});
