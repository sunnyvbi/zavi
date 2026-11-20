"use client";

import { useEffect, useState } from "react";
import { socialLimit, xWeightedLength, instagramSnapshotMatchesConnection } from "@zavi/shared";
import { startConnectFlow } from "@/app/connectors/ConnectButton";
import { startComposioConnect } from "@/app/connectors/composioConnect";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { formatScheduledAt } from "@/app/approvals/approvalsHelpers";
import { Pill } from "./agent/dashboard-ui";
import {
  SOCIAL_ROW_SLUGS,
  socialAccountName,
  socialConnectorRow,
  socialConnectorSlug,
  socialPlatformLabel,
  type SocialSlug,
} from "./settings/socialConnectorRows";

type Props = {
  channel: string;
  payload: Record<string, unknown>;
  scheduledAt?: unknown;
  onEdit?: (next: { text: string; thread?: string[] }) => void;
  chrome?: boolean;
  readiness?: unknown;
  recheck?: boolean;
};

type ReadinessCheck = { status?: string; reason?: string };

const PIN_CHECKS: Array<{ key: "board" | "media" | "link" | "identity"; label: string }> = [
  { key: "board", label: "Board" },
  { key: "media", label: "Image" },
  { key: "link", label: "Link" },
  { key: "identity", label: "Your site" },
];

function pinCheckRows(readiness: unknown): Array<{ label: string; status: string; reason: string | null }> {
  if (!readiness || typeof readiness !== "object") return [];
  const checks = (readiness as { checks?: Record<string, ReadinessCheck> }).checks;
  if (!checks || typeof checks !== "object") return [];
  return PIN_CHECKS.flatMap(({ key, label }) => {
    const c = checks[key];
    if (!c || typeof c.status !== "string" || c.status === "skipped") return [];
    return [{ label, status: c.status, reason: typeof c.reason === "string" ? c.reason : null }];
  });
}

const CHECK_WORD: Record<string, string> = { pass: "Checked", fail: "Problem", unverified: "Not checked" };

const IMAGE_CHANNELS = new Set(["linkedin_image", "instagram_image", "x_image", "pinterest_pin"]);

