import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildRunPanel } from "@zavi/shared";
import { RunNarrative } from "./RunNarrative";

function activityRow(id: string, body: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id, kind: "chat_activity", agent_run_id: "run-1", body, citations: [], created_at: "2026-10-16T00:00:00Z" } as any;
}
const say = (id: string, text: string) => activityRow(id, { teKind: "reasoning", text });
const call = (id: string, name: string, out = "") =>
  activityRow(id, { teKind: "tool_call", tool_name: name, target: out ? "" : "{}", ms: 0, code: "ok", output_preview: out });
const DB = "mcp__server__operator_db__query";
const ADS = "mcp__server__google_ads__report";

const CHECKING =
  "Checking now. Google's side shows booking uploads are being counted, so I'm looking at the 35 bookings that failed upload in your database to see what Google said about them.";
const ANSWER = `No, not anymore. ${"Every booking upload failed on Oct 13, but Google has accepted every upload since. ".repeat(6)}`;

describe("AT1 — Ravi's screenshot: the opening sentence is reply text, in full", () => {
  const html = renderToStaticMarkup(
    <RunNarrative rows={[say("r1", CHECKING), call("t1", ADS)]} agentSlug="cgo" state="running" />,
  );
  it("renders the whole sentence in the answer's font, not in a cut-off line", () => {
    expect(html).toContain(`font-reading text-[16px] leading-[1.7] text-ink">${CHECKING.replace(/'/g, "&#x27;")}`);
  });
  it("puts the running step under it as a shimmer line", () => {
    expect(html).toMatch(/zavi-shimmer[^>]*>[^<]*…</);
  });
});

describe("AT2 — a finished read-only run keeps its sentence and step line", () => {
  const rows = [say("r1", CHECKING), call("t1", DB), call("t2", DB, "35 rows"), say("r2", ANSWER)];
  const html = renderToStaticMarkup(<RunNarrative rows={rows} agentSlug="cgo" state="finished" />);
  it("shows the sentence and the step line", () => {
    expect(html).toContain("Checking now. Google");
    expect(html).toContain("Checked your database");
  });
  it("the step line has no 'Done' and is folded", () => {
    expect(html).not.toContain("Done");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
  it("the final answer is never drawn as narration", () => {
    expect(html).not.toContain("No, not anymore");
  });
});

describe("must-not: answers and empty runs are not narration", () => {
  it("a short final-answer row after finished tools is not shown", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r1", "Looking."), call("t1", DB), call("t2", DB, "ok"), say("r2", "It is 42.")]} agentSlug="pm" state="finished" />,
    );
    expect(html).toContain("Looking.");
    expect(html).not.toContain("It is 42.");
  });
  it("a pure envelope turn is not shown", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r1", '<fundraising>{"x":1}</fundraising>'), call("t1", DB)]} agentSlug="pm" state="finished" />,
    );
    expect(html).not.toContain("fundraising");
  });
  it("an answer-only settled run (start-up phases + answer) renders nothing", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r0", "Starting up"), say("r1", ANSWER)]} agentSlug="pm" state="finished" />,
    );
    expect(html).toBe("");
  });
});

describe("stopped and failed runs say so", () => {
  it("a stopped run with no sentences still shows 'Stopped'", () => {
    expect(renderToStaticMarkup(<RunNarrative rows={[]} agentSlug="pm" state="stopped" />)).toContain("Stopped");
  });
  it("a failed run marks it, after its sentences", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r1", "Looking."), call("t1", DB)]} agentSlug="pm" state="failed" />,
    );
    expect(html.indexOf("Looking.")).toBeLessThan(html.indexOf("Stopped: something went wrong"));
  });
});

describe("a handoff specialist's folded panel draws the same way", () => {
  it("uses the model's full sentence", () => {
    const model = buildRunPanel(
      [
        { id: "a", kind: "reasoning", body: { text: CHECKING + " ".repeat(1) + "x".repeat(200) } },
        { id: "b", kind: "tool_call", body: { tool_name: DB, target: "{}", ms: 0, code: "ok", output_preview: "" } },
        { id: "c", kind: "tool_call", body: { tool_name: DB, target: "", ms: 0, code: "ok", output_preview: "ok" } },
      ],
      { state: "finished" },
    );
    const html = renderToStaticMarkup(<RunNarrative model={model} agentSlug="pm" />);
    expect(html).toContain("x".repeat(200));
  });
});

describe("between steps, the live run says it is reading the results", () => {
  it("shows one live line with the tool count once every step has returned", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r1", "Looking."), call("t1", DB), call("t2", DB, "ok")]} agentSlug="pm" state="running" />,
    );
    expect(html).toContain("Reading the results…");
    expect(html).toContain("· 1 tool");
  });
  it("a sentence with no steps yet, finished typing, shows 'Thinking…'", () => {
    const html = renderToStaticMarkup(<RunNarrative rows={[say("r1", "Looking.")]} agentSlug="pm" state="running" />);
    expect(html).toContain("Thinking…");
  });
});

