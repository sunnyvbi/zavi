"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { datetimeLocalToFutureIso, toDatetimeLocal } from "@/lib/datetimeLocal";

type ChannelOption = {
  id: string;
  label: string;
  needsImage?: boolean;
  needsVideo?: boolean;
  needsRedditMeta?: boolean;
  needsTitle?: boolean;
};

const CHANNELS: ChannelOption[] = [
  { id: "linkedin", label: "LinkedIn (text)" },
  { id: "linkedin_image", label: "LinkedIn (image)", needsImage: true },
  { id: "x", label: "X (text)" },
  { id: "x_image", label: "X (image)", needsImage: true },
  { id: "x_video", label: "X (video)", needsVideo: true },
  { id: "instagram_image", label: "Instagram (image)", needsImage: true },
  { id: "reddit", label: "Reddit", needsRedditMeta: true },
  { id: "youtube_video", label: "YouTube (video)", needsVideo: true, needsTitle: true },
  { id: "tiktok_video", label: "TikTok (video)", needsVideo: true },
];

type Props = {
  open: boolean;
  onClose: () => void;
  initialCaption: string;
  imagePath: string | null;
  videoPath?: string | null;
  onProposed?: (decisionId: string) => void;
};

export function ProposePostModal({
  open,
  onClose,
  initialCaption,
  imagePath,
  videoPath = null,
  onProposed,
}: Props) {
  const [caption, setCaption] = useState(initialCaption);
  const [subreddit, setSubreddit] = useState("");
  const [title, setTitle] = useState("");
  const [privacy, setPrivacy] = useState("public");
  const [channel, setChannel] = useState("linkedin");
  const [scheduledAt, setScheduledAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);

  const availableChannels = useMemo(
    () =>
      CHANNELS.filter((c) => {
        if (c.needsImage && !imagePath) return false;
        if (c.needsVideo && !videoPath) return false;
        return true;
      }),
    [imagePath, videoPath],
  );

  const selected = availableChannels.find((c) => c.id === channel) ?? availableChannels[0];

  useEffect(() => {
    if (!open) return;
    setCaption(initialCaption);
    setScheduledAt("");
    setError(null);
    setSuccessId(null);
    setBusy(false);
    const defaultChannel = videoPath
      ? "youtube_video"
      : imagePath
        ? "linkedin_image"
        : availableChannels[0]?.id ?? "linkedin";
    setChannel(defaultChannel);
  }, [open, initialCaption, imagePath, videoPath, availableChannels]);

  if (!open) return null;

  async function submit() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      let payload: Record<string, unknown>;
      if (selected.id === "reddit") {
        payload = {
          subreddit: subreddit.trim(),
          title: title.trim(),
          text: caption.trim(),
        };
      } else if (selected.needsImage) {
        if (!imagePath) {
          setError("An image is required for image posts.");
          setBusy(false);
          return;
        }
        payload = { text: caption.trim(), image_path: imagePath };
      } else if (selected.id === "youtube_video") {
        if (!videoPath) {
          setError("A video is required for YouTube uploads.");
          setBusy(false);
          return;
        }
        payload = { title: title.trim(), text: caption.trim(), video_path: videoPath, privacy };
      } else if (selected.needsVideo) {
        if (!videoPath) {
          setError("A video is required for video posts.");
          setBusy(false);
          return;
        }
        payload = { text: caption.trim(), video_path: videoPath };
      } else {
        payload = { text: caption.trim() };
      }

      let scheduledIso: string | null = null;
      if (scheduledAt.trim()) {
        const parsedTime = datetimeLocalToFutureIso(scheduledAt);
        if ("error" in parsedTime) {
          setError(parsedTime.error);
          setBusy(false);
          return;
        }
        scheduledIso = parsedTime.iso;
      }

      const res = await apiFetch("/api/social/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: selected.id,
          payload,
          scheduled_at: scheduledIso,
        }),
        idempotent: true,
      });
      const data = (await res.json()) as {
        ok?: boolean;
        decision_id?: string;
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(data.error?.message ?? "Couldn't stage the post.");
        return;
      }
      const id = data.decision_id ?? null;
      setSuccessId(id);
      if (id) onProposed?.(id);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="propose-post-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-ink/10 bg-white p-4 shadow-lg">
        <h2 id="propose-post-title" className="text-[14px] font-semibold text-ink">
          Propose social post
        </h2>
        <p className="mt-1 text-[13px] text-inkMuted">
          Stages a post for your approval. Nothing publishes until you approve it.
        </p>

        {successId ? (
          <div className="mt-4 space-y-3">
            <p className="text-[13px] text-emerald-700">
              Post staged. Review and approve it in{" "}
              <a href="/workspace?tab=channels" className="font-medium underline">
                Channels
              </a>
              .
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-cta bg-ink px-4 py-2 text-[13px] font-medium text-white hover:bg-inkSoft"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block text-[14px] font-medium text-ink">
              Channel
              <select
                value={selected?.id ?? ""}
                onChange={(e) => setChannel(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-[13px]"
              >
                {availableChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            {selected?.needsRedditMeta && (
              <label className="block text-[14px] font-medium text-ink">
                Subreddit (no r/ prefix)
                <input
                  value={subreddit}
                  onChange={(e) => setSubreddit(e.target.value)}
                  placeholder="startups"
                  className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-[13px]"
                />
              </label>
            )}

            {(selected?.needsRedditMeta || selected?.needsTitle) && (
              <label className="block text-[14px] font-medium text-ink">
                Title
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={selected?.id === "youtube_video" ? 100 : 300}
                  className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-[13px]"
                />
              </label>
            )}

            {selected?.id === "youtube_video" && (
              <label className="block text-[14px] font-medium text-ink">
                Visibility
                <select
                  value={privacy}
                  onChange={(e) => setPrivacy(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-[13px]"
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </label>
            )}

            <label className="block text-[14px] font-medium text-ink">
              {selected?.id === "youtube_video" ? "Description" : "Caption"}
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                rows={4}
                className="mt-1 w-full resize-y rounded-lg border border-ink/15 px-3 py-2 text-[13px]"
              />
            </label>

            <label className="block text-[14px] font-medium text-ink">
              Schedule for (optional)
              <input
                type="datetime-local"
                value={scheduledAt}
                min={toDatetimeLocal(new Date())}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-[13px]"
              />
              <span className="mt-1 block text-[12px] font-normal text-inkMuted">
                Leave empty to publish as soon as you approve.
              </span>
            </label>

            {imagePath && selected?.needsImage && (
              <p className="text-[12px] text-inkMuted">
                Image attached. The preview is shown on the approval card.
              </p>
            )}
            {videoPath && selected?.needsVideo && (
              <p className="text-[12px] text-inkMuted">
                Video attached. It uploads to your channel on approval.
              </p>
            )}

            {error && (
              <p role="alert" className="text-[13px] text-coral">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-cta border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-bone disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !caption.trim() || (selected?.needsTitle && !title.trim())}
                className="rounded-cta bg-ink px-4 py-2 text-[13px] font-medium text-white hover:bg-inkSoft disabled:opacity-50"
              >
                {busy ? "Staging…" : "Propose post"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