function PlatformIcon({ slug }: { slug: SocialSlug | null }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": true, fill: "currentColor" };
  switch (slug) {
    case "linkedin_social":
      return (
        <svg {...common}>
          <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm7 0h3.8v1.7h.1c.5-1 1.8-2 3.7-2 4 0 4.7 2.6 4.7 6V21h-4v-5.3c0-1.3 0-2.9-1.8-2.9s-2 1.4-2 2.8V21h-4V9Z" />
        </svg>
      );
    case "x_social":
      return (
        <svg {...common}>
          <path d="M17.5 3h3l-7 8 8.2 10h-6.4l-5-6.5L4.6 21h-3l7.5-8.6L1.3 3h6.6l4.5 6L17.5 3Zm-1.1 16.2h1.7L6.7 4.7H4.9l11.5 14.5Z" />
        </svg>
      );
    case "reddit_social":
      return (
        <svg {...common}>
          <path d="M22 12.1a2.2 2.2 0 0 0-3.7-1.6c-1.5-1-3.5-1.7-5.7-1.8l1-4.5 3.1.7a1.6 1.6 0 1 0 .2-1l-3.5-.8a.5.5 0 0 0-.6.4l-1.1 5.2c-2.2.1-4.3.7-5.8 1.8A2.2 2.2 0 1 0 3.5 14c0 .2-.1.4-.1.6 0 3.2 3.8 5.9 8.5 5.9s8.5-2.6 8.5-5.9l-.1-.6c.9-.4 1.7-1.1 1.7-1.9ZM7 13.6a1.6 1.6 0 1 1 3.2 0 1.6 1.6 0 0 1-3.2 0Zm8.7 4.2c-1.1 1.1-3.2 1.2-3.8 1.2s-2.7-.1-3.8-1.2a.4.4 0 0 1 .6-.6c.7.7 2.2.9 3.2.9s2.5-.2 3.2-.9a.4.4 0 0 1 .6.6Zm-.3-2.6a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z" />
        </svg>
      );
    case "instagram_social":
      return (
        <svg {...common}>
          <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4ZM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM12 2c-2.7 0-3 0-4.1.1-2.9.1-4.7 1.9-4.8 4.8C3 8 3 8.3 3 11v2c0 2.7 0 3 .1 4.1.1 2.9 1.9 4.7 4.8 4.8 1.1.1 1.4.1 4.1.1s3 0 4.1-.1c2.9-.1 4.7-1.9 4.8-4.8.1-1.1.1-1.4.1-4.1v-2c0-2.7 0-3-.1-4.1-.1-2.9-1.9-4.7-4.8-4.8C15 2 14.7 2 12 2Zm0 1.8c2.7 0 3 0 4 .1 2 .1 3 1 3.1 3.1.1 1 .1 1.3.1 4v2c0 2.7 0 3-.1 4-.1 2-1 3-3.1 3.1-1 .1-1.3.1-4 .1s-3 0-4-.1c-2-.1-3-1-3.1-3.1-.1-1-.1-1.3-.1-4v-2c0-2.7 0-3 .1-4 .1-2 1-3 3.1-3.1 1-.1 1.3-.1 4-.1Z" />
        </svg>
      );
    case "composio.youtube":
      return (
        <svg {...common}>
          <path d="M23 7.2a2.9 2.9 0 0 0-2-2C19.2 4.7 12 4.7 12 4.7s-7.2 0-9 .5a2.9 2.9 0 0 0-2 2C.5 9 .5 12 .5 12s0 3 .5 4.8a2.9 2.9 0 0 0 2 2c1.8.5 9 .5 9 .5s7.2 0 9-.5a2.9 2.9 0 0 0 2-2c.5-1.8.5-4.8.5-4.8s0-3-.5-4.8ZM9.7 15.1V8.9l6 3.1-6 3.1Z" />
        </svg>
      );
    default:
      return null;
  }
}

function Counter({ n, cap }: { n: number; cap: number }) {
  const over = n > cap;
  return (
    <span className={`text-[11px] tabular-nums ${over ? "text-coral font-medium" : "text-inkMuted"}`}>
      {n} / {cap}
    </span>
  );
}

