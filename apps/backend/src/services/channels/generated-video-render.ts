
import { checkAffordMedia } from "@/services/media-router/charge";
import { isMediaRouterEnabled } from "@/services/media-router/router";
import { generativeVideoIntakeSchema } from "@/services/launch-video/generative-video-intake";
import { billedVideoUsd, videoCreditsOf } from "@/services/launch-video/video-estimate";
import { isGenerativeVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";
import { isChannelLockedStrict } from "@/services/channels/lock";

export const GENERATED_VIDEO_RENDER_CLASS = "generated_video.render.v1";

export const CHANNEL_VIDEO_EVENT = "video.generate.channel-action.requested";

export const NOT_ENOUGH_CREDITS = (credits: number) =>
  `This video costs about ${credits.toLocaleString("en-US")} credits and your workspace has fewer than that right now. Top up credits, then press Try again. Nothing was made and nothing was charged.`;

export const CREDITS_UNREADABLE =
  "Zavi could not check your credits just now, so nothing was made and nothing was charged. Press Try again in a minute.";

export const RENDER_UNCONFIRMED =
  "Zavi could not confirm this video started. You are only charged for a video that is made. Press Try again.";

export const VIDEO_UNAVAILABLE =
  "Video making is switched off right now, so nothing was made and nothing was charged. Try again later.";

export const CHANNEL_SWITCHED_OFF =
  "AI UGC Videos is switched off right now, so nothing was made and nothing was charged.";

export type RenderRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  body: Record<string, unknown>;
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_source?: string;
  claim_id?: string | null;
};

export type RenderResult = {
  ok: boolean;
  error?: string;
  deferred?: boolean;
  code?: string;
};

export type RenderDeps = {
  routerEnabled: () => Promise<boolean>;
  videoEnabled: (tenant_id: string) => Promise<boolean>;
  afford: typeof checkAffordMedia;
  send: (evt: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
  channelLocked: () => Promise<boolean>;
};

async function defaultSend(evt: { id: string; name: string; data: Record<string, unknown> }): Promise<unknown> {
  const { inngest } = await import("@/../workers/client");
  return inngest.send(evt as never);
}

const DEFAULT_DEPS: RenderDeps = {
  routerEnabled: isMediaRouterEnabled,
  videoEnabled: (t) => isGenerativeVideoEnabled(t),
  afford: checkAffordMedia,
  send: defaultSend,
  channelLocked: () => isChannelLockedStrict("generated_video"),
};

export function renderKeyFor(actionId: string, claimId: string): string {
  return `ca-${actionId}-${claimId}`;
}

export type RenderPreflightRefusal = {
  status: 402 | 503;
  body: { error: { code: string; message: string; required_credits?: number } };
};

export const VIDEO_UNAVAILABLE_REFUSAL: RenderPreflightRefusal = {
  status: 503,
  body: { error: { code: "video_unavailable", message: VIDEO_UNAVAILABLE } },
};

export const CHANNEL_SWITCHED_OFF_REFUSAL: RenderPreflightRefusal = {
  status: 503,
  body: { error: { code: "video_unavailable", message: CHANNEL_SWITCHED_OFF } },
};

async function channelSwitchedOff(d: RenderDeps): Promise<boolean> {
  try {
    return await d.channelLocked();
  } catch {
    return true;
  }
}

export async function videoMakingOff(tenant_id: string, deps: Partial<RenderDeps> = {}): Promise<boolean> {
  const d = { ...DEFAULT_DEPS, ...deps };
  return !(await d.routerEnabled()) || !(await d.videoEnabled(tenant_id));
}

export async function generatedVideoApproveRefusal(
  tenant_id: string,
  payload: unknown,
  deps: Partial<RenderDeps> = {},
): Promise<RenderPreflightRefusal | null> {
  const d = { ...DEFAULT_DEPS, ...deps };
  try {
    if (await channelSwitchedOff(d)) return CHANNEL_SWITCHED_OFF_REFUSAL;
    if (await videoMakingOff(tenant_id, d)) return VIDEO_UNAVAILABLE_REFUSAL;
    const parsed = generativeVideoIntakeSchema.safeParse((payload as { intake?: unknown } | null)?.intake);
    if (!parsed.success) return null;
    const usd = await billedVideoUsd(parsed.data);
    if ((await d.afford(tenant_id, usd)) !== "short") return null;
    const credits = videoCreditsOf(usd);
    return {
      status: 402,
      body: { error: { code: "insufficient_credits", message: NOT_ENOUGH_CREDITS(credits), required_credits: credits } },
    };
  } catch {
    return null;
  }
}

export async function startGeneratedVideoRender(
  row: RenderRow,
  deps: Partial<RenderDeps> = {},
): Promise<RenderResult> {
  const d = { ...DEFAULT_DEPS, ...deps };

  if (row.exec_source !== "channel_actions" || !row.claim_id) {
    return { ok: false, error: "This video can only be made from its card." };
  }
  if (row.approved_by_source != null || !row.approved_by) {
    return { ok: false, error: "A person in your workspace has to approve this video. Nothing was made or charged." };
  }
  if (!row.agent_run_id) {
    return { ok: false, error: "This card has lost the run that wrote it, so it cannot be made. Nothing was charged." };
  }
  const parsed = generativeVideoIntakeSchema.safeParse(row.body?.intake);
  if (!parsed.success) {
    return { ok: false, error: "This card's script could not be read, so nothing was made or charged." };
  }
  const intake = parsed.data;

  if (await channelSwitchedOff(d)) {
    return { ok: false, error: CHANNEL_SWITCHED_OFF, code: "video_unavailable" };
  }
  if (!(await d.routerEnabled()) || !(await d.videoEnabled(row.tenant_id))) {
    return { ok: false, error: VIDEO_UNAVAILABLE, code: "video_unavailable" };
  }

  const estimateUsd = await billedVideoUsd(intake);
  const afford = await d.afford(row.tenant_id, estimateUsd);
  if (afford === "short") {
    return { ok: false, error: NOT_ENOUGH_CREDITS(videoCreditsOf(estimateUsd)), code: "insufficient_credits" };
  }
  if (afford !== "ok") {
    return { ok: false, error: CREDITS_UNREADABLE, code: "afford_check_unavailable" };
  }

  const render_key = renderKeyFor(row.id, row.claim_id);
  try {
    await d.send({
      id: render_key,
      name: CHANNEL_VIDEO_EVENT,
      data: {
        run_id: row.agent_run_id,
        tenant_id: row.tenant_id,
        intake,
        render_key,
        delivery_target: { kind: "channel_action", action_id: row.id, claim_id: row.claim_id },
      },
    });
  } catch {
    return { ok: false, error: RENDER_UNCONFIRMED };
  }
  return { ok: true, deferred: true };
}
