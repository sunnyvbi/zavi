"use client";

import type { SettingsField } from "../actions/types";
import { useAgentDashboard } from "../agent/dashboard-ui";
import { ChannelSettingsTab } from "../layout/ChannelTabs";
import { ConnectionSection } from "../layout/settings/ConnectionSection";
import { PostingSettings } from "../layout/settings/PostingSettings";
import { SettingsSection } from "../layout/settings/SettingsSection";
import type { PinterestPayload } from "./PinterestAnalytics";

function PinterestConnection({ slug, name, connected, onManage }: { slug: string; name: string; connected: boolean; onManage: () => void }) {
  const { data } = useAgentDashboard<PinterestPayload>(slug);
  return (
    <ConnectionSection
      slug={slug}
      name={name}
      connected={connected}
      account={connected ? data?.account?.username ?? null : null}
      manageLabel={connected ? "Disconnect" : "Connect"}
      onManage={onManage}
    />
  );
}

export function PinterestSettingsTab({ slug, name, connected, canEdit, fields, onOpenConnectors }: {
  slug: string;
  name: string;
  connected: boolean;
  canEdit: boolean;
  fields: readonly SettingsField[];
  onOpenConnectors: () => void;
}) {
  return (
    <div data-testid="channel-posting-settings" className="mx-auto flex w-full max-w-[720px] flex-col gap-6 pt-5">
      <h2 className="sr-only">{`${name} settings`}</h2>
      <PinterestConnection slug={slug} name={name} connected={connected} onManage={onOpenConnectors} />
      <PostingSettings slug={slug} name={name} canEdit={canEdit} />
      {fields.length > 0 && (
        <SettingsSection id={`${slug}-accounts`} title="Accounts Zavi reads">
          <div className="mt-3">
            <ChannelSettingsTab slug={slug} fields={fields} bare />
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
