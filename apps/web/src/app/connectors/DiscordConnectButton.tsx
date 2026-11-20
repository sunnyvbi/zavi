"use client";

import { useState } from "react";
import { ChatConnectCard, CheckStep, MintButton, useChatConnect, expiresLabel } from "./ChatConnectCard";

const LINK_ERRORS: Record<string, string> = {
  discord_disabled: "Discord isn't configured on this workspace yet.",
  forbidden: "Only an owner or admin can connect Discord.",
  link_mint_failed: "Couldn't create a connect code. Try again.",
};

type LinkJson = { connect_command?: string; install_url?: string | null; expires_in?: number };

export function DiscordForm({ onClose, inline }: { onClose: () => void; inline?: boolean }) {
  const { step, data, error, notYet, startLink, checkConnected } = useChatConnect<LinkJson>({
    linkPath: "/api/connectors/discord/link",
    statusPath: "/api/connectors/discord/status",
    errors: LINK_ERRORS,
    accept: (j) => !!j.connect_command,
    autoStart: true,
    pollMs: 3000,
  });
  const [copied, setCopied] = useState(false);
  const command = data?.connect_command ?? "";
  const installUrl = data?.install_url ?? null;

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  }

  return (
    <ChatConnectCard
      title="Connect Discord"
      icon="/logos/discord-icon.svg"
      blurb="Add the bot, then post the code in your server."
      onClose={onClose}
      error={error}
      inline={inline}
    >
      {step === "idle" || step === "linking" ? (
        <MintButton
          step={step}
          onClick={startLink}
          label="Try again"
          busyLabel="Creating code…"
        />
      ) : (
        <ol className="space-y-3">
          <li>
            <div className="text-xs font-medium">1. Add the Zavi bot to your server</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {installUrl ? (
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block rounded-md bg-[#5865F2] px-3 py-2 text-xs font-medium text-white"
                >
                  Add to Discord
                </a>
              ) : null}
              <span className="text-xs text-neutral-500">
                {installUrl
                  ? "Skip this if the bot is already in the server."
                  : "Ask your workspace admin for the bot install link if it isn't in the server yet."}
              </span>
            </div>
          </li>
          <li>
            <div className="text-xs font-medium">2. Post this in any channel of that server</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code
                data-replay-mask=""
                className="select-all rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 font-mono text-xs"
                data-testid="discord-connect-command"
              >
                {command}
              </code>
              <button
                type="button"
                onClick={copyCommand}
                className="rounded-cta px-2 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              Pick the @Zavi entry with the APP badge when Discord autocompletes. One code, one
              server, single use. {expiresLabel(data?.expires_in)} The bot only answers when @mentioned or
              replied to.
            </div>
          </li>
          <CheckStep
            n={3}
            title="Come back here once Discord says “Connected”"
            step={step}
            checkLabel="I've posted it"
            onCheck={checkConnected}
            onRemint={startLink}
            notYet={notYet}
            notYetText="Not connected yet. Post the command in your server first, then try again. If the bot said the code expired, get a new one."
          />
        </ol>
      )}
    </ChatConnectCard>
  );
}
