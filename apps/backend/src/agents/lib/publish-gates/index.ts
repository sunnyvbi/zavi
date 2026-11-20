
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { channelRecipeStepEnvelopeSchema } from "../channel-recipe-step";
import { logEvent } from "@/services/logging/logEvent";
import { readRunEvidence, normaliseThreadUrl, type RunEvidence } from "./run-evidence";
import { applyIdentityGate } from "./identity-gate";
import { applyCommunityRulesGate, providerFor, unverifiableTarget } from "./community-rules-gate";
import { parseCitations } from "@/services/agents/citation-parser";
import {
  applyLeakGateToStep,
  cleanText,
  fieldHasHardLeak,
  internalToolNames,
  toolNamespaces,
  usableFounderName,
  type LeakResult,
  type LeakStep,
} from "./leak-gate";

export type PublishGateDeps = {
  enabled: () => boolean;
  companyNames: (tenant_id: string) => Promise<string[]>;
  bannedCommunities?: (tenant_id: string, channel: string) => Promise<string[]>;
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function defaultPublishGateDeps(): PublishGateDeps {
  return {
    enabled: () => process.env.CHANNEL_DELIVERABLE_GROUNDING !== "0",
    companyNames: async (tenant_id) => {
      const { getCompanyFacts } = require("@/services/company/facts") as typeof import("@/services/company/facts");
      const facts = await getCompanyFacts(tenant_id);
      const out: string[] = [];
      if (facts.name?.trim()) out.push(facts.name.trim());
      if (facts.website?.trim()) {
        const h = hostOf(facts.website.trim()) ?? facts.website.trim();
        out.push(h);
        const bare = h.split(".")[0];
        if (bare && bare.length >= 3) out.push(bare);
      }
      return [...new Set(out)];
    },
    bannedCommunities: async (tenant_id, channel) => {
      if (!providerFor(channel)) return [];
      const { readRedditWorkspace } = require("@/services/channels/reddit/workspace") as typeof import("@/services/channels/reddit/workspace");
      const { redditDb } = require("@/services/channels/reddit/db") as typeof import("@/services/channels/reddit/db");
      const ws = await readRedditWorkspace(redditDb(), tenant_id);
      return ws.communities.filter((c) => c.rules_verdict === "banned").map((c) => c.name);
    },
  };
}

type Step = { title: string; body: string; deliverable?: { content: string; presentation?: unknown; kind?: string } };

function isReply(step: Step): boolean {
  const p = step.deliverable?.presentation as { type?: unknown } | undefined;
  if (p?.type === "reddit_reply") return true;
  if (p?.type === "reddit_post") return false;
  return step.deliverable?.kind === "comment";
}

function threadUrlOf(step: Step): string | undefined {
  const p = step.deliverable?.presentation as { thread_url?: unknown } | undefined;
  if (typeof p?.thread_url === "string" && p.thread_url.trim()) {
    return normaliseThreadUrl(p.thread_url);
  }
  const m = /https?:\/\/[^\s"'<>)\]]*reddit\.com\/r\/[^\s"'<>)\]]*\/comments\/[^\s"'<>)\]]+/i.exec(
    `${step.body} ${step.deliverable?.content ?? ""}`,
  );
  return m ? normaliseThreadUrl(m[0]) : undefined;
}

function noMoveStep(reasons: string[]): Step & { blocking: boolean; effort: string; evidence: string[] } {
  return {
    title: "No brand mention this week",
    body:
      "Nothing branded cleared the checks this week, so there is no pitch to post. " +
      `Reason: ${reasons.join("; ")}. ` +
      "The brand-free answers above are this week's work: they build the account history that " +
      "makes a later branded answer land, and they cannot get the account banned. " +
      "Next week starts from the same threads, with the rules read first.",
    blocking: false,
    effort: "minutes",
    evidence: ["publish gates: every branded deliverable was rewritten brand-free or held"],
  };
}

export function applyEditsToReport(
  report: string,
  edits: Array<{ from: string; to: string | null }>,
): string {
  if (edits.length === 0) return report;
  let out = report;
  const unmatched: number = edits.filter((e) => {
    if (!e.from || !out.includes(e.from)) return true;
    out = out.split(e.from).join(e.to ?? "[held by the publish checks — see the action card for why]");
    return false;
  }).length;
  if (unmatched > 0) {
    out = `> ${unmatched} answer${unmatched === 1 ? "" : "s"} below ${unmatched === 1 ? "was" : "were"} changed or held by the publish checks after this report was written. The action cards are what to post; where they disagree with the text below, the cards win.\n\n${out}`;
  }
  return out;
}

