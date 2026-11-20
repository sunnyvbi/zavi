"use client";

import { useAgentDashboard } from "../../agent/dashboard-ui";
import { ConnectionSection } from "./ConnectionSection";

export function DashboardConnection({ slug, name, logo, connected, readAccount, onManage }: {
  slug: string;
  name: string;
  logo: string;
  connected: boolean;
  readAccount: (payload: unknown) => string | null;
  onManage: () => void;
}) {
  const { data } = useAgentDashboard<unknown>(slug);
  return (
    <ConnectionSection
      slug={slug}
      name={name}
      logo={logo}
      connected={connected}
      account={connected ? readAccount(data) : null}
      manageLabel={connected ? "Disconnect" : "Connect"}
      onManage={onManage}
    />
  );
}
