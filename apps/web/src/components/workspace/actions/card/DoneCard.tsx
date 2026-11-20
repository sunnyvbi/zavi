import type { ReactNode } from "react";
import { Download } from "lucide-react";
import type { ActionItem, PlatformSpec } from "../types";
import { mediaOf } from "../types";
import { DoneShell } from "./CardShell";
import { StatusLine } from "./blocks/StatusLine";
import { cardCopyOf, type CardCopy } from "./cardModel";
import { hasStatusBanner, StatusBanner } from "../StatusBanner";
import { approverLine } from "../statusWords";
import { DoneReceipt } from "./DoneReceipt";
import { PostVideoButton } from "../PostVideoButton";
import { cardButton } from "./styles";
import { cn } from "@/lib/cn";

const WHO = { you: "you", autopilot: "Autopilot", teammate: "a teammate", zavi_team: "the Zavi team" } as const;

function approvedLine(a: ActionItem): string | null {
  const ap = a.approval;
  if (!ap) return null;
  const at = new Date(ap.at);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (ap.by === "autopilot") return `Autopilot approved at ${time}`;
  return `Approved by ${ap.by === "teammate" && ap.name ? ap.name : WHO[ap.by]} at ${time}`;
}

export function DoneCard({ a, kind, done, platformName, execCopy, hideActions, inlineStatus, plainStatus, body }: {
  a: ActionItem;
  kind: string;
  done: string;
  platformName: string;
  execCopy?: PlatformSpec["execCopy"];
  hideActions?: boolean;
  inlineStatus?: boolean;
  plainStatus?: boolean;
  body: (copy: CardCopy) => ReactNode;
}) {
  const copy = cardCopyOf(a);
  const line = [(inlineStatus ? null : a.exec_receipt?.line) ?? done, inlineStatus ? approverLine(a.approval) : approvedLine(a)].filter(Boolean).join(" · ");
  const banner = hasStatusBanner(a) && (!inlineStatus || a.exec_status === "failed") ? <StatusBanner a={a} platformName={platformName} execCopy={execCopy} plain={plainStatus} /> : null;
  const media = mediaOf(a);
  return (
    <DoneShell
      id={a.id}
      actionType={a.action_type}
      title={copy.title}
      kind={kind}
      banner={plainStatus ? null : banner}
      status={banner ? (plainStatus ? banner : null) : inlineStatus ? (
        <div data-testid="exec-state" data-exec={a.exec_status ?? "done"} className="flex flex-col gap-1">
          <StatusLine tone={plainStatus ? "muted" : "success"}>{line}</StatusLine>
          <DoneReceipt a={a} platformName={platformName} />
        </div>
      ) : <StatusLine tone="success">{line}</StatusLine>}
    >
      {body(copy)}
      {media?.kind === "video" && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ca-border pt-3">
          {media.artifactId && !hideActions && <PostVideoButton artifactId={media.artifactId} title={a.title} />}
          <a
            href={media.downloadUrl ?? media.url}
            download
            data-testid="video-download"
            className={cn(cardButton.base, media.artifactId ? cardButton.secondary : cardButton.primary)}
          >
            <Download className="size-4" aria-hidden />
            Download video
          </a>
        </div>
      )}
    </DoneShell>
  );
}
