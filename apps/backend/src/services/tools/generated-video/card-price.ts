import { generativeVideoIntakeSchema } from "@/services/launch-video/generative-video-intake";
import { billedVideoCredits } from "@/services/launch-video/video-estimate";

export const VIDEO_RENDER_CLASS_PREFIX = "generated_video.render.v1";

type CardBody = {
  cost_credits?: unknown;
  step?: { body?: unknown } & Record<string, unknown>;
  exact_change?: { rows?: Array<{ item?: unknown; after?: unknown } & Record<string, unknown>> } & Record<string, unknown>;
} & Record<string, unknown>;

export function repriceVideoCardBody(body: unknown, credits: number): unknown {
  const b = body as CardBody | null;
  if (!b || typeof b !== "object" || typeof b.cost_credits !== "number" || b.cost_credits === credits) return body;
  const was = b.cost_credits.toLocaleString("en-US");
  const now = credits.toLocaleString("en-US");
  const swap = (text: unknown) => (typeof text === "string" ? text.split(`${was} credits`).join(`${now} credits`) : text);
  return {
    ...b,
    cost_credits: credits,
    ...(b.step ? { step: { ...b.step, body: swap(b.step.body) } } : {}),
    ...(b.exact_change?.rows
      ? { exact_change: { ...b.exact_change, rows: b.exact_change.rows.map((r) => (r.item === "Cost" ? { ...r, after: swap(r.after) } : r)) } }
      : {}),
  };
}

type PricedRow = { id: string; exec_class?: string | null; exec_status?: string | null; exec_payload?: unknown };

export async function repriceVideoCards<A extends { id: string; body?: unknown }>(
  actions: A[],
  rows: PricedRow[],
  price: (intake: Parameters<typeof billedVideoCredits>[0]) => Promise<number> = billedVideoCredits,
): Promise<A[]> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(
    actions.map(async (a) => {
      const row = byId.get(a.id);
      if (!row?.exec_class?.startsWith(VIDEO_RENDER_CLASS_PREFIX) || row.exec_status === "executed") return a;
      const intake = generativeVideoIntakeSchema.safeParse((row.exec_payload as { intake?: unknown } | null)?.intake);
      if (!intake.success) return a;
      try {
        return { ...a, body: repriceVideoCardBody(a.body, await price(intake.data)) };
      } catch {
        return a;
      }
    }),
  );
}