describe("option A (2026-10-23): one live line with a clock, a folded line when done", () => {
  const rows = [say("r1", "Looking."), call("t1", DB), call("t2", DB, "ok"), call("t3", ADS)];
  it("live: the running step, the elapsed time, and how many tools so far", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={rows} agentSlug="pm" state="running" askClaimed startedAt={new Date(Date.now() - 18_000).toISOString()} />,
    );
    expect(html).toMatch(/zavi-shimmer[^>]*>[^<]*…</);
    expect(html).toMatch(/· 1[89]s/);
    expect(html).not.toContain("×");
  });
  it("no clock until a worker has claimed the run", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[]} agentSlug="pm" state="running" startedAt={new Date(Date.now() - 18_000).toISOString()} />,
    );
    expect(html).not.toMatch(/· \d+s/);
  });
  it("a step that failed mid-run is marked only on its row, not on the live line", () => {
    const failed = activityRow("t1", { teKind: "tool_call", tool_name: DB, target: "", ms: 0, code: "err", output_preview: "boom" });
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r1", "Looking."), call("t0", ADS), failed]} agentSlug="pm" state="running" askClaimed />,
    );
    expect(html.indexOf("text-[#c0392b]")).toBeGreaterThan(html.indexOf("zavi-shimmer"));
  });
  it("a settled run whose answer landed shows no red mark on its folded line", () => {
    const failed = activityRow("t1", { teKind: "tool_call", tool_name: DB, target: "", ms: 0, code: "err", output_preview: "boom" });
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r1", "Looking."), call("t0", ADS), failed, say("r2", "Done.")]} agentSlug="pm" state="finished" />,
    );
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
    expect(summary).toContain("Used 2 tools");
    expect(summary).not.toContain("text-[#c0392b]");
  });
  it("a queued run shows no clock", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[]} agentSlug="pm" state="running" queueAhead={1} startedAt={new Date(Date.now() - 18_000).toISOString()} />,
    );
    expect(html).not.toMatch(/· \d+s/);
  });
  it("settled: 'Used N tools · time', folded", () => {
    const at = (id: string, r: ReturnType<typeof say>, t: string) => ({ ...r, id, created_at: t });
    const settled = [
      at("r1", say("r1", "Looking."), "2026-10-23T12:00:00Z"),
      at("t1", call("t1", DB), "2026-10-23T12:00:02Z"),
      at("t2", call("t2", DB, "ok"), "2026-10-23T12:00:05Z"),
    ];
    const html = renderToStaticMarkup(
      <RunNarrative rows={settled} agentSlug="pm" state="finished" endedAt="2026-10-23T12:00:41Z" />,
    );
    expect(html).toContain("Used 1 tool · 41s");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
});

describe("the plan summary is quiet context, never the agent talking", () => {
  const plan = (id: string, summary: string) => activityRow(id, { teKind: "plan", summary });
  const SUMMARY = "Hand the $25 one-day ChatGPT ad request to the ChatGPT Ads channel, which owns campaign setup and approval.";

  it("renders a promoted plan summary small and grey, in full, not in the answer's font", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[plan("p1", SUMMARY), call("t1", DB, "x")]} agentSlug="operator" state="finished" />,
    );
    expect(html).toContain(`text-[13px] leading-[1.5] text-ink/55">${SUMMARY}</p>`);
    expect(html).not.toContain("font-reading");
  });

  it("keeps the model's own sentence as reply text", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[plan("p1", SUMMARY), say("r1", "Checking the ad account now."), call("t1", DB, "x")]} agentSlug="operator" state="finished" />,
    );
    expect(html).toContain('font-reading text-[16px] leading-[1.7] text-ink">Checking the ad account now.');
    expect(html).not.toContain(SUMMARY);
  });
});

describe("the end of a turn draws once", () => {
  it("does not fall back to 'Getting started…' while the answer is drafting", () => {
    const html = renderToStaticMarkup(<RunNarrative rows={[]} agentSlug="operator" state="running" drafting />);
    expect(html).not.toContain("Getting started");
  });
  it("still says 'Getting started…' before anything has happened", () => {
    const html = renderToStaticMarkup(<RunNarrative rows={[]} agentSlug="operator" state="running" />);
    expect(html).toContain("Getting started");
  });
  it("names what the message asked about once there is one", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[]} agentSlug="operator" state="running" askText="How did the Meta ads do?" askClaimed />,
    );
    expect(html).toContain("Looking at your Meta ads…");
    const unknown = renderToStaticMarkup(
      <RunNarrative rows={[]} agentSlug="operator" state="running" askText="How did the Meta ads do?" />,
    );
    expect(unknown).toContain("Getting started on your Meta ads…");
    const queued = renderToStaticMarkup(
      <RunNarrative rows={[]} agentSlug="operator" state="running" queueAhead={2} askText="How did the Meta ads do?" />,
    );
    expect(queued).toContain("Getting started on your Meta ads…");
  });
  it("a finished sentence the stream still holds keeps typing, with no 'Thinking…' under it", () => {
    const html = renderToStaticMarkup(
      <RunNarrative rows={[say("r1", "Email reaches past renters.")]} agentSlug="operator" state="running" liveThought="Email reaches past renters." />,
    );
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Thinking…");
  });
});
