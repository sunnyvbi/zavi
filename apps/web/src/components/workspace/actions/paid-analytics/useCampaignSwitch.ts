"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { setGoogleCampaignOn, waitForGoogleChange } from "../managed-campaigns/google/googleEditorApi";
import { setMetaCampaignOn, waitForMetaChange } from "../managed-campaigns/meta/metaEditorApi";
import { requestTiktokCampaignStatus } from "../tiktok-campaigns/requestStatus";
import { APPROVALS_CHANGED_EVENT } from "../topActions/api";
import { formatCurrency } from "../../metrics/currency";
import type { AnalyticsRow, PaidAnalyticsKind } from "./model";

export type CampaignState = "active" | "paused" | string | null;

export function campaignState(status: string | null): CampaignState {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return null;
  return s === "enabled" ? "active" : s;
}

const UNCONFIRMED = "The change could not be confirmed. Refresh before trying again.";

export function useCampaignSwitch({ kind, rows, currency, onChanged }: { kind: PaidAnalyticsKind; rows: readonly AnalyticsRow[]; currency: string | null; onChanged: () => void }) {
  const [switched, setSwitched] = useState<Record<string, "active" | "paused">>({});
  const [asked, setAsked] = useState<Record<string, "active" | "paused">>({});
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writing = useRef(false);

  useEffect(() => {
    setSwitched((now) => {
      const kept = Object.entries(now).filter(([id, state]) => {
        const row = rows.find((r) => r.id === id);
        return !!row && campaignState(row.status) !== state;
      });
      return kept.length === Object.keys(now).length ? now : Object.fromEntries(kept);
    });
    setAsked((now) => {
      const kept = Object.entries(now).filter(([id, state]) => {
        const row = rows.find((r) => r.id === id);
        return !!row && campaignState(row.status) !== state;
      });
      return kept.length === Object.keys(now).length ? now : Object.fromEntries(kept);
    });
  }, [rows]);
  const awaiting = useMemo(() => new Set(Object.keys(asked)), [asked]);

  const stateOf = (row: AnalyticsRow): CampaignState => switched[row.id] ?? campaignState(row.status);

  async function flip(row: AnalyticsRow) {
    if (writing.current || kind === "x" || kind === "reddit") return;
    const on = stateOf(row) !== "active";
    const asks = kind === "tiktok";
    if (asks && !row.advertiserId) return;
    if (on) {
      const words = formatCurrency(row.budget, row.currency ?? currency);
      const spend = words === "-" ? null : words;
      const agreed = await confirmAction({
        title: `Switch on ${row.name}?`,
        description: asks
          ? `Zavi prepares the change for your approval. Once approved, it starts spending${spend ? ` with a daily budget of ${spend}` : ""}.`
          : spend ? `It starts spending up to ${spend} a day.` : "It starts spending.",
        confirmLabel: asks ? "Send for approval" : "Launch now",
        cancelLabel: "Not yet",
      });
      if (!agreed || writing.current) return;
    }
    writing.current = true;
    setPending(row.id);
    setNotice(null);
    setError(null);
    try {
      if (asks) {
        await requestTiktokCampaignStatus({ advertiser_id: row.advertiserId!, campaign_id: row.id }, on);
        setAsked((now) => ({ ...now, [row.id]: on ? "active" : "paused" }));
        setNotice(`${row.name}: the request to ${on ? "switch it on" : "pause it"} is ready. Approve it on the Overview tab and TikTok changes.`);
        window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
        onChanged();
        return;
      }
      const outcome = kind === "meta"
        ? await waitForMetaChange(await setMetaCampaignOn(row.id, row.name, on))
        : await waitForGoogleChange(await setGoogleCampaignOn(row.id, row.name, on));
      if (outcome.state === "done") {
        setSwitched((now) => ({ ...now, [row.id]: on ? "active" : "paused" }));
        setNotice(on ? `${row.name} is on. Delivery and reported spend may take time to settle.` : `${row.name} is paused.`);
        onChanged();
      } else if (outcome.state === "running") {
        setNotice(`${row.name} is still being ${on ? "switched on" : "paused"}. Refresh in a minute to see it.`);
        onChanged();
      } else setError(`${row.name}: ${outcome.message}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : UNCONFIRMED);
    } finally {
      writing.current = false;
      setPending(null);
    }
  }

  return { stateOf, flip, pending, awaiting, notice, error };
}
