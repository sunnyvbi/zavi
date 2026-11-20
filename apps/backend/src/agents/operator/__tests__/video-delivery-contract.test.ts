import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const operatorMd = readFileSync(join(__dirname, "../agent.md"), "utf8");
const remindersSrc = readFileSync(
  join(__dirname, "../../../services/agents/reminders.ts"),
  "utf8",
);
const praxisTool = readFileSync(
  join(__dirname, "../../../services/mcp/internal/praxis.ts"),
  "utf8",
);

describe("BUG 11 — operator no longer claims video is Slack-only", () => {
  it("drops the false Slack-only claim and its escape hatch", () => {
    expect(operatorMd).not.toMatch(/Generative delivery is Slack-only/i);
    expect(operatorMd).not.toMatch(/deliver the motion-graphics version \(B\) instead, which works everywhere/i);
  });

  it("states the real contract: the server picks the surface", () => {
    expect(operatorMd).toMatch(/A \(B\) video delivers wherever you are asked from/i);
    expect(operatorMd).toMatch(/delivery-target\.ts/);
  });

  it("says a generative video files a priced card and reports whether it started", () => {
    expect(operatorMd).toMatch(/files a priced card on AI UGC Videos; tell the founder what the result says \(video started, or the price and Make video\)/i);
    expect(operatorMd).not.toMatch(/Both video kinds deliver/i);
    expect(operatorMd).not.toMatch(/a real mp4 returns to this thread/i);
  });

  it("the render_launch_video alias says a generative ask files a card instead of posting into this thread", () => {
    expect(praxisTool).not.toContain("from a short intake and posts it back into THIS thread");
    expect(praxisTool).toMatch(/PERMANENT ALIAS of praxis__render_video[^"]*With `generative_intent` it files a priced card on AI UGC Videos; the result says whether the video started or waits for Make video/);
  });

  it("forbids asking the user which Slack channel to post to", () => {
    expect(operatorMd).toMatch(/NEVER ask the user which Slack channel/i);
  });

});

describe("BUG 16 — remind describes the surface it can actually reach", () => {
  it("no longer promises delivery back to THIS conversation on every surface", () => {
    expect(praxisTool).not.toContain(
      "The reminder is delivered back to THIS conversation automatically",
    );
  });

  it("names email as unsupported and says what to do instead", () => {
    expect(praxisTool).toMatch(/NOT available on an email turn/i);
    expect(praxisTool).toMatch(/remind_no_surface/);
    expect(praxisTool).toMatch(/Do NOT promise a reminder you cannot deliver/i);
  });

  it("records WHY the email rail is deferred, with a watch trigger", () => {
    expect(remindersSrc).toMatch(/EMAIL IS DELIBERATELY NOT A TARGET/);
    expect(remindersSrc).toMatch(/WATCH TRIGGER/);
    expect(remindersSrc).toMatch(/EIGHT `trigger='email'` runs/);
  });

  it("still refuses rather than staging an undeliverable reminder", () => {
    expect(remindersSrc).toMatch(/worse than refusing it/i);
  });
});