export async function applyPublishGates(
  envelope: unknown,
  ctx: AgentContext,
  result: DispatcherResult,
  deps: PublishGateDeps = defaultPublishGateDeps(),
): Promise<{ envelope: unknown }> {
  if (!deps.enabled()) return { envelope };
  const parsed = channelRecipeStepEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return { envelope };
  const steps = parsed.data.steps as unknown as Step[];
  if (!steps.some((s) => s.deliverable)) return { envelope };

  const channel = String(ctx.agent?.slug ?? "");
  let evidence: RunEvidence;
  try {
    evidence = readRunEvidence(result?.tool_calls);
  } catch {
    evidence = { threadsRead: new Set(), rulesByCommunity: new Map() };
  }
  let companyNames: string[] = [];
  try {
    companyNames = await deps.companyNames(ctx.tenant_id);
  } catch {
    companyNames = [];
  }

  let bannedCommunities: ReadonlySet<string> = new Set();
  let bannedUnreadable = false;
  if (deps.bannedCommunities && providerFor(channel)) {
    try {
      bannedCommunities = new Set(await deps.bannedCommunities(ctx.tenant_id, channel));
    } catch {
      bannedUnreadable = true;
    }
  }

  const reasons: string[] = [];
  let brandedSurvived = 0;
  let gated = 0;
  const uncheckedTargets = new Set<string>();
  const reportEdits: Array<{ from: string; to: string | null }> = [];

  const out = steps.map((step, i) => {
    const deliverable = step.deliverable;
    if (!deliverable?.content) return step;
    try {
      const identity = applyIdentityGate({
        content: deliverable.content,
        companyNames,
        isReply: isReply(step),
        threadUrl: threadUrlOf(step),
        threadsRead: evidence.threadsRead,
      });
      for (const e of identity.edits) {
        gated += 1;
        void logEvent({
          level: "info",
          source: "publish-gates",
          code: "publish_gate.identity",
          message: `identity gate rewrote a deliverable (${e.rule})`,
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: { agent_slug: channel, gate_rule: e.rule, gate_action: "rewrite", step_index: i },
        });
      }
      if (identity.hold) {
        gated += 1;
        reasons.push("a complaint reply targeted a thread that was never read");
        void logEvent({
          level: "warn",
          source: "publish-gates",
          code: "publish_gate.hold",
          message: "identity gate held a deliverable",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: { agent_slug: channel, gate_rule: identity.hold, gate_action: "hold", step_index: i },
        });
        reportEdits.push({ from: deliverable.content, to: null });
        return {
          ...step,
          body: `${step.body}\n\nHeld: the thread it answers was not read, so the reply is not ready to post. Read the thread first, then answer it.`,
          deliverable: undefined,
        };
      }

      const rules = applyCommunityRulesGate({
        channel,
        content: identity.content,
        presentation: deliverable.presentation,
        context: `${step.body} ${threadUrlOf(step) ?? ""}`,
        bannedCommunities,
        companyNames,
        evidence: bannedUnreadable ? { ...evidence, rulesByCommunity: new Map() } : evidence,
      });
      if (rules.verdict === "no_provider") {
        const named = rules.target ?? unverifiableTarget(`${step.body} ${identity.content}`);
        if (named) uncheckedTargets.add(named);
        if (rules.content !== deliverable.content) {
          return { ...step, deliverable: { ...deliverable, content: rules.content } };
        }
        return step;
      }
      if (rules.hold) {
        gated += 1;
        reasons.push(
          `${rules.target ? `r/${rules.target}` : "the target community"}: rules ${rules.verdict === "banned" ? "forbid promotion" : "could not be read"} and the answer is only useful with the brand in it`,
        );
        void logEvent({
          level: "warn",
          source: "publish-gates",
          code: "publish_gate.hold",
          message: "community-rules gate held a branded deliverable",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: { agent_slug: channel, gate_rule: rules.hold, gate_verdict: rules.verdict, gate_action: "hold", step_index: i },
        });
        reportEdits.push({ from: deliverable.content, to: null });
        return {
          ...step,
          body: `${step.body}\n\nHeld: ${rules.target ? `r/${rules.target}` : "that community"}'s rules ${rules.verdict === "banned" ? "forbid promotion" : "could not be read today"}, and there is no useful version of this answer without the product in it.`,
          deliverable: undefined,
        };
      }
      if (rules.brandFree) {
        gated += 1;
        reasons.push(
          `${rules.target ? `r/${rules.target}` : "the target community"}: rules ${rules.verdict === "banned" ? "forbid promotion" : "could not be read"}`,
        );
        void logEvent({
          level: "info",
          source: "publish-gates",
          code: "publish_gate.brand_free",
          message: "community-rules gate rewrote a deliverable brand-free",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: { agent_slug: channel, gate_verdict: rules.verdict, gate_action: "brand_free", step_index: i },
        });
        reportEdits.push({ from: deliverable.content, to: rules.content });
        return {
          ...step,
          body: `${step.body}\n\nBrand-free: ${rules.target ? `r/${rules.target}` : "that community"}'s rules ${rules.verdict === "banned" ? "forbid promotion" : "could not be read today"}, so this answer helps without naming the product. Read the rules before posting anything branded there.`,
          deliverable: { ...deliverable, content: rules.content },
        };
      }
      if (rules.verdict === "permitted") brandedSurvived += 1;
      if (identity.content !== deliverable.content) {
        reportEdits.push({ from: deliverable.content, to: identity.content });
        return { ...step, deliverable: { ...deliverable, content: identity.content } };
      }
      return step;
    } catch (e) {
      void logEvent({
        level: "error",
        source: "publish-gates",
        code: "publish_gate.threw",
        message: `publish gate threw: ${(e as Error).message}`,
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        meta: { agent_slug: channel, gate_action: "hold", step_index: i },
      });
      return { ...step, deliverable: undefined };
    }
  });

  if (uncheckedTargets.size > 0 && providerFor(channel) === null) {
    out.push({
      title: `Check the rules for ${[...uncheckedTargets].slice(0, 3).join(", ")} before posting`,
      body:
        "This channel has no way to read a community's posted rules, so nothing above was checked against them. " +
        "Open each one's rules page and confirm a vendor may post before you publish anything branded there.",
      blocking: false,
      effort: "minutes",
      evidence: ["publish gates: no rules source exists for this channel"],
    } as Step & { blocking: boolean; effort: string; evidence: string[] });
  }

  if (gated > 0 && brandedSurvived === 0) {
    out.push(noMoveStep([...new Set(reasons)].slice(0, 3)));
  }

  return {
    envelope: {
      ...parsed.data,
      rendered_markdown: applyEditsToReport(parsed.data.rendered_markdown, reportEdits),
      steps: out,
    },
  };
}

