import type { Request, Response } from "express";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import { hashIp, tickAttemptBucket } from "@/services/launch-video-public/store";
import { localMetersBypassed } from "@/services/launch-video-public/caps";
import { prefillFromUrl, toHttpsUrl } from "@/services/launch-video-public/prefill";
import {
  applyMaterial,
  describeSite,
  fieldsFromWords,
  mergeIntoBrief,
  tidyFields,
  MATERIAL_QUESTIONS,
  EMPTY_DRAFT,
  AUDIENCE_OPTIONS,
  type ChatDraft,
  type ChatStep,
  type ChatTurn,
  type Grammar,
} from "@/services/launch-video-public/chat";

const WINDOW_SECONDS = 24 * 60 * 60;
const MAX_INPUT = 2_000;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

function readDraft(raw: unknown): ChatDraft {
  const d = (raw ?? {}) as Record<string, unknown>;
  const grammar = d.grammar === "dense" || d.grammar === "calm" ? (d.grammar as Grammar) : null;
  const pf = d.prefill as Record<string, unknown> | undefined;
  const skipped = Array.isArray(d.skipped)
    ? d.skipped.map((v) => str(v, 24)).filter((v) => v in MATERIAL_QUESTIONS).slice(0, 8)
    : [];
  const pending = str(d.pending, 24);
  const missing = Array.isArray(d.missing)
    ? d.missing.map((v) => str(v, 24)).filter((v) => v in MATERIAL_QUESTIONS).slice(0, 8)
    : [];
  return {
    site_url: str(d.site_url, 300),
    email: str(d.email, 254),
    brief: str(d.brief, 4_000),
    grammar,
    pending: pending in MATERIAL_QUESTIONS ? pending : "",
    skipped,
    missing,
    prefill: pf
      ? {
          product_name: str(pf.product_name, 80),
          one_liner: str(pf.one_liner, 160),
          features: str(pf.features, 2_000),
          audience: str(pf.audience, 120),
          cta_text: str(pf.cta_text, 40),
          problem: str(pf.problem, 240),
          metrics: str(pf.metrics, 200),
          regions: str(pf.regions, 400),
          screen: str(pf.screen, 600),
        }
      : null,
  };
}

async function meterTurn(ip: string): Promise<"ok" | "limited" | "error"> {
  const unmetered = localMetersBypassed();
  const globalLimit = await getNumberSetting("launch_video_public_prefill_global_day");
  const perIp = unmetered ? 0 : await getNumberSetting("launch_video_public_prefill_per_ip_day");
  try {
    if (perIp > 0 && !(await tickAttemptBucket(`lvp_prefill:ip:${hashIp(ip)}`, perIp, WINDOW_SECONDS))) {
      return "limited";
    }
    if (globalLimit > 0 && !(await tickAttemptBucket("lvp_prefill:global", globalLimit, WINDOW_SECONDS))) {
      return "limited";
    }
    return "ok";
  } catch {
    return "error";
  }
}

const turn = (step: ChatStep, message: string, options: ChatTurn["options"], allowFreeText: boolean, draft: ChatDraft): ChatTurn => ({
  step,
  message,
  options,
  allowFreeText,
  draft,
});

const AUDIENCE_TURN = (draft: ChatDraft): ChatTurn =>
  turn(
    "audience",
    "Who is this for?",
    AUDIENCE_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
    false,
    draft,
  );

const EXTRAS_TURN = (draft: ChatDraft): ChatTurn =>
  turn(
    "extras",
    "Anything you want it to show that I have not mentioned?",
    [{ label: "Nothing, make it", value: "skip" }],
    true,
    draft,
  );

