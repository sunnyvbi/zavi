import { StatusBadge } from "@/components/StatusBadge";
import { tierDisplayName } from "@/lib/marketing/pricing";
import { formatRelativeSync } from "@/lib/shopify-app-home/format";
import type { AppHomeChannel, ShopifyAppHome, StatusMode } from "@/lib/shopify-app-home/types";
import { AppHomeCard, AppHomeCardHeader } from "./AppHomeCard";
import { cn } from "@/lib/cn";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

const MODE: Record<StatusMode, { label: string; kind: "live" | "draft" | "neutral" | "advisory" }> = {
  working: { label: "Working", kind: "live" },
  drafting_only: { label: "Drafting only", kind: "draft" },
  idle: { label: "Idle", kind: "neutral" },
  needs_attention: { label: "Needs attention", kind: "advisory" },
};

function connectionLine(shop: ShopifyAppHome["shop"]): string {
  const sync = formatRelativeSync(shop.last_synced_at);
  if (shop.connection === "reconnect_required") return "Shopify needs to be reconnected.";
  if (shop.connection === "stale") return `Sync delayed. Zavi is using data last ${sync}.`;
  if (shop.connection === "syncing") return "Syncing products and orders now.";
  return `Products and orders ${sync} · changes need your approval`;
}

function ChannelChip({ channel }: { channel: AppHomeChannel }) {
  const muted = channel.state !== "connected" && channel.state !== "draft_only";
  const suffix =
    channel.state === "draft_only" ? " (drafts)" :
    channel.state === "plan_locked" ? ` · ${tierDisplayName(channel.locked_tier)} plan` :
    channel.state === "not_connected" ? " · not connected" : "";
  return (
    <span className={cn("rounded-full border px-2.5 py-0.5 text-[12px]", muted ? "border-dashed border-neutral-200 text-neutral-500" : "border-neutral-200 text-neutral-900")}>
      {channel.label}{suffix}
    </span>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span aria-hidden="true" className="mt-0.5 w-4 shrink-0 text-center text-neutral-500">{icon}</span>
      <div className="min-w-0 space-y-0.5">{children}</div>
    </div>
  );
}

export function StatusCard({ data }: { data: ShopifyAppHome }) {
  const mode = MODE[data.status.mode];
  return (
    <AppHomeCard>
      <AppHomeCardHeader title="Status" aside={<StatusBadge kind={mode.kind} label={mode.label} />} />
      <div className="space-y-4 px-4 pb-4 pt-3 text-[13px]">
        <Row icon="✓">
          <p className="text-neutral-900">Store connected: <span className="font-semibold">{data.shop.domain}</span></p>
          <p className="text-neutral-500">{connectionLine(data.shop)}</p>
        </Row>
        <Row icon="▤">
          <p className="font-semibold text-neutral-900">{data.status.headline}</p>
          {data.status.detail && <p className="text-neutral-500">{data.status.detail}</p>}
        </Row>
        <Row icon={<Inbox className="h-4 w-4" />}>
          <p className="text-neutral-900">Growth Channels</p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {data.status.channels.map((c) => <ChannelChip key={c.slug} channel={c} />)}
          </div>
        </Row>
      </div>
    </AppHomeCard>
  );
}
