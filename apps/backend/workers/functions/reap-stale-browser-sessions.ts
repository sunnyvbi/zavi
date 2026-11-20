
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { closeBrowserSession } from "@/services/sandbox/browser-mcp/browser-sessions";
import { deleteAnchorSessionById } from "@/services/sandbox/browser-mcp/anchor-rest-client";

const STALE_MINUTES = 60;
const BATCH_SIZE = 200;

export const reapStaleBrowserSessionsFn = inngest.createFunction(
  { id: "reap-stale-browser-sessions" },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    const sb = serviceClient();
    const cutoffIso = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();

    const { data: rows, error } = await sb
      .from("browser_sessions")
      .select("id, provider_session_id")
      .eq("status", "open")
      .eq("engine", "anchor")
      .lt("opened_at", cutoffIso)
      .limit(BATCH_SIZE);

    if (error) {
      logger.error(`reap-stale-browser-sessions: query failed: ${error.message}`);
      throw new Error(`reap query failed: ${error.message}`);
    }

    const stale = rows ?? [];
    if (stale.length === 0) return { ok: true, removed: 0 };

    const apiKey = process.env.ANCHOR_API_KEY;
    let closed = 0;
    let errors = 0;

    for (const row of stale as Array<{ id: string; provider_session_id: string | null }>) {
      try {
        if (apiKey && row.provider_session_id) {
          const gone = await deleteAnchorSessionById(apiKey, row.provider_session_id);
          if (!gone) {
            errors += 1;
            continue;
          }
        }
        await closeBrowserSession({ session_id: row.id, reason: "reaped_stale" });
        closed += 1;
      } catch {
        errors += 1;
      }
    }

    await logEvent({
      level: closed > 0 ? "warn" : "info",
      source: "browser.session_reaper",
      meta: { total: stale.length, removed: closed, batch_errors: errors },
    });

    return { ok: true, removed: closed, batch_errors: errors };
  },
);
