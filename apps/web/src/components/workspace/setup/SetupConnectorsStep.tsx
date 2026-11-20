"use client";

import { ConnectAppsView, type ConnectAppsViewProps } from "./ConnectAppsView";
import { useConnectApps } from "./useConnectApps";
import { SetupConnectPanel } from "./SetupConnectPanel";

export function SetupConnectorsStep(props: Omit<ConnectAppsViewProps, "apps" | "panel">) {
  const apps = useConnectApps();
  const panel = apps.selected ? <div onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); apps.close(); } }}>
    <SetupConnectPanel key={apps.selected.slug} slug={apps.selected.slug} teamsConfigured={apps.teams.configured} onClose={apps.close} onConnected={() => void apps.refresh().then(() => apps.refresh())} />
  </div> : null;
  return <ConnectAppsView {...props} apps={apps} panel={panel} />;
}
