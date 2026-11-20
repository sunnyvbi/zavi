
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { alert } from "@/services/logging/alert";
import { slackFetch } from "@/services/tools/slack/_client";
import { bucketKey } from "@/services/logging/slack-delivery-eval";

export const CANARY_CONFIG_KEY = "slack_delivery_canary" as const;

const REPAGE_BUCKET_MS = 60 * 60 * 1000;
const UNVERIFIED_REPAGE_BUCKET_MS = 6 * 60 * 60 * 1000;
const READBACK_DELAY_MS = 2_000;

export type CanaryConfig = {
  tenant_id: string;
  channel_id: string;
  team_id?: string;
};

export type SyntheticCanaryResult = {
  configured: boolean;
  posted: boolean;
  read_back: boolean;
  ok: boolean;
  failure_reason?: string;
};

export type ConfigLoad =
  | { kind: "ok"; config: CanaryConfig }
  | { kind: "unconfigured" }
  | { kind: "read_error"; message: string };

export async function loadCanaryConfig(): Promise<ConfigLoad> {
  const { data, error } = await serviceClient()
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle();

  if (error) return { kind: "read_error", message: error.message };
  if (!data?.blob) return { kind: "unconfigured" };

  const raw = (data.blob as Record<string, unknown>)[CANARY_CONFIG_KEY];
  if (!raw || typeof raw !== "object") return { kind: "unconfigured" };
  const c = raw as Partial<CanaryConfig>;
  if (!c.tenant_id || !c.channel_id) return { kind: "unconfigured" };
  return {
    kind: "ok",
    config: { tenant_id: c.tenant_id, channel_id: c.channel_id, team_id: c.team_id },
  };
}

function safeClass(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) || "unknown_error";
}

function errClass(e: unknown): string {
  const err = e as { code?: unknown; meta?: Record<string, unknown> } | null;
  const code = typeof err?.code === "string" ? err.code : undefined;

  if (code === "slack_api_error") {
    const api = err?.meta?.slack_error;
    return safeClass(typeof api === "string" ? api : "slack_api_error");
  }
  if (code === "slack_http") {
    const status = err?.meta?.status;
    return safeClass(typeof status === "number" ? `http_${status}` : "slack_http");
  }
  if (code) return safeClass(code);

  const m = e instanceof Error ? e.message : String(e);
  for (const known of [
    "slack_not_connected",
    "slack_timeout",
    "invalid_auth",
    "token_revoked",
    "account_inactive",
    "not_in_channel",
    "channel_not_found",
    "is_archived",
    "ratelimited",
  ]) {
    if (m.includes(known)) return known;
  }
  return "unknown_error";
}

