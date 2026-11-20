"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { channelMark } from "../../channelMark";
import { cardButton } from "../../actions/card/styles";
import { SettingsSection } from "./SettingsSection";

function Mark({ slug, logo }: { slug: string; logo?: string }) {
  const mark = logo ? { kind: "logo" as const, src: logo } : channelMark(slug);
  return (
    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-ca-strong bg-white">
      {mark.kind === "logo" ? (
        <img src={mark.src} alt="" className="size-6 rounded object-contain" />
      ) : (
        <span className={cn("flex size-6 items-center justify-center rounded", mark.bg)}>
          <mark.Icon className={cn("size-4", mark.fg)} />
        </span>
      )}
    </span>
  );
}

export function ConnectionSection({ slug, name, logo, connected, account, onManage, manageLabel, pending = false, disabled = false }: {
  slug: string;
  name: string;
  logo?: string;
  connected: boolean;
  account: string | null;
  onManage: () => void;
  manageLabel?: string;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <SettingsSection id={`${slug}-connection`} title="Connection">
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Mark slug={slug} {...(logo ? { logo } : {})} />
        <span className="min-w-0 flex-1">
          <span className="block text-ca-facts font-semibold text-ca-xdark">{name}</span>
          <span className="flex items-center gap-1.5 text-ca-action text-ca-secondary">
            {pending ? "Checking…" : connected ? <><Check className="size-4 shrink-0" aria-hidden />{account ? `Connected to ${account}` : "Connected"}</> : "Not connected yet"}
          </span>
        </span>
        <button type="button" onClick={onManage} disabled={disabled} className={cn(cardButton.base, cardButton.secondary)}>
          {manageLabel ?? (connected ? "Manage" : "Connect")}
        </button>
      </div>
    </SettingsSection>
  );
}
