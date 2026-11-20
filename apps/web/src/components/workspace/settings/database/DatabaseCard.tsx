"use client";

import { useCallback, useEffect, useState } from "react";
import { ConnectorLockup, ConnectorTile, TileButton, TileMenu, type TileTone } from "../ConnectorTile";
import { FormPrimaryButton } from "../formControls";
import { readWorkspaceLocation, replaceWorkspaceLocation } from "../../navigation/workspaceRoutes";
import { getConnector, getSetup, requestAccess, type ConnectorStatus, type ConnectResult, type DbSetup, type DbType, type ReadOnlyCheck } from "./databaseApi";
import { connectorTileStatus, dbTileDescription, dbTileMenu, dbTileState, unencryptedWarning, type DbMenuItem } from "./databaseTile";
import { ChoosePanel, PasteForm } from "./DatabaseSetupPanel";
import { ConnectorInstallPanel } from "./ConnectorInstallPanel";
import { ConnectorStatusPanel } from "./ConnectorStatusPanel";
import { ConnectorRemovedPanel, ConnectorRulesPanel, confirmAndRemoveConnector } from "./ConnectorRulesPanel";
import { DatabaseSeePanel } from "./DatabaseSeePanel";
import { DatabaseDonePanel, DatabasePrivacyPanel } from "./DatabasePrivacyPanel";
import { DisconnectedPanel, confirmAndDisconnect } from "./DatabaseDisconnectDialog";

export const DB_CARD_NAME = "Your database";

type Panel =
  | { kind: "choose" }
  | { kind: "paste" }
  | { kind: "connector" }
  | { kind: "connector-status" }
  | { kind: "connector-rules" }
  | { kind: "connector-removed"; command: string }
  | { kind: "see"; flow: "setup" | "manage"; readOnly?: ReadOnlyCheck | null; check: boolean }
  | { kind: "privacy"; flow: "setup" | "manage" }
  | { kind: "done" }
  | { kind: "disconnected"; revoke: string };

function openDataAccessTab() {
  const url = new URL(readWorkspaceLocation(), "https://workspace.local");
  url.hash = "data-access";
  replaceWorkspaceLocation(`${url.pathname}${url.search}${url.hash}`);
}

