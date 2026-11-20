
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { fundraisingPipelineEnabled } from "@/services/fundraising/flag";
import { inngest } from "@/../workers/client";
import { callModel } from "@/services/llm/call-model";
import { MODELS } from "@/services/llm/models";
import { estimateCostUsd } from "@/services/anthropic";

const ConfigBody = z.object({
  ask: z.string().max(2000).optional(),
  instrument: z.string().max(120).optional(),
  thesis: z.string().max(2000).optional(),
  proof: z.string().max(4000).optional(),
  send_mode: z.enum(["off", "test", "live"]).optional(),
  stage: z
    .enum(["Angel", "Pre-seed", "Seed", "Series A", "Series B+"])
    .optional(),
  deck_url: z.string().max(2000).optional(),
});

async function gateTenant(
  req: Request,
  res: Response,
): Promise<{ tenant_id: string; user_id: string } | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  const enabled = await fundraisingPipelineEnabled(auth.tenant_id);
  if (!enabled) {
    res.status(404).json({
      error: {
        code: "not_found",
        message: "fundraising pipeline not enabled for this tenant",
      },
    });
    return null;
  }
  return { tenant_id: auth.tenant_id, user_id: auth.user_id };
}

export async function fundraisingSetRoundConfig(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof ConfigBody>;
  try {
    body = ConfigBody.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const gated = await gateTenant(req, res);
  if (!gated) return;

  try {
    const { error } = await serviceClient().rpc("fundraising_set_round_config", {
      p_tenant_id: gated.tenant_id,
      p_ask: body.ask ?? null,
      p_instrument: body.instrument ?? null,
      p_thesis: body.thesis ?? null,
      p_proof: body.proof ?? null,
      p_send_mode: body.send_mode ?? "off",
      p_stage: body.stage ?? null,
      p_deck_url: body.deck_url ?? null,
    });
    if (error) throw error;
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }

  res.status(200).json({ ok: true });
}

const StageBody = z.object({
  stage: z.enum(["Angel", "Pre-seed", "Seed", "Series A", "Series B+"]),
});

export async function fundraisingSetRoundStage(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof StageBody>;
  try {
    body = StageBody.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const gated = await gateTenant(req, res);
  if (!gated) return;

  try {
    const { error } = await serviceClient().rpc("fundraising_set_round_stage", {
      p_tenant_id: gated.tenant_id,
      p_stage: body.stage,
    });
    if (error) throw error;
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }

  res.status(200).json({ ok: true });
}

export async function fundraisingRunAngelRound(
  req: Request,
  res: Response,
): Promise<void> {
  const gated = await gateTenant(req, res);
  if (!gated) return;

  try {
    const { error } = await serviceClient().rpc(
      "fundraising_mark_round_requested",
      { p_tenant_id: gated.tenant_id },
    );
    if (error) throw error;
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }

  try {
    await inngest.send({
      name: "fundraising/angel-round.requested",
      data: {
        tenant_id: gated.tenant_id,
        requested_by: gated.user_id,
      },
    });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "inngest_send_failed",
        message: `round requested stamped but pipeline enqueue failed: ${(e as Error).message}`,
      },
    });
    return;
  }

  res.status(200).json({ ok: true, pending: false });
}

const MAX_ANCHORS = 15;
const SUGGEST_MAX_TOKENS = 700;

type Suggestion = {
  ask: string;
  target_investors: string;
  proof_points: string[];
};

function parseSuggestion(text: string): Suggestion {
  const empty: Suggestion = { ask: "", target_investors: "", proof_points: [] };
  if (!text) return empty;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return empty;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!obj || typeof obj !== "object") return empty;
  const o = obj as Record<string, unknown>;
  const proof = Array.isArray(o.proof_points)
    ? o.proof_points
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.trim().slice(0, 240))
        .slice(0, 3)
    : [];
  return {
    ask: typeof o.ask === "string" ? o.ask.trim().slice(0, 2000) : "",
    target_investors:
      typeof o.target_investors === "string"
        ? o.target_investors.trim().slice(0, 2000)
        : "",
    proof_points: proof,
  };
}

export async function fundraisingSuggestRoundConfig(
  req: Request,
  res: Response,
): Promise<void> {
  const gated = await gateTenant(req, res);
  if (!gated) return;

  const sb = serviceClient();

  let anchors: Array<{ title: string | null; body_markdown: string | null }> = [];
  try {
    const { data, error } = await sb
      .from("memory_note")
      .select("title, body_markdown")
      .eq("tenant_id", gated.tenant_id)
      .eq("note_type", "anchor")
      .is("superseded_by", null)
      .order("updated_at", { ascending: false })
      .limit(MAX_ANCHORS);
    if (error) throw error;
    anchors = (data ?? []) as Array<{
      title: string | null;
      body_markdown: string | null;
    }>;
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "anchors_read_failed", message: (e as Error).message } });
    return;
  }

  let stage: string | null = null;
  try {
    const { data } = await sb
      .from("fundraising_round_config")
      .select("stage")
      .eq("tenant_id", gated.tenant_id)
      .maybeSingle();
    if (data && typeof data.stage === "string" && data.stage.length > 0) {
      stage = data.stage;
    }
  } catch {
  }

  if (anchors.length === 0) {
    res.status(200).json({ ask: "", target_investors: "", proof_points: [] });
    return;
  }

  const anchorBlock = anchors
    .map((a, i) => {
      const title = (a.title ?? "").trim();
      const body = (a.body_markdown ?? "").trim().slice(0, 1200);
      return `## Anchor ${i + 1}${title ? `: ${title}` : ""}\n${body}`;
    })
    .join("\n\n");

  const stageLine = stage
    ? `The founder is raising a ${stage} round.`
    : `The raise stage is not specified — keep the ask stage-agnostic.`;

  const system =
    "You are a fundraising assistant. Given a company's brain anchors and the " +
    "raise stage, suggest fundraising round fields. Return ONLY a JSON object: " +
    '{"ask": string, "target_investors": string, "proof_points": [3 short strings]}. ' +
    "Use ONLY facts present in the anchors — NEVER invent numbers, traction, " +
    "metrics, or names. If the ask amount/cap isn't known from the anchors, " +
    "phrase the ask without a fabricated figure (e.g. describe the instrument " +
    "and intent, not a made-up dollar amount). Keep each field tight: ask ≤ 2 " +
    "sentences, target_investors ≤ 2 sentences, each proof point ≤ 12 words. " +
    "Output the JSON object and nothing else.";

  const user = `${stageLine}\n\nCompany brain anchors:\n\n${anchorBlock}`;

  let result: Awaited<ReturnType<typeof callModel>>;
  try {
    result = await callModel({
      provider: "anthropic",
      model: MODELS.anthropic.haiku,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: SUGGEST_MAX_TOKENS,
      temperature: 0.3,
    });
  } catch (e) {
    res
      .status(502)
      .json({ error: { code: "suggest_failed", message: (e as Error).message } });
    return;
  }

  const suggestion = parseSuggestion(result.text);

  try {
    const cost = estimateCostUsd(MODELS.anthropic.haiku, result.usage);
    console.log(
      `[fundraising.suggest] tenant=${gated.tenant_id} anchors=${anchors.length} ` +
        `in=${result.usage.input_tokens} out=${result.usage.output_tokens} cost_usd=${cost}`,
    );
  } catch {
  }

  res.status(200).json(suggestion);
}
