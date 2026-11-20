import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const runner = read("src/services/agents/runner.ts");

describe("persistTerminal — ask_agent wiring", () => {
  it("pauses a successful parent only when it called the tool AND has an open ask", () => {
    expect(runner).toMatch(/const askedAgent = calledAskAgent\(result\?\.tool_calls\);/);
    expect(runner).toMatch(
      /update\.status === "success" && !pausedForApproval && runTenantId && askedAgent[\s\S]{0,200}shouldPauseForChild\(serviceClient\(\), run_id, runTenantId\)[\s\S]{0,120}update\.status = PAUSED_AWAITING_CHILD;/,
    );
  });

  it("the child pause reuses every paused-run gate (no run_end / promote / distill / completed event)", () => {
    expect(runner).toMatch(/update\.status = PAUSED_AWAITING_CHILD;\s*pausedForApproval = true;\s*pausedForChild = true;/);
  });

  it("the pause relabel happens BEFORE the CAS terminal write", () => {
    const pause = runner.indexOf("update.status = PAUSED_AWAITING_CHILD;");
    const cas = runner.indexOf('.eq("status", "running")\n    .select("id, payload');
    expect(pause).toBeGreaterThan(0);
    expect(cas).toBeGreaterThan(pause);
  });

  it("a CAS-lost replay of a child-paused run is not surfaced as a failure", () => {
    expect(runner).toMatch(
      /row\?\.status === PAUSED_AWAITING_APPROVAL \|\| row\?\.status === PAUSED_AWAITING_CHILD\) \{\s*return;/,
    );
  });

  it("an ask child never posts its own reply (web chat or surface)", () => {
    expect(runner).toMatch(/const askChild = isAskChildPayload\(runRow\.payload\);/);
    expect(runner).toMatch(/!pausedForApproval && !askChild && trigger === "handoff"/);
    expect(runner).toMatch(/!pausedForApproval &&\s*!askChild &&\s*\(trigger === "slack" \|\|/);
  });

  it("the child emits agent.child.completed (ids only) and the parent settles after its terminal write", () => {
    expect(runner).toMatch(/if \(askChild\) \{[\s\S]{0,120}name: "agent\.child\.completed",\s*data: \{ child_run_id: run_id \},/);
    expect(runner).toMatch(/if \(askedAgent\) \{[\s\S]{0,80}await onParentSettled\(run_id, tenant_id,/);
  });

  it("the chat-surface approval notice is not sent for a child pause", () => {
    expect(runner).toMatch(/pausedForApproval &&\s*!pausedForChild &&\s*\(trigger === "telegram"/);
  });

  it("does not widen agent.run.completed (messaging-only)", () => {
    const i = runner.indexOf('name: "agent.run.completed"');
    const block = runner.slice(i - 1200, i);
    expect(block).not.toMatch(/askChild \|\|/);
  });
});

describe("paused parents are inert to the reapers and hold no slot", () => {
  it("every reaper / stuck scan / claim path only selects queued or running rows", () => {
    for (const f of [
      "src/services/agents/boot-reap.ts",
      "workers/functions/stuck-run-query.ts",
      "workers/functions/queued-stuck-scan.ts",
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/paused_awaiting_child/);
      const statuses = [...src.matchAll(/\.eq\("status", "([a-z_]+)"\)/g)].map((m) => m[1]);
      for (const s of statuses) expect(["queued", "running"], `${f}: ${s}`).toContain(s);
    }
  });
});

describe("readers of the new status", () => {
  it("chat-dispatcher accepts an ask continuation only against this tenant's claimed ask", () => {
    const cd = read("src/services/agents/chat-dispatcher.ts");
    expect(cd).toMatch(/originRun\.status !== "paused_awaiting_child"/);
    expect(cd).toMatch(
      /\.from\("agent_asks"\)[\s\S]{0,120}\.eq\("id", p\.ask_id as string\)\s*\.eq\("tenant_id", ctx\.tenant_id\)\s*\.eq\("parent_run_id", p\.resume_of_run_id as string\)/,
    );
  });

  it("the proposal sweep and connector-continue treat it as alive", () => {
    expect(read("workers/functions/memory-write-maintenance.ts")).toMatch(/"paused_awaiting_child"/);
    expect(read("src/routes/chat/connector-request-continue.ts")).toMatch(/"paused_awaiting_child"/);
  });
});
