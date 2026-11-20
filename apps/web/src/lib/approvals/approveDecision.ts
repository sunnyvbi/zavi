
import { apiFetch } from "@/lib/api";
import { surfaceQuery, type DecisionSurface, type RaiseAsk } from "./decisionApi";

export const SHIP_RED_CONFIRM =
  "This change broke a test that was passing on the base branch.\n\n" +
  "Approving opens the PR anyway, with the test still broken.\n\n" +
  "Open the PR anyway?";

export type ApproveExtras = {
  always_allow?: boolean;
  scheduled_at?: string | null;
  payload_text?: string;
  image_path?: string;
  thread?: string[] | null;
  title?: string;
  board_id?: string;
  link?: string;
  confirm_unverified?: boolean;
  expected_fingerprint?: string;
  expected_post_revision?: string;
  expected_scheduled_at?: string | null;
};

export async function approveDecision(
  decisionId: string,
  extras: ApproveExtras = {},
  confirmShipRed: (message: string) => boolean = (m) => window.confirm(m),
  opts: { surface?: DecisionSurface; runAlone?: boolean; raise?: RaiseAsk; ownUnverifiedConfirm?: boolean } = {},
): Promise<Response | null> {
  const post = (extra: Record<string, unknown>): Promise<Response> => {
    const merged = { ...extras, ...(opts.runAlone ? { run_alone: true } : {}), ...(opts.raise ?? {}), ...extra };
    return apiFetch(`/api/approvals/${decisionId}/approve${surfaceQuery(opts.surface)}`, {
      method: "POST",
      ...(Object.keys(merged).length > 0
        ? { body: JSON.stringify(merged) }
        : {}),
    });
  };

  const res = await post({});
  if (res.status !== 409) return res;

  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (body?.error?.code === "requires_unverified_confirm" && !opts.ownUnverifiedConfirm) {
    const why = body.error.message || "Zavi could not check everything on this pin.";
    if (!confirmShipRed(`${why}\n\nPost anyway?`)) return null;
    return post({ confirm_unverified: true });
  }
  if (body?.error?.code !== "requires_ship_red_override") return res;

  if (!confirmShipRed(SHIP_RED_CONFIRM)) return null;
  return post({ ship_anyway: true });
}

export async function rejectDecision(decisionId: string, opts: { surface?: DecisionSurface } = {}): Promise<Response> {
  return apiFetch(`/api/approvals/${decisionId}/reject${surfaceQuery(opts.surface)}`, { method: "POST" });
}

export async function moveRequest(anchorId: string, op: "approve-move" | "reject-move" | "move-fit", body: Record<string, unknown> = {}): Promise<Response> {
  return apiFetch(`/api/approvals/${encodeURIComponent(anchorId)}/${op}`, { method: "POST", body: JSON.stringify(body) });
}
