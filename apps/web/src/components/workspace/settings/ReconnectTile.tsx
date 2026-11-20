"use client";

import { useState } from "react";
import { ConnectorLockup, ConnectorTile, TileButton, TileMenu } from "./ConnectorTile";
import { showConnectorError } from "./connectorErrorDialog";
import { startReconnectFlow } from "./reconnectFlows";

export function ReconnectTile({
  slug,
  label,
  reason,
  readOnly,
  highlighted = false,
  statusText = "Needs reconnect",
  onReconnect,
  showReconnect = true,
  onDisconnect,
}: {
  slug: string;
  label: string;
  reason: string;
  readOnly: boolean;
  highlighted?: boolean;
  statusText?: string;
  onReconnect?: () => void;
  showReconnect?: boolean;
  onDisconnect?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const reconnect = async () => {
    if (onReconnect) {
      onReconnect();
      return;
    }
    setBusy(true);
    try {
      await startReconnectFlow(slug);
    } catch (e) {
      showConnectorError({
        title: `Couldn’t reconnect ${label}`,
        message: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConnectorTile
      id={`connector-${slug}`}
      logo={<ConnectorLockup slug={slug} label={label} />}
      name={label}
      description={reason}
      status={{ tone: "danger", text: statusText }}
      highlighted={highlighted}
      action={
        readOnly ? null : (
          <>
            {showReconnect && (
              <TileButton variant="primary" onClick={() => void reconnect()} disabled={busy}>
                {busy ? "Opening…" : "Reconnect"}
              </TileButton>
            )}
            {onDisconnect && (
              <TileMenu items={[{ label: "Disconnect", onClick: onDisconnect, danger: true }]} />
            )}
          </>
        )
      }
    />
  );
}