export type LeakGateDeps = {
  enabled: () => boolean;
  companyNames: (tenant_id: string) => Promise<string[]>;
  founderName: (tenant_id: string) => Promise<string | null>;
};

export function defaultLeakGateDeps(): LeakGateDeps {
  return {
    ...defaultPublishGateDeps(),
    founderName: async (tenant_id) => {
      const { resolveTenantOwnerName } = require("@/email/sendAuthEmail") as typeof import("@/email/sendAuthEmail");
      return resolveTenantOwnerName(tenant_id);
    },
  };
}

export function applyLeakEditsToReport(
  report: string,
  edits: Array<{ from: string; to: string }>,
  droppedTools: ReadonlySet<string>,
): string {
  let out = report;
  for (const { from, to } of edits) {
    if (from && from !== to && out.includes(from)) out = out.split(from).join(to);
  }
  out = cleanText(out, { prose: false }).text;
  for (const tool of droppedTools) {
    out = out.split(tool).join("[internal reference removed]");
  }
  return out;
}

const WITHDRAWN = "[withdrawn by the publish checks]";
const MIN_REPORT_MATCH = 20;

export async function applyLeakGate(
  envelope: unknown,
  ctx: AgentContext,
  toolNames: Iterable<string> = [],
  deps: LeakGateDeps = defaultLeakGateDeps(),
): Promise<{ envelope: unknown }> {
  if (!deps.enabled()) return { envelope };
  const parsed = channelRecipeStepEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return { envelope };
  const steps = parsed.data.steps as unknown as LeakStep[];
  if (steps.length === 0) {
    const report = applyLeakEditsToReport(parsed.data.rendered_markdown, [], new Set());
    return report === parsed.data.rendered_markdown
      ? { envelope }
      : { envelope: { ...parsed.data, rendered_markdown: report } };
  }

  let founderName: string | null = null;
  try {
    const [full, names] = await Promise.all([deps.founderName(ctx.tenant_id), deps.companyNames(ctx.tenant_id)]);
    founderName = usableFounderName(full, names);
  } catch {
    founderName = null;
  }
  const namespaces = toolNamespaces(toolNames);

  const channel = String(ctx.agent?.slug ?? "");
  const reportEdits: Array<{ from: string; to: string }> = [];
  const droppedTools = new Set<string>();
  const out: LeakStep[] = [];
  steps.forEach((step, i) => {
    let res: LeakResult<LeakStep>;
    try {
      res = applyLeakGateToStep(step, { founderName, namespaces });
    } catch {
      out.push(step);
      return;
    }
    if (res.action === "untouched") {
      out.push(step);
      return;
    }
    for (const rule of res.rules) {
      void logEvent({
        level: res.action === "drop" ? "warn" : "info",
        source: "publish-gates",
        code: res.action === "drop" ? "publish_gate.leak_drop" : "publish_gate.leak_clean",
        message: `leak gate ${res.action === "drop" ? "dropped" : "cleaned"} a card (${rule})`,
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        meta: { agent_slug: channel, gate_rule: rule, gate_action: res.action, step_index: i },
      });
    }
    const fields = (s: LeakStep): string[] => [
      s.deliverable?.content ?? "",
      s.deliverable?.label ?? "",
      s.body,
      s.title,
    ];
    if (res.action === "drop") {
      const pasteable = step.deliverable?.kind !== "code";
      fields(step).forEach((f, k) => {
        const leaks = fieldHasHardLeak(f, namespaces, k < 2 && pasteable);
        if (f && (leaks || f.length >= MIN_REPORT_MATCH)) reportEdits.push({ from: f, to: WITHDRAWN });
      });
      for (const f of fields(step)) internalToolNames(f, namespaces).forEach((t) => droppedTools.add(t));
      return;
    }
    const after = fields(res.step);
    fields(step).forEach((before, k) => {
      if (before.length >= MIN_REPORT_MATCH && after[k] !== before) reportEdits.push({ from: before, to: after[k] });
    });
    out.push(res.step);
  });

  const report = applyLeakEditsToReport(parsed.data.rendered_markdown, reportEdits, droppedTools);
  if (report === parsed.data.rendered_markdown && out.length === steps.length && out.every((s, i) => s === steps[i])) {
    return { envelope };
  }
  return { envelope: { ...parsed.data, rendered_markdown: report, steps: out } };
}