export function DatabaseCard({
  connected,
  dbType = null,
  managedBy = null,
  canManage,
  highlighted = false,
  syncedText = null,
}: {
  connected: boolean;
  dbType?: string | null;
  managedBy?: string | null;
  canManage: boolean;
  highlighted?: boolean;
  syncedText?: string | null;
}) {
  const [setup, setSetup] = useState<DbSetup | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [requested, setRequested] = useState<"idle" | "busy" | "sent" | "already">("idle");
  const [justConnected, setJustConnected] = useState(false);

  const [connector, setConnector] = useState<ConnectorStatus | null>(null);

  const reload = useCallback(async () => {
    try {
      const s = await getSetup();
      setSetup(s);
      if (s.connected && s.mode === "connector") setConnector(await getConnector().catch(() => null));
      else setConnector(null);
    } catch {
      setSetup(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const fromList: DbSetup =
    connected || justConnected
      ? { connected: true, mode: "direct", dialect: (dbType ?? "") as DbType, legacy: false, managed_by: managedBy, discovery: "ready", settings_confirmed: true }
      : { connected: false };
  const effective: DbSetup = setup && (setup.connected || !justConnected) && "connected" in setup ? setup : fromList;
  const state = dbTileState(effective, canManage);
  const menu = dbTileMenu(state);
  const isConnected = state !== "none" && state !== "member-none";

  const onMenu = async (item: DbMenuItem) => {
    if (item === "What Zavi can see") return setPanel({ kind: "see", flow: "manage", check: true });
    if (item === "Privacy") return setPanel({ kind: "privacy", flow: "manage" });
    if (item === "Data access log") return openDataAccessTab();
    if (item === "Reconnect") return setPanel({ kind: "choose" });
    if (item === "Connector status") return setPanel({ kind: "connector-status" });
    if (item === "Rules (read-only)") return setPanel({ kind: "connector-rules" });
    if (item === "Remove connector") {
      const command = await confirmAndRemoveConnector();
      if (command !== null) {
        setPanel({ kind: "connector-removed", command });
        void reload();
      }
      return;
    }
    if (item === "Disconnect") {
      const revoke = await confirmAndDisconnect();
      if (revoke !== null) {
        setJustConnected(false);
        setPanel({ kind: "disconnected", revoke });
        void reload();
      }
    }
  };

  const onRequest = async () => {
    setRequested("busy");
    try {
      const r = await requestAccess();
      setRequested(r.already_requested ? "already" : "sent");
    } catch {
      setRequested("idle");
    }
  };

  const tone: TileTone = isConnected ? "connected" : "idle";
  const action = (() => {
    if (state === "member-none") {
      return (
        <TileButton onClick={() => void onRequest()} disabled={requested !== "idle"}>
          {requested === "sent" || requested === "already" ? "Request sent" : "Request access"}
        </TileButton>
      );
    }
    if (state === "member-connected") return null;
    if (state === "none") {
      return (
        <TileButton onClick={() => setPanel((p) => (p ? null : { kind: "choose" }))} ariaExpanded={panel !== null}>
          <span aria-hidden>Connect</span>
          <span className="sr-only">Connect {DB_CARD_NAME}</span>
        </TileButton>
      );
    }
    return <TileMenu label="Manage" items={menu.map((label) => ({ label, onClick: () => void onMenu(label), danger: label === "Disconnect" || label === "Remove connector" }))} />;
  })();

  const unencrypted =
    canManage && panel === null && effective.connected && effective.mode === "direct"
      ? unencryptedWarning(effective.dialect, effective.transport)
      : null;
  const close = () => setPanel(null);
  const finish = () => {
    setPanel(null);
    void reload();
  };

  return (
    <>
      {unencrypted && (
        <div className="col-span-full rounded-[12px] border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] leading-[18px]" role="region" aria-label={unencrypted.title}>
          <p className="font-semibold text-amber-800">{unencrypted.title}</p>
          <p className="mt-1 text-[#595959]">{unencrypted.body}</p>
          <div className="mt-2">
            <FormPrimaryButton type="button" onClick={() => setPanel({ kind: "choose" })}>
              Reconnect
            </FormPrimaryButton>
          </div>
        </div>
      )}
      <ConnectorTile
        id="connector-operator_db"
        logo={<ConnectorLockup slug="operator_db" label={DB_CARD_NAME} />}
        name={DB_CARD_NAME}
        description={dbTileDescription(state, effective, syncedText, connector)}
        status={
          isConnected && effective.connected && effective.mode === "connector"
            ? connectorTileStatus(connector)
            : { tone, text: isConnected ? "Connected" : "Not connected" }
        }
        highlighted={highlighted}
        action={action}
      />
      {canManage && panel && (
        <div className="col-span-full">
          {panel.kind === "choose" && (
            <ChoosePanel onCancel={close} onContinue={(mode) => setPanel(mode === "cloud" ? { kind: "paste" } : { kind: "connector" })} />
          )}
          {panel.kind === "connector" && <ConnectorInstallPanel onCancel={finish} onOnline={() => void reload()} />}
          {panel.kind === "connector-status" && <ConnectorStatusPanel onDone={finish} />}
          {panel.kind === "connector-rules" && (
            <ConnectorRulesPanel
              onDone={finish}
              onRemoved={(command) => {
                setPanel({ kind: "connector-removed", command });
                void reload();
              }}
            />
          )}
          {panel.kind === "connector-removed" && <ConnectorRemovedPanel removalCommand={panel.command} onDone={finish} />}
          {panel.kind === "paste" && (
            <PasteForm
              onCancel={close}
              onConnected={() => {
                setJustConnected(true);
                void reload();
              }}
              onNext={(r: ConnectResult) => setPanel({ kind: "see", flow: "setup", readOnly: r.read_only_check ?? null, check: false })}
            />
          )}
          {panel.kind === "see" && (
            <DatabaseSeePanel
              readOnly={panel.readOnly}
              check={panel.check}
              saveLabel={panel.flow === "setup" ? "Next" : "Save"}
              onCancel={panel.flow === "manage" ? close : undefined}
              onSaved={() => (panel.flow === "setup" ? setPanel({ kind: "privacy", flow: "setup" }) : finish())}
            />
          )}
          {panel.kind === "privacy" && (
            <DatabasePrivacyPanel onCancel={close} onSaved={() => (panel.flow === "setup" ? setPanel({ kind: "done" }) : finish())} />
          )}
          {panel.kind === "done" && <DatabaseDonePanel onDone={finish} />}
          {panel.kind === "disconnected" && <DisconnectedPanel revokeCommand={panel.revoke} onDone={finish} />}
        </div>
      )}
    </>
  );
}
