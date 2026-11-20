
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { TIKTOK_CREATE_LAUNCH_CLASS } from "./held-schema";

export type LaunchInFlight =
  | { kind: "open_card"; action_id: string }
  | { kind: "waiting_test"; note: string };

export const ZAVI_LAUNCH_CAMPAIGN_RE = /^Zavi · .* · campaign · zv[0-9a-f]{10}$/;

type ToolCtx = Parameters<typeof import("@/services/growth/pending-test-claim").assertNoWaitingTest>[0];

export type InFlightDeps = {
  openCards: (tenantId: string) => Promise<Array<{ action_id: string }>>;
  waitingTest: (ctx: ToolCtx) => Promise<string | null>;
};

const defaultDeps: InFlightDeps = {
  openCards: async (tenantId) => (await (await import("@/services/growth/pending-test-claim")).openChannelCards(tenantId, "tiktok_ads", TIKTOK_CREATE_LAUNCH_CLASS)),
  waitingTest: async (ctx) => {
    const { assertNoWaitingTest } = await import("@/services/growth/pending-test-claim");
    try {
      await assertNoWaitingTest(ctx, "tiktok_ads");
      return null;
    } catch (e) {
      if (e instanceof ExpectedToolError && e.code === "tiktok_ads_test_waiting") return e.message;
      throw e;
    }
  },
};

export async function readLaunchInFlight(
  ctx: ToolCtx,
  _account: OwnedComposioAccount,
  _advertiserId: string,
  deps: InFlightDeps = defaultDeps,
): Promise<LaunchInFlight[] | "unreadable"> {
  try {
    const out: LaunchInFlight[] = [];
    for (const c of await deps.openCards(ctx.tenant_id)) out.push({ kind: "open_card", action_id: c.action_id });
    const waiting = await deps.waitingTest(ctx);
    if (waiting) out.push({ kind: "waiting_test", note: waiting });
    return out;
  } catch (e) {
    console.warn(`[tiktok-launch] in-flight read failed for ${ctx.tenant_id}: ${(e as Error).message}`);
    return "unreadable";
  }
}

export function assertNothingInFlight(r: LaunchInFlight[] | "unreadable"): void {
  if (r === "unreadable") {
    throw new ExpectedToolError(
      "tiktok_ads_launch_state_unreadable",
      "Zavi could not check whether a TikTok launch is already under way, so nothing was proposed and nothing was uploaded. Try again in a minute.",
    );
  }
  const first = r[0];
  if (!first) return;
  if (first.kind === "waiting_test") throw new ExpectedToolError("tiktok_ads_test_waiting", first.note);
  throw new ExpectedToolError(
    "tiktok_ads_launch_in_flight",
    `The TikTok launch card ${first.action_id} is still open, so nothing was proposed and nothing was uploaded. Wait for it to be approved or rejected before proposing another launch.`,
    { in_flight: r },
  );
}