export function withPublishGates(
  inner: (
    envelope: unknown,
    ctx: AgentContext,
    payload: unknown,
    result: DispatcherResult,
  ) => Promise<{ envelope: unknown }>,
): (
  envelope: unknown,
  ctx: AgentContext,
  payload: unknown,
  result: DispatcherResult,
) => Promise<{ envelope: unknown }> {
  return async (envelope, ctx, payload, result) => {
    const grounded = await inner(envelope, ctx, payload, result);
    const gated = await applyPublishGates(grounded.envelope, ctx, result);
    const toolNames = [
      ...(ctx.agent?.metadata_praxis?.tools ?? []),
      ...(result?.tool_calls ?? []).map((c) => c.name),
    ];
    return applyLeakGate(gated.envelope, ctx, toolNames);
  };
}

export function writeBackGatedEnvelope(result: DispatcherResult, gated: unknown): void {
  const before = (result.parsed as { rendered_markdown?: unknown } | null)?.rendered_markdown;
  const after = (gated as { rendered_markdown?: unknown } | null)?.rendered_markdown;
  result.parsed = gated;
  if (typeof before !== "string" || typeof after !== "string" || before === after) return;
  if (before && result.output_text?.includes(before)) {
    result.output_text = result.output_text.split(before).join(after);
  } else {
    result.output_text = parseCitations(after).text;
  }
}

export function cleanNoActionReport(result: DispatcherResult): void {
  if (process.env.CHANNEL_DELIVERABLE_GROUNDING === "0") return;
  const parsed = result.parsed as { rendered_markdown?: unknown } | null;
  if (!parsed || typeof parsed.rendered_markdown !== "string") return;
  try {
    const report = applyLeakEditsToReport(parsed.rendered_markdown, [], new Set());
    if (report !== parsed.rendered_markdown) writeBackGatedEnvelope(result, { ...parsed, rendered_markdown: report });
  } catch {
  }
}
