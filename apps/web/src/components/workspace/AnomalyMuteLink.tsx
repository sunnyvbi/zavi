"use client";

import { useEffect } from "react";
import { toast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/api";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { createBrowserSupabase } from "@/lib/supabase";

const fired = new Set<string>();

export function __resetAnomalyMuteLinkForTest(): void {
  fired.clear();
}

export function muteLabel(key: string): string {
  if (key === "*") return "every metric";
  if (key.startsWith("read_failed:")) return `the ${key.slice("read_failed:".length).replace(/_/g, " ")} connection`;
  return key.replace(/_/g, " ");
}

async function setMuted(key: string, muted: boolean, company: string): Promise<boolean> {
  try {
    const res = await apiFetch("/api/analytics/anomaly-mutes", {
      method: "POST",
      body: JSON.stringify({ key, muted, expect_tenant: company }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function stripParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("mute_alert")) return;
  url.searchParams.delete("mute_alert");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function AnomalyMuteLink({ muteKey, company }: { muteKey: string; company: string }) {
  useEffect(() => {
    const once = `${company}|${muteKey}`;
    if (fired.has(once)) return;
    fired.add(once);
    const label = muteLabel(muteKey);
    void (async () => {
      const active = await getActiveTenantId(createBrowserSupabase()).catch(() => null);
      const ok = active === company && (await setMuted(muteKey, true, company));
      stripParam();
      if (!ok) {
        toast.add({ type: "error", title: "Could not mute alerts. Try the link again." });
        return;
      }
      toast.add({
        type: "success",
        title: `Alerts muted for ${label}.`,
        timeout: 10_000,
        actionProps: {
          children: "Undo",
          onClick: () => {
            void setMuted(muteKey, false, company).then((undone) =>
              toast.add(
                undone
                  ? { type: "success", title: `Alerts back on for ${label}.` }
                  : { type: "error", title: "Could not turn alerts back on. Try again." },
              ),
            );
          },
        },
      });
    })();
  }, [muteKey, company]);
  return null;
}
