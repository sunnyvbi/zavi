"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TopActionSpec } from "../platformSpec";
import type { ActionItem } from "../types";
import { cardButton } from "../card/styles";
import { useChannelPlanLock } from "../channelPlanLock";
import { openNewCampaign } from "../managed-campaigns/newCampaignRequest";
import { MetaCampaignHost } from "../managed-campaigns/meta/MetaCampaignHost";
import { openMetaCampaignEditor } from "../managed-campaigns/meta/metaEditorApi";
import { GoogleCampaignHost } from "../managed-campaigns/google/GoogleCampaignHost";
import { openGoogleCampaignEditor } from "../managed-campaigns/google/googleEditorApi";
import { ActionModal, m } from "./ActionModal";
import { CreateMenu } from "./CreateMenu";
import { ChannelHeaderSlot } from "../../layout/ChannelHeaderRow";
import { OnTab } from "../../layout/channelPage";
import { BoostPostModal } from "./BoostPostModal";
import { CreateAdModal } from "./CreateAdModal";
import { FormActionModal } from "./FormActionModal";
import { ScanActionModal } from "./ScanActionModal";
import { useUgcDrawer } from "../../ugc/hub";
import { useWorkspaceOptional } from "../../WorkspaceShell";
import { isMember } from "@/lib/members";
import { CHANNEL_TAB_EVENT, TOP_ACTION_OPEN_EVENT } from "./api";
import { NewTiktokCampaign } from "../tiktok-campaigns/NewTiktokCampaign";
import { TiktokCampaignHost } from "../tiktok-campaigns/TiktokCampaignHost";

export function TopActionsRow({
  slug,
  channelName,
  actions,
  onApprove,
  onChanged,
  onStarted,
  inline,
  trailing,
  leading,
  menu,
  direct,
}: {
  slug: string;
  channelName: string;
  actions: readonly TopActionSpec[] | undefined;
  onApprove?: (a: ActionItem) => void | Promise<unknown>;
  onChanged: () => void;
  onStarted?: () => void;
  inline?: boolean;
  trailing?: ReactNode;
  leading?: ReactNode;
  menu?: string;
  direct?: boolean;
}) {
  const planLock = useChannelPlanLock();
  const drawer = useUgcDrawer();
  const [open, setOpen] = useState<TopActionSpec | null>(null);
  const launchRef = useRef<(a: TopActionSpec) => void>(() => {});
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<{ slug?: string; key?: string }>).detail;
      const action = detail?.slug === slug ? (actions ?? []).find((a) => a.key === detail.key) : undefined;
      if (action) launchRef.current(action);
    };
    window.addEventListener(TOP_ACTION_OPEN_EVENT, on);
    return () => window.removeEventListener(TOP_ACTION_OPEN_EVENT, on);
  }, [slug, actions]);
  const [cannotCreate, setCannotCreate] = useState<TopActionSpec | null>(null);
  const member = isMember(useWorkspaceOptional()?.role ?? null);
  const listed = (actions ?? []).slice(0, 3);
  const shown = member ? listed.filter((a) => !a.ownersOnly) : listed;
  const ownersNotes = member ? [...new Set(listed.flatMap((a) => (a.ownersOnly ? [a.ownersOnly] : [])))] : [];
  if (shown.length === 0 && ownersNotes.length === 0 && !trailing && !leading) return null;
  const tag = planLock?.tierName ?? null;

  const launch = (a: TopActionSpec) => {
    if (tag && planLock) {
      planLock.upgrade();
      return;
    }
    if (a.modal === "google_campaign") {
      openGoogleCampaignEditor("new", slug === "youtube_ads" ? "youtube_ads" : "google_ads");
      return;
    }
    if (a.modal === "chatgpt_campaign") {
      if (!openNewCampaign()) setCannotCreate(a);
      return;
    }
    if (a.modal === "meta_campaign") {
      openMetaCampaignEditor("new");
      return;
    }
    if (a.modal === "drawer" && a.drawer) {
      drawer.open(a.drawer);
      return;
    }
    if (a.modal === "tab" && a.tab) {
      window.dispatchEvent(new CustomEvent(CHANNEL_TAB_EVENT, { detail: { slug, tab: a.tab } }));
      return;
    }
    setOpen(a);
  };
  launchRef.current = launch;

  const controls = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {leading}
      {shown.map((a, i) => (
        <button
          key={a.key}
          type="button"
          data-testid={`top-action-${a.key}`}
          onClick={() => launch(a)}
          className={`${cardButton.base} ${i === 0 ? cardButton.primary : cardButton.secondary}`}
        >
          {a.label}
          {tag && (
            <span className={`rounded px-1 text-[11px] font-semibold ${i === 0 ? "bg-ca-on-action/20" : "bg-ca-subtle"}`}>
              {tag}
            </span>
          )}
        </button>
      ))}
      {trailing}
    </div>
  );

  return (
    <div className={menu || !inline ? "contents" : "ml-auto"} data-testid="channel-top-actions">
      {menu ? (
        shown.length > 0 && (
          <ChannelHeaderSlot>
            <OnTab tab="overview">
              <CreateMenu label={menu} actions={shown} tag={tag} onPick={launch} direct={direct} />
            </OnTab>
          </ChannelHeaderSlot>
        )
      ) : inline ? controls : (
        <ChannelHeaderSlot>
          <OnTab tab="overview">
            {controls}
          </OnTab>
        </ChannelHeaderSlot>
      )}
      {ownersNotes.map((note) => (
        <p key={note} data-testid="top-actions-owners-only" className="mt-2 text-[13px] text-inkMuted">
          {note}
        </p>
      ))}
      {open?.modal === "plan" && (
        <CreateAdModal slug={slug} channelName={channelName} action={open} onClose={() => setOpen(null)} onApprove={onApprove} onChanged={onChanged} onStarted={onStarted} />
      )}
      {open?.modal === "tiktok_campaign" && <NewTiktokCampaign onClose={() => setOpen(null)} onChanged={onChanged} />}
      {slug === "tiktok_ads" && <TiktokCampaignHost onChanged={onChanged} />}
      {open?.modal === "form" && (
        <FormActionModal slug={slug} channelName={channelName} action={open} onClose={() => setOpen(null)} onChanged={onChanged} onStarted={onStarted} />
      )}
      {shown.some((a) => a.modal === "google_campaign") && <GoogleCampaignHost onChanged={onChanged} channel={slug === "youtube_ads" ? "youtube_ads" : "google_ads"} />}
      {open?.modal === "scan" && <ScanActionModal slug={slug} channelName={channelName} action={open} onClose={() => setOpen(null)} />}
      {shown.some((a) => a.modal === "meta_campaign") && <MetaCampaignHost onChanged={onChanged} />}
      {open?.modal === "boost_post" && <BoostPostModal channelName={channelName} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {cannotCreate && (
        <ActionModal
          eyebrow={channelName}
          title={cannotCreate.label}
          sub="Zavi opens your campaign editor from the campaign list on this page."
          size="md"
          onClose={() => setCannotCreate(null)}
          footer={
            <button type="button" className={m.primary} onClick={() => setCannotCreate(null)}>
              OK
            </button>
          }
        >
          <p className={m.note}>Your campaign list has not loaded, or this account cannot create a campaign yet. Check the account and wallet on the Settings tab, then try again.</p>
        </ActionModal>
      )}
    </div>
  );
}
