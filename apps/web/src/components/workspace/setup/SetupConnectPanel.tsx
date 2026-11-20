"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { PhoneBindForm } from "@/app/connectors/PhoneBindForm";
import { isPhoneSurface } from "@/app/connectors/phoneSurfaces";
import { TelegramForm } from "@/app/connectors/TelegramConnectButton";
import { DiscordForm } from "@/app/connectors/DiscordConnectButton";
import { StripeForm } from "@/app/connectors/StripeConnectButton";
import { OperatorDbForm } from "@/app/connectors/OperatorDbConnectButton";
import { PosthogForm } from "@/app/connectors/PosthogConnectForm";
import { SupabaseForm } from "@/app/connectors/SupabaseConnectForm";
import { TeamsConnectForm } from "../settings/TeamsTile";
import { SendgridKeyForm } from "../settings/SendgridKeyForm";
import { MESSAGING, MESSAGING_MORE, TOP_CONNECTORS } from "./setupConnectors";

import { connectorPanelId } from "./connectPanelId";
export { connectorPanelId } from "./connectPanelId";

export function SetupConnectPanel({
  slug,
  teamsConfigured,
  onClose,
  onConnected,
}: {
  slug: string;
  teamsConfigured: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const name = [...MESSAGING, ...MESSAGING_MORE, ...TOP_CONNECTORS].find((connector) => connector.slug === slug)?.name ?? slug;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);

  let form: ReactNode = null;
  if (isPhoneSurface(slug)) form = <PhoneBindForm surface={slug} onClose={onClose} inline />;
  else if (slug === "telegram") form = <TelegramForm onClose={onClose} inline />;
  else if (slug === "discord") form = <DiscordForm onClose={onClose} inline />;
  else if (slug === "stripe") form = <StripeForm onClose={onClose} />;
  else if (slug === "operator_db") form = <OperatorDbForm onClose={onClose} onConnected={onConnected} />;
  else if (slug === "posthog") form = <PosthogForm onClose={onClose} onConnected={onConnected} />;
  else if (slug === "supabase") form = <SupabaseForm onClose={onClose} />;
  else if (slug === "email") form = <SendgridKeyForm onClose={onClose} onConnected={onConnected} />;
  else if (slug === "teams") form = <TeamsConnectForm configured={teamsConfigured} onClose={onClose} inline />;
  if (!form) return null;
  return (
    <div
      ref={panelRef}
      id={connectorPanelId(slug)}
      role="region"
      aria-label={`Connect ${name}`}
      tabIndex={-1}
      className="mt-2 scroll-mt-4 outline-none"
      data-testid={`connect-panel-${slug}`}
    >
      {form}
    </div>
  );
}
