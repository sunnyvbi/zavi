
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterPin = {
  upstream: string;
};

export function applyOpenRouterPin<T extends Record<string, unknown>>(
  body: T,
  pin: OpenRouterPin,
): T & {
  provider: { order: string[]; allow_fallbacks: false; require_parameters: true };
  usage: { include: true };
} {
  return {
    ...body,
    provider: {
      order: [pin.upstream],
      allow_fallbacks: false,
      require_parameters: true,
    },
    usage: { include: true },
  };
}

export type OpenRouterCallMeta = {
  served_provider: string | null;
  cost_usd: number | null;
};

export function extractOpenRouterMeta(text: string): OpenRouterCallMeta {
  const out: OpenRouterCallMeta = { served_provider: null, cost_usd: null };
  const take = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const r = o as { provider?: unknown; usage?: { cost?: unknown } };
    if (typeof r.provider === "string" && r.provider) out.served_provider = r.provider;
    if (r.usage && typeof r.usage.cost === "number" && Number.isFinite(r.usage.cost)) {
      out.cost_usd = r.usage.cost;
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      take(JSON.parse(trimmed));
    } catch {
    }
    return out;
  }
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      take(JSON.parse(payload));
    } catch {
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function isServedByPin(served: string | null, pin: OpenRouterPin): boolean {
  if (!served) return false;
  const a = norm(served);
  const b = norm(pin.upstream);
  return a.length > 0 && (a === b || a === `${b}ai` || `${a}ai` === b);
}

export type OpenRouterVerdict = "ok" | "unpinned_route" | "no_usage_cost" | "no_calls";

export class OpenRouterRunRecorder {
  readonly calls: OpenRouterCallMeta[] = [];
  private pending: Promise<void>[] = [];
  constructor(readonly pin: OpenRouterPin) {}

  track(p: Promise<void>): void {
    this.pending.push(p);
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  unpinnedCalls(): OpenRouterCallMeta[] {
    return this.calls.filter((c) => !isServedByPin(c.served_provider, this.pin));
  }

  totalCostUsd(): number {
    return this.calls.reduce((s, c) => s + (c.cost_usd ?? 0), 0);
  }

  verdict(): OpenRouterVerdict {
    if (this.calls.length === 0) return "no_calls";
    if (this.unpinnedCalls().length > 0) return "unpinned_route";
    if (this.calls.some((c) => c.cost_usd === null)) return "no_usage_cost";
    return "ok";
  }
}

export function makeOpenRouterFetch(
  pin: OpenRouterPin,
  recorder: OpenRouterRunRecorder,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let nextInit = init;
    if (init && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          nextInit = { ...init, body: JSON.stringify(applyOpenRouterPin(parsed, pin)) };
        }
      } catch {
      }
    }
    const res = await baseFetch(input, nextInit);
    if (res.ok) {
      const clone = res.clone();
      recorder.track(
        clone
          .text()
          .then((t) => {
            recorder.calls.push(extractOpenRouterMeta(t));
          })
          .catch(() => {
            recorder.calls.push({ served_provider: null, cost_usd: null });
          }),
      );
    }
    return res;
  };
  return wrapped as typeof fetch;
}

const recorders = new Map<string, OpenRouterRunRecorder>();

export function registerOpenRouterRecorder(runId: string, rec: OpenRouterRunRecorder): void {
  recorders.set(runId, rec);
}

export function takeOpenRouterRecorder(runId: string): OpenRouterRunRecorder | undefined {
  const r = recorders.get(runId);
  recorders.delete(runId);
  return r;
}