export function PostPreview({ channel, payload, scheduledAt, onEdit, chrome = true, readiness, recheck = false }: Props) {
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const text = onEdit ? rawText : rawText.trim();
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const imagePath = typeof payload.image_path === "string" ? payload.image_path : null;
  const videoPath = typeof payload.video_path === "string" ? payload.video_path : null;
  const subreddit = typeof payload.subreddit === "string" ? payload.subreddit : null;
  const boardName = typeof payload.board_name === "string" ? payload.board_name : null;
  const pinLink = typeof payload.link === "string" ? payload.link : null;
  const limit = socialLimit(channel);
  const slug = socialConnectorSlug(channel);
  const label = socialPlatformLabel(channel);
  const when = formatScheduledAt(scheduledAt);

  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [account, setAccount] = useState<{ connected: boolean; name: string | null } | null>(null);

  useEffect(() => {
    if (!IMAGE_CHANNELS.has(channel) || !imagePath) {
      setSignedUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/chat/image-url?path=${encodeURIComponent(imagePath)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { signed_url?: string };
        if (!cancelled && data.signed_url) setSignedUrl(data.signed_url);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, imagePath]);

  useEffect(() => {
    setAccount(null);
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled || !tenantId) return;
        const res = await sb
          .from("connector_metadata")
          .select("slug, team_name, team_id, connected_at")
          .eq("tenant_id", tenantId)
          .in("slug", SOCIAL_ROW_SLUGS as string[]);
        if (cancelled || res.error) return;
        const acct = socialAccountName(channel, res.data ?? []);
        const ig = socialConnectorRow(channel, res.data ?? []);
        const nativeBackup = (res.data ?? []).some((r) => r.slug === "instagram_social");
        if (acct.connected && !acct.name && !nativeBackup && ig?.slug === "composio.instagram" && channel.startsWith("instagram")) {
          const snap = await sb
            .from("social_account_snapshots")
            .select("username, created_at, connection_id")
            .eq("tenant_id", tenantId)
            .eq("channel", "instagram")
            .order("captured_on", { ascending: false })
            .limit(1)
            .maybeSingle();
          const s = snap.data as { username: string | null; created_at: string; connection_id?: string | null } | null;
          if (!snap.error && s?.username && instagramSnapshotMatchesConnection(s, ig)) acct.name = `@${s.username}`;
        }
        if (!cancelled) setAccount(acct);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, slug]);

  const cap = limit?.text ?? null;
  const isX = channel === "x" || channel === "x_image" || channel === "x_video";
  const count = isX && cap !== null ? xWeightedLength(text, cap) : null;
  const shown = count ? count.length : text.length;
  const overflowAt =
    cap === null ? null : count ? count.cutAt : text.length > cap ? cap : null;
  const thread = isX && Array.isArray(payload.thread)
    ? (payload.thread as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const linkHost = (() => {
    const m = (pinLink ?? text).match(/https?:\/\/([^\s/]+)/);
    if (!m) return null;
    return m[1].replace(/^www\./, "");
  })();
  const [connecting, setConnecting] = useState(false);
  const isPin = channel === "pinterest_pin";
  const pinChecks = isPin ? pinCheckRows(readiness).filter((c) => !recheck || c.label === "Image") : [];

  return (
    <div className={chrome ? "mt-3 rounded-xl border border-ca-border bg-ca-bg" : ""}>
      {chrome && <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <span className="text-ink"><PlatformIcon slug={slug} /></span>
        <span className="text-[12px] font-semibold text-ink">{label}</span>
        {account?.name && <span className="text-[12px] text-inkMuted">· {account.name}</span>}
        {subreddit && <span className="text-[12px] text-inkMuted">· r/{subreddit}</span>}
        {boardName && <span className="text-[12px] text-inkMuted">· board {boardName}</span>}
        <span className="ml-auto">
          {account && !account.connected && slug && (
            <button
              type="button"
              disabled={connecting}
              onClick={async () => {
                setConnecting(true);
                try {
                  if (slug.startsWith("composio.")) await startComposioConnect(slug.slice("composio.".length));
                  else await startConnectFlow(slug);
                } catch {
                  setConnecting(false);
                }
              }}
              className="rounded-full border border-coral/40 bg-coral/10 px-2 py-0.5 text-[11px] font-medium text-coral hover:bg-coral/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-60"
            >
              {connecting ? "Connecting…" : `Not connected · Connect ${label}`}
            </button>
          )}
        </span>
      </div>}

      {isPin && !onEdit ? (
        <div className={`flex gap-4 ${chrome ? "px-3 py-3" : "pt-3"}`}>
          {signedUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={signedUrl}
              alt={title ? `Pin image: ${title}` : "Pin image"}
              className="aspect-[2/3] w-24 shrink-0 rounded-xl bg-bone object-cover ring-1 ring-rule sm:w-28"
            />
          ) : (
            imagePath && <div aria-hidden className="aspect-[2/3] w-24 shrink-0 rounded-xl bg-bone sm:w-28" />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            {title && <p className="text-[16px] font-semibold leading-snug text-ink">{title}</p>}
            {text && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[14px] leading-relaxed text-inkMuted">{text}</p>}
            {overflowAt !== null && (
              <p className="mt-1 text-[11px] text-coral" role="alert">
                {`Text after ${overflowAt} characters will be cut: ${label} allows ${cap} characters.`}
              </p>
            )}
            {((!chrome && boardName) || pinLink) && (
              <dl className="mt-3 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[13px]">
                {!chrome && boardName && (
                  <>
                    <dt className="text-inkMuted">Board</dt>
                    <dd className="truncate text-ink">{boardName}</dd>
                  </>
                )}
                {pinLink && (
                  <>
                    <dt className="text-inkMuted">Link</dt>
                    <dd className="truncate">
                      <a href={pinLink} target="_blank" rel="noopener noreferrer" title={pinLink} className="text-ink underline-offset-2 hover:underline">
                        {linkHost ?? pinLink}
                      </a>
                    </dd>
                  </>
                )}
              </dl>
            )}
            {!chrome && when && (
              <p className="mt-3 text-[12px] text-inkMuted">Posts to Pinterest {when}, once you approve</p>
            )}
            {pinChecks.length > 0 && pinChecks.every((c) => c.status === "pass") ? (
              <ul aria-label="Pinterest checks" className="mt-3 flex list-none p-0">
                <li
                  title={pinChecks.map((c) => `${c.label} checked`).join(" · ")}
                  className="inline-flex items-center gap-1 rounded-full bg-ca-success-bg px-2.5 py-0.5 text-ca-eyebrow font-medium text-ca-success"
                >
                  <span aria-hidden>✓</span> Ready to post
                  <span className="sr-only"> · {pinChecks.map((c) => `${c.label} · ${CHECK_WORD[c.status]}`).join(", ")}</span>
                </li>
              </ul>
            ) : (
              pinChecks.length > 0 && (
                <ul aria-label="Pinterest checks" className="mt-3 flex list-none flex-wrap gap-1.5 p-0">
                  {pinChecks.map((c) => (
                    <li
                      key={c.label}
                      title={c.status !== "pass" && c.reason ? c.reason : undefined}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-ca-eyebrow font-medium ${
                        c.status === "pass" ? "bg-ca-success-bg text-ca-success" : c.status === "fail" ? "bg-ca-subtle text-ca-danger" : "bg-ca-subtle text-ca-secondary"
                      }`}
                    >
                      <span aria-hidden>{c.status === "pass" ? "✓" : c.status === "fail" ? "!" : "?"}</span>
                      {c.label}
                      <span className="sr-only"> · {CHECK_WORD[c.status] ?? c.status}</span>
                    </li>
                  ))}
                </ul>
              )
            )}
            {pinChecks
              .filter((c) => c.status !== "pass" && c.reason)
              .map((c) => (
                <p key={`${c.label}-why`} className={`mt-1.5 text-[12px] ${c.status === "fail" ? "text-ca-danger" : "text-ca-secondary"}`}>
                  {c.label}: {c.reason}
                </p>
              ))}
          </div>
        </div>
      ) : (
      <div className="space-y-2 px-3 py-3">
        {title && (
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[13px] font-semibold text-ink">{title}</p>
            {limit?.title && <Counter n={title.length} cap={limit.title} />}
          </div>
        )}
        {videoPath && (
          <p className="text-[12px] text-inkMuted">
            Video attached · {videoPath.split("/").pop()}
            {typeof payload.privacy === "string" ? ` · ${payload.privacy}` : ""}
          </p>
        )}
        {signedUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={signedUrl} alt="" className="max-h-64 w-full rounded-md bg-bone object-contain" />
        )}
        {onEdit && (
          <textarea
            aria-label="Post text"
            value={text}
            rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
            onChange={(e) => onEdit({ text: e.target.value, ...(thread.length ? { thread } : {}) })}
            className="w-full resize-y rounded-md border border-rule bg-bone/40 px-2 py-1.5 text-[13px] leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          />
        )}
        {onEdit && isPin && cap !== null && (
          <div className="flex justify-end">
            <Counter n={shown} cap={cap} />
          </div>
        )}
        {!onEdit && text && (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
            {overflowAt === null ? (
              text
            ) : (
              <>
                {text.slice(0, overflowAt)}
                <span className="bg-coral/10 text-coral" data-testid="overflow">
                  {text.slice(overflowAt)}
                </span>
              </>
            )}
          </p>
        )}
        {overflowAt !== null && (
          <p className="text-[11px] text-coral" role="alert">
            {isX
              ? `Over X's limit. X counts a link as 23 and an emoji as 2, so this reads ${shown} of ${cap}.`
              : channel === "instagram_image"
                ? `Shorten the caption to ${cap} characters before approving. It will not be cut automatically.`
                : `Text after ${overflowAt} characters will be cut: ${label} allows ${cap} characters.`}
          </p>
        )}
        {thread.length > 0 && (
          <ol className="space-y-1.5 border-l-2 border-rule pl-3" aria-label="Thread parts">
            {thread.map((part, i) => {
              const c = cap !== null ? xWeightedLength(part, cap) : null;
              return (
                <li key={i} className="text-[13px] leading-relaxed text-ink">
                  <span className="mr-1.5 text-[11px] tabular-nums text-inkMuted">
                    {i + 2}/{thread.length + 1}
                  </span>
                  {onEdit ? (
                    <textarea
                      aria-label={`Thread part ${i + 2}`}
                      value={part}
                      rows={2}
                      onChange={(e) => {
                        const nextThread = thread.slice();
                        nextThread[i] = e.target.value;
                        onEdit({ text, thread: nextThread });
                      }}
                      className="mt-1 w-full resize-y rounded-md border border-rule bg-bone/40 px-2 py-1 text-[13px] leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                    />
                  ) : (
                    <span className="whitespace-pre-wrap">{part}</span>
                  )}
                  {c && cap !== null && (
                    <span className="ml-2">
                      <Counter n={c.length} cap={cap} />
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {pinLink ? (
          <p className="break-all text-[12px] text-inkMuted">Links to {pinLink}</p>
        ) : (
          linkHost && <p className="text-[12px] text-inkMuted">Links to {linkHost}</p>
        )}
        {pinChecks.length > 0 && (
          <ul aria-label="Pinterest checks" className="space-y-0.5">
            {pinChecks.map((c) => (
              <li key={c.label} className={`text-[12px] ${c.status === "fail" ? "text-ca-danger" : "text-ca-secondary"}`}>
                {c.label} · {CHECK_WORD[c.status] ?? c.status}
                {c.status !== "pass" && c.reason ? ` · ${c.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
        {recheck && <p className="text-[12px] text-inkMuted">Zavi checks the new board and link again when you approve.</p>}
      </div>
      )}

      {(chrome || (onEdit && !isPin) || thread.length > 0 || limit?.vendor_review_pending || (cap !== null && overflowAt !== null)) && (
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${chrome ? "border-t border-rule" : ""}`}>
        {chrome && (
          <span className="text-[12px] text-inkMuted">
            {isPin
              ? when
                ? `Posts to Pinterest ${when}, once you approve`
                : `Posts to Pinterest${account?.name ? ` from ${account.name}` : ""} when you approve`
              : when
                ? `Staged for your approval · publishes ${when}`
                : `Publishes${account?.name ? ` from ${account.name}` : ""} when you approve`}
          </span>
        )}
        {thread.length > 0 && (
          <span className="text-[11px] text-inkMuted">Thread · {thread.length + 1} posts</span>
        )}
        {cap !== null && (isPin ? !onEdit && overflowAt !== null : chrome || onEdit) && <Counter n={shown} cap={cap} />}
        {limit?.vendor_review_pending && (
          <span className="ml-auto">
            <Pill tone="warn">Awaiting {limit.vendor_review_pending}</Pill>
          </span>
        )}
      </div>
      )}
    </div>
  );
}
