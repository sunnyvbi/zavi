
import type { CallModelOpts, CallModelResult } from "@/services/llm/call-model";
import { estimateCostUsd } from "@/services/anthropic";

export type LoopTurn = { role: "user" | "assistant"; content: string };

export type LoopImage = { media_type: "image/jpeg" | "image/png"; data: string };

export type LoopContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: LoopImage["media_type"]; data: string } };

export type LoopModelOpts = Omit<CallModelOpts, "messages"> & {
  messages: Array<{ role: "user" | "assistant"; content: string | LoopContentBlock[] }>;
};

export type ParsedLoopAction<Op, Fin> =
  | { kind: "op"; op: Op }
  | { kind: "finish"; finish: Fin }
  | { kind: "invalid"; reason: string };

export type LoopCapReason = "step_limit" | "time_limit";

export type LoopEnd<Fin> =
  | { kind: "finish"; finish: Fin }
  | { kind: "cap"; reason: LoopCapReason; finish: Fin | null };

export type BrowserTaskLoopConfig<Op, Fin> = {
  engine: "anchor" | "extension";
  allowWrites: boolean;
  caps: {
    maxSteps: number;
    maxWallMs: number;
    finalizeReserveMs: number;
  };
  model: string;
  modelFor?: () => string;
  system: string;
  seed: LoopTurn[];
  historyTurns: number;
  modelTimeoutMs: number;
  maxTokens: number;
  tags: { tenantId: string; agentSlug: string; runId: string };
  parse: (text: string) => ParsedLoopAction<Op, Fin>;
  runStep: (op: Op) => Promise<string>;
  isWrite: (op: Op) => boolean;
  capPrompt: (why: string) => string;
  isFatal?: (e: unknown) => boolean;
  pausedMs?: () => number;
  singleAttempt?: boolean;
  onModelCost?: (usd: number, model: string, index: number) => Promise<void>;
  onInvalid?: () => void;
  currentImage?: () => LoopImage | null;
  callModel: (opts: LoopModelOpts) => Promise<CallModelResult>;
  now: () => number;
};

export class LoopDeadlineError extends Error {}

export function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoopDeadlineError()), Math.max(0, ms));
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export type BrowserTaskLoop<Op, Fin> = {
  step: (op: Op) => Promise<string>;
  ask: (userContent: string, model?: string) => Promise<string>;
  run: (firstObservation: string) => Promise<LoopEnd<Fin>>;
  readonly steps: number;
  readonly modelUsd: number;
  readonly started: number;
};

export function createBrowserTaskLoop<Op, Fin>(cfg: BrowserTaskLoopConfig<Op, Fin>): BrowserTaskLoop<Op, Fin> {
  const started = cfg.now();
  let steps = 0;
  let modelUsd = 0;
  let callCount = 0;
  const history: LoopTurn[] = [];

  const deadline = () => started + cfg.caps.maxWallMs + (cfg.pausedMs ? cfg.pausedMs() : 0);
  const loopDeadline = () => deadline() - cfg.caps.finalizeReserveMs;
  const minutes = Math.round(cfg.caps.maxWallMs / 60_000);

  const step = async (op: Op): Promise<string> => {
    steps++;
    if (!cfg.allowWrites && cfg.isWrite(op)) {
      return "ERROR: this browser is read-only; that action is not available.";
    }
    return cfg.runStep(op);
  };

  const ask = async (userContent: string, modelOverride?: string): Promise<string> => {
    const remaining = deadline() - cfg.now();
    if (remaining <= 1_000) throw new LoopDeadlineError();
    const timeoutMs = Math.min(cfg.modelTimeoutMs, remaining);
    history.push({ role: "user", content: userContent });
    const window = history.slice(-(cfg.historyTurns * 2 - 1));
    const turns: LoopTurn[] = [...cfg.seed, ...(window[0]?.role === "assistant" ? window.slice(1) : window)];
    const image = cfg.currentImage ? cfg.currentImage() : null;
    const model = modelOverride ?? (cfg.modelFor ? cfg.modelFor() : cfg.model);
    const messages: LoopModelOpts["messages"] = turns.map((t, i): LoopModelOpts["messages"][number] =>
      image && i === turns.length - 1 && t.role === "user"
        ? {
            role: t.role,
            content: [
              { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
              { type: "text", text: t.content },
            ],
          }
        : t,
    );
    const res = await raceDeadline(
      cfg.callModel({
        provider: "anthropic",
        model,
        system: cfg.system,
        messages,
        max_tokens: cfg.maxTokens,
        timeoutMs,
        maxAttempts: cfg.singleAttempt ? 1 : remaining >= 2 * cfg.modelTimeoutMs ? 2 : 1,
        tags: cfg.tags,
      }),
      remaining,
    );
    const usd = estimateCostUsd(model, res.usage, { tenant_id: cfg.tags.tenantId });
    modelUsd += usd;
    const index = callCount++;
    if (cfg.onModelCost) await cfg.onModelCost(usd, model, index).catch(() => undefined);
    history.push({ role: "assistant", content: res.text });
    return res.text;
  };

  const finishNow = async (reason: LoopCapReason, why: string): Promise<LoopEnd<Fin>> => {
    try {
      const parsed = cfg.parse(await ask(cfg.capPrompt(why)));
      if (parsed.kind === "finish") return { kind: "cap", reason, finish: parsed.finish };
    } catch (e) {
      if (cfg.isFatal?.(e)) throw e;
    }
    return { kind: "cap", reason, finish: null };
  };

  const run = async (firstObservation: string): Promise<LoopEnd<Fin>> => {
    let observation = firstObservation;
    for (;;) {
      if (steps >= cfg.caps.maxSteps) {
        return finishNow("step_limit", `Step limit reached (${cfg.caps.maxSteps} browser steps).`);
      }
      if (cfg.now() >= loopDeadline()) {
        return finishNow("time_limit", `Time limit reached (${minutes} minutes).`);
      }
      let text: string;
      try {
        text = await ask(`OBSERVATION:\n${observation}`);
      } catch (e) {
        if (!(e instanceof LoopDeadlineError)) throw e;
        return finishNow("time_limit", `Time limit reached (${minutes} minutes).`);
      }
      const parsed = cfg.parse(text);
      if (parsed.kind === "finish") return { kind: "finish", finish: parsed.finish };
      if (parsed.kind === "invalid") {
        steps++;
        cfg.onInvalid?.();
        observation = `ERROR: ${parsed.reason}. Reply with one JSON action.`;
        continue;
      }
      observation = await step(parsed.op);
    }
  };

  return {
    step,
    ask,
    run,
    get steps() {
      return steps;
    },
    get modelUsd() {
      return modelUsd;
    },
    started,
  };
}

export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
