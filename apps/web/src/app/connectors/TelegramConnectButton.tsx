"use client";

import {
  ChatConnectCard,
  CheckStep,
  ConnectQR,
  MintButton,
  useChatConnect, expiresLabel } from "./ChatConnectCard";

const LINK_ERRORS: Record<string, string> = {
  telegram_disabled: "Telegram isn't configured on this workspace yet.",
  telegram_username_missing: "Telegram isn't fully configured on this workspace yet.",
  forbidden: "Only an owner or admin can connect Telegram.",
  link_mint_failed: "Couldn't create a connect link. Try again.",
};

type LinkJson = { dm_url?: string; group_url?: string; expires_in?: number };

export function TelegramForm({ onClose, inline }: { onClose: () => void; inline?: boolean }) {
  const { step, data, error, notYet, startLink, checkConnected } = useChatConnect<LinkJson>({
    linkPath: "/api/connectors/telegram/link",
    statusPath: "/api/connectors/telegram/status",
    errors: LINK_ERRORS,
    accept: (j) => !!j.dm_url && !!j.group_url,
    autoStart: true,
    pollMs: 3000,
  });

  return (
    <ChatConnectCard
      title="Connect Telegram"
      icon="/logos/telegram-icon.svg"
      blurb="Tap a link from the Telegram account you want to connect."
      onClose={onClose}
      error={error}
      inline={inline}
    >
      {step === "idle" || step === "linking" ? (
        <MintButton step={step} onClick={startLink} label="Try again" busyLabel="Creating link…" />
      ) : (
        <ol className="space-y-3">
          <li>
            <div className="text-xs font-medium">1. Open one of these in Telegram</div>
            <div className="mt-1 flex flex-wrap gap-2">
              <a
                href={data?.dm_url}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded-md bg-[#26A5E4] px-3 py-2 text-xs font-medium text-white"
              >
                Connect my DM
              </a>
              <a
                href={data?.group_url}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded-md border border-[#26A5E4] px-3 py-2 text-xs font-medium text-[#26A5E4]"
              >
                Connect a group
              </a>
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              One link, one chat, single use. {expiresLabel(data?.expires_in)} In a group the bot only answers
              when @mentioned or replied to.
            </div>
            {data?.dm_url ? (
              <ConnectQR
                value={data.dm_url}
                caption="No Telegram on this computer? Scan with your phone to connect your DM. (Group needs the button.)"
              />
            ) : null}
          </li>
          <CheckStep
            n={2}
            title="Come back here once Telegram says “Connected”"
            step={step}
            checkLabel="I've tapped it"
            onCheck={checkConnected}
            onRemint={startLink}
            notYet={notYet}
            notYetText="Not connected yet. Tap the link in Telegram first, then try again. If Telegram said the link expired, get a new one."
          />
        </ol>
      )}
    </ChatConnectCard>
  );
}
