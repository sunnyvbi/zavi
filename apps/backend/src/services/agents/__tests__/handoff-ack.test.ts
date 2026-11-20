import { describe, it, expect } from "vitest";
import {
  isOperatorHandoffAck,
  OPERATOR_HANDOFF_ACK_SENTINEL,
} from "../handoff-ack";

const okHandoff = {
  ms: 0,
  name: "mcp__server__praxis__handoff",
  status: "ok",
  tool_use_id: "toolu_x",
  input_preview: '{"input":{"target_agent_slug":"research","intent":"..."}}',
  output_preview:
    '[{"type":"text","text":"{\\"ok\\":true,\\"run_id\\":\\"df94d9d7-5e54-44bc-a1f2-5ddaa1a06298\\",\\"target\\":\\"research\\"}',
};
const toolSearch = { ms: 0, name: "ToolSearch", status: "ok" };
const ACK = "Handing off to the research specialist. I'll post the full competitive landscape back in this thread when done.";

describe("isOperatorHandoffAck", () => {
  it("true: operator short ack + confirmed-successful handoff (status ok + ok:true body)", () => {
    expect(isOperatorHandoffAck("operator", [toolSearch, okHandoff], ACK)).toBe(true);
  });

  it("true: handoff_parallel with a batch_id/run_ids body", () => {
    const parallel = {
      name: "mcp__server__praxis__handoff_parallel",
      status: "ok",
      output_preview: '[{"type":"text","text":"{\\"batch_id\\":\\"b1\\",\\"run_ids\\":[\\"r1\\"]}"}]',
    };
    expect(isOperatorHandoffAck("operator", [parallel], "Handing off to two specialists.")).toBe(true);
  });

  it("false: output_preview absent → NOT inferred as success (codex: unconfirmed trace)", () => {
    expect(
      isOperatorHandoffAck("operator", [{ name: "mcp__server__praxis__handoff", status: "ok" }], ACK),
    ).toBe(false);
  });

  it("false: substantive prose alongside a handoff is NOT just an ack — keep scoring it", () => {
    const longSubstantive = "Here is the full competitive landscape. ".repeat(40);
    expect(longSubstantive.length).toBeGreaterThan(800);
    expect(isOperatorHandoffAck("operator", [toolSearch, okHandoff], longSubstantive)).toBe(false);
  });

  it("false: handoff tool returned an ERROR (gate-rejected / hallucinated) — must still be scored", () => {
    const failed = { name: "mcp__server__praxis__handoff", status: "error", output_preview: "blocked" };
    expect(isOperatorHandoffAck("operator", [toolSearch, failed], ACK)).toBe(false);
  });

  it("false: status ok but body says ok:false (soft-reject) — must still be scored", () => {
    const softReject = {
      name: "mcp__server__praxis__handoff",
      status: "ok",
      output_preview: '[{"type":"text","text":"{\\"ok\\":false,\\"error\\":\\"delegation_blocked\\"}"}]',
    };
    expect(isOperatorHandoffAck("operator", [softReject], ACK)).toBe(false);
  });

  it("false: operator did substantive work, no handoff (q=100 path)", () => {
    expect(
      isOperatorHandoffAck("operator", [toolSearch, { name: "mcp__server__web_fetch__fetch", status: "ok" }], ACK),
    ).toBe(false);
  });

  it("false: a non-operator agent that happens to call handoff is not discounted", () => {
    expect(isOperatorHandoffAck("research", [okHandoff], ACK)).toBe(false);
    expect(isOperatorHandoffAck("chief-of-staff", [okHandoff], ACK)).toBe(false);
  });

  it("false: empty output_text is a real quality signal (scored q=1 elsewhere), not an ack", () => {
    expect(isOperatorHandoffAck("operator", [okHandoff], "")).toBe(false);
    expect(isOperatorHandoffAck("operator", [okHandoff], null)).toBe(false);
  });

  it("false / no-throw: defensive against null, count, empty, and malformed shapes", () => {
    expect(isOperatorHandoffAck("operator", null, ACK)).toBe(false);
    expect(isOperatorHandoffAck("operator", 2, ACK)).toBe(false);
    expect(isOperatorHandoffAck("operator", [], ACK)).toBe(false);
    expect(isOperatorHandoffAck("operator", [null, 7, "x", {}], ACK)).toBe(false);
  });

  it("sentinel is distinct from the never-executed / research sentinels", () => {
    expect(OPERATOR_HANDOFF_ACK_SENTINEL).toBe("skipped:operator-handoff-ack");
  });
});