export async function runSyntheticSlackCanary(deps?: {
  nowMs?: number;
  nonce?: string;
  sleep?: (ms: number) => Promise<void>;
  load?: ConfigLoad;
  post?: typeof slackFetch;
  read?: typeof slackFetch;
}): Promise<SyntheticCanaryResult> {
  const nowMs = deps?.nowMs ?? Date.now();
  const loaded = deps?.load ?? (await loadCanaryConfig());

  if (loaded.kind === "read_error") {
    await alert({
      source: "slack-delivery-canary",
      code: "canary_config_unreadable",
      msg: `synthetic Slack canary could NOT read its config (${loaded.message}) — the probe did not run and delivery health is UNKNOWN.`,
      email: { dedupeKey: `slack_canary:config_unreadable:${bucketKey(nowMs, REPAGE_BUCKET_MS)}` },
    });
    return {
      configured: false,
      posted: false,
      read_back: false,
      ok: false,
      failure_reason: "config_unreadable",
    };
  }

  if (loaded.kind === "unconfigured") {
    return { configured: false, posted: false, read_back: false, ok: true };
  }

  const cfg = loaded.config;
  const nonce = deps?.nonce ?? `zavi-canary-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const post = deps?.post ?? slackFetch;
  const read = deps?.read ?? slackFetch;

  const pageBroken = async (reason: string, detail: string) => {
    await alert({
      source: "slack-delivery-canary",
      code: "slack_canary_failed",
      tenant_id: cfg.tenant_id,
      msg:
        `SYNTHETIC Slack delivery canary FAILED (${reason}): ${detail}. ` +
        `Agent messages to customers are likely NOT being delivered. ` +
        `This probe posts to the dogfood probe channel and reads it back — ` +
        `it failing means the real Slack delivery path is broken.`,
      email: { dedupeKey: `slack_canary:${bucketKey(nowMs, REPAGE_BUCKET_MS)}` },
    });
  };

  const pageUnverified = async (reason: string, detail: string) => {
    await alert({
      source: "slack-delivery-canary",
      code: "slack_canary_unverified",
      tenant_id: cfg.tenant_id,
      msg:
        `SYNTHETIC Slack delivery canary could NOT VERIFY delivery (${reason}): ${detail}. ` +
        `Slack accepted the probe message, so this is NOT evidence that agent ` +
        `messages are undelivered — it is evidence the backend is losing Slack ` +
        `responses (timeouts / dropped replies). Treat as transport degradation, ` +
        `not a delivery outage; chase the backend, not Slack.`,
      email: {
        dedupeKey: `slack_canary_unverified:${bucketKey(nowMs, UNVERIFIED_REPAGE_BUCKET_MS)}`,
      },
    });
  };

  const nonceLanded = async (): Promise<"yes" | "no" | "unknown"> => {
    try {
      await sleep(READBACK_DELAY_MS);
      const hist = await read<{ messages?: Array<{ text?: string }> }>(
        cfg.tenant_id,
        "conversations.history",
        { channel: cfg.channel_id, limit: 20 },
        cfg.team_id,
      );
      return (hist?.messages ?? []).some((m) => (m.text ?? "").includes(nonce))
        ? "yes"
        : "no";
    } catch {
      return "unknown";
    }
  };

  let ts: string | undefined;
  try {
    const resp = await post<{ ok?: boolean; ts?: string }>(
      cfg.tenant_id,
      "chat.postMessage",
      { channel: cfg.channel_id, text: nonce },
      cfg.team_id,
    );
    ts = resp?.ts;
    if (!ts) {
      await pageBroken("post_no_ts", "chat.postMessage returned no message ts");
      return {
        configured: true,
        posted: false,
        read_back: false,
        ok: false,
        failure_reason: "post_no_ts",
      };
    }
  } catch (e) {
    const cls = errClass(e);
    const landed = await nonceLanded();
    if (landed === "yes") {
      await pageUnverified(
        "post_response_lost",
        `chat.postMessage threw ${cls}, but the message DID land in the probe channel`,
      );
      return {
        configured: true,
        posted: true,
        read_back: true,
        ok: false,
        failure_reason: `post_response_lost:${cls}`,
      };
    }
    if (landed === "unknown") {
      await pageUnverified(
        "post_unconfirmed",
        `chat.postMessage threw ${cls} and the confirm-read failed too, so delivery is UNKNOWN`,
      );
      return {
        configured: true,
        posted: false,
        read_back: false,
        ok: false,
        failure_reason: `post_unconfirmed:${cls}`,
      };
    }
    await pageBroken(
      "post_failed",
      `chat.postMessage threw ${cls} and the message is NOT in the channel`,
    );
    return {
      configured: true,
      posted: false,
      read_back: false,
      ok: false,
      failure_reason: `post_failed:${cls}`,
    };
  }

  await sleep(READBACK_DELAY_MS);
  try {
    const hist = await read<{ messages?: Array<{ text?: string }> }>(
      cfg.tenant_id,
      "conversations.history",
      { channel: cfg.channel_id, limit: 20 },
      cfg.team_id,
    );
    const found = (hist?.messages ?? []).some((m) => (m.text ?? "").includes(nonce));
    if (!found) {
      await pageBroken(
        "nonce_not_readable",
        "posted ok but the message was NOT in channel history on readback",
      );
      return {
        configured: true,
        posted: true,
        read_back: false,
        ok: false,
        failure_reason: "nonce_not_readable",
      };
    }
  } catch (e) {
    const cls = errClass(e);
    await pageUnverified(
      "readback_failed",
      `conversations.history threw ${cls} (the post itself was ACKed with a message ts)`,
    );
    return {
      configured: true,
      posted: true,
      read_back: false,
      ok: false,
      failure_reason: `readback_failed:${cls}`,
    };
  }

  return { configured: true, posted: true, read_back: true, ok: true };
}

export const slackDeliveryCanaryFn = inngest.createFunction(
  {
    id: "slack-delivery-canary",
    name: "Slack delivery canary — synthetic probe, 10min",
    retries: 1,
    concurrency: 1,
  },
  { cron: "*/10 * * * *" },
  async ({ logger }) => {
    const r = await runSyntheticSlackCanary();
    if (!r.configured && r.ok) {
      logger.warn(
        `slack-delivery-canary: NOT CONFIGURED — no synthetic probe is running. ` +
          `Set system_config.blob.slack_delivery_canary = ` +
          `{tenant_id, channel_id, team_id?} and invite the bot to the channel.`,
      );
      return r;
    }
    logger.info(
      `slack-delivery-canary: configured=${r.configured} posted=${r.posted} ` +
        `read_back=${r.read_back} ok=${r.ok}${r.failure_reason ? ` reason=${r.failure_reason}` : ""}`,
    );
    return r;
  },
);
