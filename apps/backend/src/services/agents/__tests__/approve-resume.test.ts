import { describe, it, expect, vi, beforeEach } from "vitest";

const getBoolSetting = vi.fn();
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...args: unknown[]) => getBoolSetting(...args),
}));

import {
  PAUSED_AWAITING_APPROVAL,
  RESUME_RESOLVED_STATUS,
  isApprovePauseResumeEnabled,
  shouldPauseForApproval,
  isInteractiveResumeTrigger,
  buildResumeTurn,
  buildResumePayload,
} from "../approve-resume";
import { slackReplyClaimEventId } from "../../../../workers/functions/slack-triage-reply";

describe("approve-resume — S3 pure core", () => {
  describe("PAUSED_AWAITING_APPROVAL", () => {
    it("is the stable status string the reaper/claim/promote guards will key on", () => {
      expect(PAUSED_AWAITING_APPROVAL).toBe("paused_awaiting_approval");
    });
  });

  describe("isApprovePauseResumeEnabled", () => {
    beforeEach(() => getBoolSetting.mockReset());

    it("reads the DB-flippable registry key with the tenant id", async () => {
      getBoolSetting.mockResolvedValue(true);
      await expect(isApprovePauseResumeEnabled("t1")).resolves.toBe(true);
      expect(getBoolSetting).toHaveBeenCalledWith("approval_pause_resume_enabled", "t1");
    });

    it("defaults OFF (delegates to the registry default) when unset", async () => {
      getBoolSetting.mockResolvedValue(false);
      await expect(isApprovePauseResumeEnabled("t1")).resolves.toBe(false);
    });
  });

  describe("shouldPauseForApproval — pure decision", () => {
    it("pauses ONLY when enabled AND the emit is approval-gated", () => {
      expect(shouldPauseForApproval({ enabled: true, autonomy: "approval" })).toBe(true);
    });

    it("does NOT pause when the flag is off (byte-identical to today)", () => {
      expect(shouldPauseForApproval({ enabled: false, autonomy: "approval" })).toBe(false);
    });

    it("does NOT pause an auto-fire or a forbidden class even when enabled", () => {
      expect(shouldPauseForApproval({ enabled: true, autonomy: "auto" })).toBe(false);
      expect(shouldPauseForApproval({ enabled: true, autonomy: "forbidden" })).toBe(false);
    });

    it("does NOT pause on an unknown/missing autonomy (fail-safe to no-pause)", () => {
      expect(shouldPauseForApproval({ enabled: true, autonomy: "weird" })).toBe(false);
      expect(shouldPauseForApproval({ enabled: true, autonomy: null })).toBe(false);
      expect(shouldPauseForApproval({ enabled: true, autonomy: undefined })).toBe(false);
    });
  });

  describe("isInteractiveResumeTrigger — scope the pause to conversations", () => {
    it("pauses ONLY conversational surfaces (chat/slack/email/teams)", () => {
      for (const t of ["chat", "slack", "email", "teams"]) {
        expect(isInteractiveResumeTrigger(t)).toBe(true);
      }
    });

    it("does NOT pause scheduled/agent-to-agent/other runs (they end + dispatch as before)", () => {
      for (const t of ["cron", "a2a", "manual", "webhook", "handoff", "mcp", "playbook", "qa-weekly-execute"]) {
        expect(isInteractiveResumeTrigger(t)).toBe(false);
      }
    });

    it("fail-safe: unknown / null / undefined trigger is NON-interactive (no pause)", () => {
      expect(isInteractiveResumeTrigger("weird")).toBe(false);
      expect(isInteractiveResumeTrigger(null)).toBe(false);
      expect(isInteractiveResumeTrigger(undefined)).toBe(false);
    });
  });

  describe("buildResumeTurn — pure continuation turn", () => {
    it("approved: tells the agent the action ran + hands it the result + says continue", () => {
      const t = buildResumeTurn({
        toolName: "stripe__create_payment",
        decisionSummary: "charge customer $40",
        outcome: "charge ch_123 succeeded",
        approved: true,
      });
      expect(t).toContain("stripe__create_payment");
      expect(t).toContain("charge customer $40");
      expect(t).toContain("approved and executed");
      expect(t).toContain("charge ch_123 succeeded");
      expect(t.toLowerCase()).toContain("continue the task");
    });

    it("approved with no outcome: still coherent (It completed.)", () => {
      const t = buildResumeTurn({ toolName: "jira__create_issue", approved: true });
      expect(t).toContain("jira__create_issue");
      expect(t).toContain("It completed.");
      expect(t).not.toContain("Result:");
    });

    it("rejected: tells the agent it was NOT approved + never to retry the exact action", () => {
      const t = buildResumeTurn({
        toolName: "slack__post_message",
        outcome: "operator declined",
        approved: false,
      });
      expect(t).toContain("slack__post_message");
      expect(t).toContain("was NOT approved");
      expect(t).toContain("operator declined");
      expect(t.toLowerCase()).toContain("do not retry");
    });

    it("clamps a pathological outcome so the injected turn stays bounded", () => {
      const huge = "x".repeat(10000);
      const t = buildResumeTurn({ toolName: "t", outcome: huge, approved: true });
      expect(t.length).toBeLessThan(2300);
    });

    it("clamps a pathological tool name + collapses summary whitespace", () => {
      const t = buildResumeTurn({
        toolName: "n".repeat(500),
        decisionSummary: "a\n\n   b\t c",
        approved: true,
      });
      expect(t).toContain("a b c");
      expect(t.length).toBeLessThan(700);
    });

    it("empty tool name degrades to a readable fallback", () => {
      const t = buildResumeTurn({ toolName: "   ", approved: true });
      expect(t).toContain("the proposed action");
    });
  });

  describe("RESUME_RESOLVED_STATUS", () => {
    it("reuses 'success' (paused run's first turn genuinely completed)", () => {
      expect(RESUME_RESOLVED_STATUS).toBe("success");
    });
  });

  describe("buildResumePayload — pure continuation payload", () => {
    it("injects the resume turn as user_message + the audit marker", () => {
      const p = buildResumePayload({
        originalPayload: { thread_id: "th_1" },
        resumeTurn: "your action was approved, continue",
        pausedRunId: "run_paused",
      });
      expect(p.user_message).toBe("your action was approved, continue");
      expect(p.resume_of_run_id).toBe("run_paused");
      expect(p.thread_id).toBe("th_1");
    });

    it("preserves Slack/email/Teams routing sub-objects so the reply lands in-surface", () => {
      const p = buildResumePayload({
        originalPayload: {
          thread_id: "th_2",
          slack: { channel: "C1", thread_ts: "1.2", text: "original ask" },
          email: { subject: "re: x" },
          teams: { conversation_id: "conv_1" },
        },
        resumeTurn: "turn",
        pausedRunId: "r",
      });
      expect(p.slack).toEqual({ channel: "C1", thread_ts: "1.2", text: "original ask" });
      expect(p.email).toEqual({ subject: "re: x" });
      expect(p.teams).toEqual({ conversation_id: "conv_1" });
      expect(p.user_message).toBe("turn");
    });

    it("does NOT carry behavior-changing markers from the original payload", () => {
      const p = buildResumePayload({
        originalPayload: {
          thread_id: "th_3",
          kind: "engineer_pr_followup",
          standing_order: true,
          task_description: "do the thing",
          target_pr_number: 42,
        },
        resumeTurn: "turn",
        pausedRunId: "r",
      });
      expect(p.kind).toBeUndefined();
      expect(p.standing_order).toBeUndefined();
      expect(p.task_description).toBeUndefined();
      expect(p.target_pr_number).toBeUndefined();
    });

    it("an approval-paused ask/handoff child's continuation keeps its handoff marker and thread", () => {
      const slack = buildResumePayload({
        originalPayload: {
          slack: { channel_id: "C1", thread_ts: "1.0", event_id: "Ev1" },
          slack_handoff_child: true,
          ask_id: "ask-1",
          ask_parent_run_id: "parent-1",
        },
        resumeTurn: "turn",
        pausedRunId: "child-1",
      });
      expect(slack.slack_handoff_child).toBe(true);
      expect(slack.ask_id).toBeUndefined();
      expect(slackReplyClaimEventId("Ev1", "cont-1", slack)).toBe("Ev1:handoff:cont-1");

      for (const key of ["handoff_child", "whatsapp_handoff_child"]) {
        const p = buildResumePayload({ originalPayload: { [key]: true }, resumeTurn: "t", pausedRunId: "r" });
        expect(p[key]).toBe(true);
      }
      const web = buildResumePayload({
        originalPayload: { operator_thread_id: "th1", ask_id: "ask-1", ask_parent_run_id: "p" },
        resumeTurn: "t",
        pausedRunId: "r",
      });
      expect(web.operator_thread_id).toBe("th1");
      const plain = buildResumePayload({ originalPayload: { operator_thread_id: "th1" }, resumeTurn: "t", pausedRunId: "r" });
      expect(plain.operator_thread_id).toBeUndefined();
      expect(plain.slack_handoff_child).toBeUndefined();
    });

    it("degrades to a minimal valid chat turn on a garbage original payload", () => {
      for (const bad of [null, undefined, 42, "str", []]) {
        const p = buildResumePayload({
          originalPayload: bad,
          resumeTurn: "turn",
          pausedRunId: "r",
        });
        expect(p.user_message).toBe("turn");
        expect(p.resume_of_run_id).toBe("r");
        expect(p.thread_id).toBeUndefined();
      }
    });
  });
});
