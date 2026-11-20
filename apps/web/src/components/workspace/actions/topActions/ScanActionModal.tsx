"use client";

import { useState } from "react";
import { channelScanHandle } from "../../layout/channelScanHandle";
import type { TopActionSpec } from "../platformSpec";
import { ActionModal, MDone, m } from "./ActionModal";

export function ScanActionModal({
  slug,
  channelName,
  action,
  onClose,
}: {
  slug: string;
  channelName: string;
  action: TopActionSpec;
  onClose: () => void;
}) {
  const handle = channelScanHandle(slug);
  const status = handle?.status() ?? null;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const why = !status || (!status.ready && !status.loaded) ? "The page is still loading. Try again in a moment." : !status.ready ? (action.notReady ?? "This can't run yet.") : status.running ? "A scan is already running. Its results show on this page." : status.blockedWhy;

  async function scan() {
    if (!handle) return;
    setBusy(true);
    setError(null);
    const err = await handle.scan();
    setBusy(false);
    if (err === "upgrade") {
      onClose();
      return;
    }
    if (err) setError(err);
    else setDone(true);
  }

  return (
    <ActionModal
      eyebrow={channelName}
      title={action.label}
      sub={action.lead ?? ""}
      size="md"
      onClose={onClose}
      busy={busy}
      hint={action.hint}
      footer={
        <>
          <button type="button" className={m.cancel} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={m.primary} disabled={busy || !status?.canScan} onClick={scan}>
            {busy ? "Starting…" : (action.primary ?? action.label)}
          </button>
        </>
      }
      done={
        done ? (
          <MDone
            text={action.done ?? "Looking now."}
            action={
              <button type="button" className={m.cancel} onClick={onClose}>
                Done
              </button>
            }
          />
        ) : undefined
      }
    >
      {action.note && <p className={m.note}>{action.note}</p>}
      {!done && why && <p className={m.note}>{why}</p>}
      {error && (
        <p role="alert" className={m.error}>
          {error}
        </p>
      )}
    </ActionModal>
  );
}
