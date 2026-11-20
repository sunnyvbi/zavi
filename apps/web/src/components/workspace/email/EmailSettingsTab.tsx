"use client";

import type { ReactNode } from "react";
import type { SettingsPanelId } from "../actions/types";
import { ConnectionSection } from "../layout/settings/ConnectionSection";
import { PostingSettings, type ModeControl } from "../layout/settings/PostingSettings";
import { SettingsSection } from "../layout/settings/SettingsSection";
import { AUTO_SEND_ON_AUTOPILOT_OFF, useEmailAutoSend } from "./EmailCampaignSettingsBlocks";
import { ChannelSettingsPanels } from "./EmailSettingsPanels";
import { EMAIL_SENDING_COPY, EmailSendingSwitch } from "./EmailSendingSwitch";
import { gotoEmailSettings } from "./emailSettingsNav";

export function EmailSettingsTab({ slug, name, panels, canEdit, extra, below, onOpenConnectors }: {
  slug: string;
  name: string;
  panels: readonly SettingsPanelId[];
  canEdit: boolean;
  extra?: ReactNode;
  below?: ReactNode;
  onOpenConnectors: () => void;
}) {
  const auto = useEmailAutoSend();
  const mode: ModeControl = {
    value: auto.on === null ? null : auto.on ? "auto" : "ask",
    onChange: (next) => void auto.flip(next === "auto"),
    busy: auto.busy,
    locked: !auto.canEdit,
    error: auto.error,
    loadError: auto.loadError,
    onRetry: auto.retry,
    note: auto.on && auto.autopilotOff ? AUTO_SEND_ON_AUTOPILOT_OFF : null,
  };
  return (
    <div data-testid="channel-posting-settings" className="mx-auto flex w-full max-w-[720px] flex-col gap-6 pt-5">
      <h2 className="sr-only">{`${name} settings`}</h2>
      <ChannelSettingsPanels
        panels={panels.filter((id) => id !== "email_auto_send")}
        extra={extra}
        below={below}
        lead={(connection) => (
          <>
            <ConnectionSection
              slug={slug}
              name={name}
              connected={connection.connected}
              account={connection.account}
              pending={!connection.known}
              manageLabel={connection.connected ? "Disconnect" : "Connect"}
              onManage={connection.connected && !connection.tool ? () => gotoEmailSettings("sending") : onOpenConnectors}
            />
            <PostingSettings slug={slug} name={name} canEdit={canEdit} mode={mode} />
            <SettingsSection id={`${slug}-sending`} title={EMAIL_SENDING_COPY.label}>
              <p className="mt-1 text-ca-action text-ca-secondary">{EMAIL_SENDING_COPY.intro}</p>
              <div className="mt-3">
                <EmailSendingSwitch />
              </div>
            </SettingsSection>
          </>
        )}
      />
    </div>
  );
}