export async function launchVideoPublicChat(req: Request, res: Response): Promise<void> {
  if (!(await getBoolSetting("launch_video_public_enabled"))) {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
    return;
  }
  const ip = req.ip || req.socket?.remoteAddress || null;
  if (!ip) {
    res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const step = str(body.step, 20) as ChatStep;
  const choice = str(body.choice, 40);
  const input = str(body.input, MAX_INPUT);
  const draft = readDraft(body.draft);

  if (step === "site") {
    const url = input || draft.site_url;
    if (!url) {
      res.status(400).json({ error: { code: "missing_url", message: "Paste your website and I will read it." } });
      return;
    }
    const metered = await meterTurn(ip);
    if (metered === "error") {
      res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
      return;
    }
    if (metered === "limited") {
      res.status(429).json({ error: { code: "prefill_limited", message: "Too many lookups recently. Please try again later." } });
      return;
    }

    const read = await prefillFromUrl(url);
    if (!read.ok) {
      if (read.reason === "bad_url") {
        res.json(turn("site", "That does not look like a web address. Paste the link to your site.", [], true, EMPTY_DRAFT));
        return;
      }
      res.json(
        turn(
          "confirm",
          "I could not read that site. Tell me what you are launching and what someone does with it, in your own words.",
          [],
          true,
          { ...EMPTY_DRAFT, site_url: toHttpsUrl(url) },
        ),
      );
      return;
    }

    const secondCall = await meterTurn(ip);
    const said = secondCall === "ok" ? await describeSite(read.fields) : read.fields.one_liner;
    const next: ChatDraft = {
      ...EMPTY_DRAFT,
      site_url: read.source_url,
      prefill: tidyFields(read.fields),
      brief: said,
    };
    res.json(
      turn(
        "confirm",
        said ? `${said}\n\nIs that right, or did I miss the point?` : "Tell me what you are launching, in your own words.",
        said ? [{ label: "That is it", value: "yes" }] : [],
        true,
        next,
      ),
    );
    return;
  }

  if (step === "confirm") {
    if (!draft.prefill && !input) {
      res.json(turn("confirm", "Tell me what you are launching and what someone does with it, in your own words.", [], true, draft));
      return;
    }
    if (!draft.prefill) {
      const metered = await meterTurn(ip);
      const fields = metered === "ok" ? await fieldsFromWords(input) : await fieldsFromWords(input, { complete: async () => "" });
      res.json(AUDIENCE_TURN({ ...draft, prefill: fields, brief: input }));
      return;
    }
    if (choice === "yes" || !input) {
      res.json(AUDIENCE_TURN(draft));
      return;
    }
    const metered = await meterTurn(ip);
    if (metered !== "ok") {
      res.json(AUDIENCE_TURN({ ...draft, brief: [draft.brief, input].filter(Boolean).join("\n\n") }));
      return;
    }
    const brief = await mergeIntoBrief(draft.brief, input);
    res.json(AUDIENCE_TURN({ ...draft, brief }));
    return;
  }

  if (step === "audience") {
    const grammar: Grammar = choice === "dense" ? "dense" : "calm";
    res.json(EXTRAS_TURN({ ...draft, grammar }));
    return;
  }

  if (step === "extras") {
    if (choice === "skip" || !input) {
      res.json(turn("ready", "Where should I send it?", [], true, draft));
      return;
    }
    const metered = await meterTurn(ip);
    const brief =
      metered === "ok"
        ? await mergeIntoBrief(draft.brief, input)
        : [draft.brief, input].filter(Boolean).join("\n\n");
    res.json(turn("ready", "Where should I send it?", [], true, { ...draft, brief }));
    return;
  }

  if (step === "material") {
    const fields = draft.prefill;
    if (!fields) {
      res.status(400).json({ error: { code: "bad_step", message: "Something went wrong. Please start again." } });
      return;
    }
    const fromBody = Array.isArray(body.missing)
      ? (body.missing as unknown[]).map((v) => str(v, 24)).filter((v) => v in MATERIAL_QUESTIONS)
      : [];
    const missing = fromBody.length > 0 ? fromBody : draft.missing;
    let next = { ...draft, missing };
    if (draft.pending) {
      next =
        choice === "skip" || !input
          ? { ...draft, missing, pending: "", skipped: [...draft.skipped, draft.pending] }
          : {
              ...draft,
              pending: "",
              missing: missing.filter((f) => f !== draft.pending),
              prefill: applyMaterial(fields, draft.pending, input),
            };
    }
    const ask = next.missing.find((f) => !next.skipped.includes(f));
    if (!ask) {
      res.json(turn("ready", "That is everything I can use. Make it when you are ready.", [], true, { ...next, pending: "" }));
      return;
    }
    res.json(
      turn("material", MATERIAL_QUESTIONS[ask].ask, [{ label: "Skip this", value: "skip" }], true, {
        ...next,
        pending: ask,
      }),
    );
    return;
  }

  res.status(400).json({ error: { code: "bad_step", message: "Something went wrong. Please start again." } });
}
