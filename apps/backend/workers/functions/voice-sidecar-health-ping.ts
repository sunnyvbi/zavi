
import { createHmac, randomUUID } from "node:crypto";

import { inngest } from "../client";

function warmupTargetUrl(): string {
  return (
    process.env.PRAXIS_VOICE_WARMUP_URL ??
    "http://127.0.0.1:4000/internal/voice/warmup"
  );
}

export const voiceSidecarHealthPingFn = inngest.createFunction(
  { id: "voice-sidecar-health-ping" },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const secret = process.env.PRAXIS_VOICE_SIDECAR_HMAC ?? "";
    if (!secret) {
      logger.warn(
        "voice-sidecar-health-ping skipped: PRAXIS_VOICE_SIDECAR_HMAC not configured",
      );
      return { skipped: true, reason: "missing_secret" };
    }

    const body = Buffer.from(JSON.stringify({}), "utf8");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    const eventId = randomUUID();
    const iat = Date.now();

    try {
      const res = await fetch(warmupTargetUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Praxis-Sidecar-Sig": sig,
          "X-Praxis-Event-Id": eventId,
          "X-Praxis-Iat": String(iat),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        logger.warn(
          `voice-sidecar-health-ping: HTTP ${res.status} ${text.slice(0, 200)}`,
        );
        return { ok: false, status: res.status };
      }
      return { ok: true };
    } catch (err) {
      logger.warn(
        `voice-sidecar-health-ping: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, error: "fetch_failed" };
    }
  },
);
