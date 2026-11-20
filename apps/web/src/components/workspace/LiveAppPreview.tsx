"use client";

import { useLiveAppUrl } from "@/lib/workspace/useLiveAppUrl";
import type { ChatRow } from "@/lib/workspace/useChatThread";
import { AppPreviewFrame } from "./home/AppPreviewFrame";

const BUILDS_TOOL = "list_product_builds";

export function runCheckedProductBuilds(rows: ChatRow[] | undefined | null): boolean {
  if (!rows) return false;
  return rows.some((r) => {
    const body = (r.body ?? {}) as Record<string, unknown>;
    if (String(body.teKind ?? "") !== "tool_call") return false;
    const name = body.tool_name;
    return typeof name === "string" && name.includes(BUILDS_TOOL);
  });
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function LiveAppPreview({
  activity,
  threadId,
}: {
  activity?: ChatRow[];
  threadId?: string | null;
}) {
  const checked = runCheckedProductBuilds(activity);
  const runId = activity?.find((r) => r.agent_run_id)?.agent_run_id ?? null;
  const live = useLiveAppUrl(checked, threadId, runId);

  if (!checked || !live?.url) return null;

  return (
    <div className="mt-2 rounded-2xl border border-rule bg-white p-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15"
        />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold leading-5 text-ink">Your app is live</p>
          <p className="truncate text-[12px] leading-4 text-inkMuted">{hostLabel(live.url)}</p>
        </div>
      </div>
      <AppPreviewFrame liveUrl={live.url} />
    </div>
  );
}
