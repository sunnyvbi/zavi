"use client";

import { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { announceFeedbackChanged } from "@/lib/workspace/useMyFeedback";
import { FeedbackRequestList } from "./FeedbackRequestList";

const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_VIDEO_MIMES = new Set(["video/mp4"]);
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_CHARS = 4000;

type Pending = { id: string; name: string; status: "uploading" };
type Done = { id: string; name: string; status: "ready"; path: string };
type Attachment = Pending | Done;

export function FeedbackPanel({
  source = "settings",
  showRequests = false,
}: {
  source?: "settings" | "menu";
  showRequests?: boolean;
}) {
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const uploading = attachments.some((a) => a.status === "uploading");
  const canSubmit = body.trim().length > 0 && !submitting && !uploading;

  async function addFiles(files: FileList | File[]) {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setError(`Up to ${MAX_ATTACHMENTS} attachments.`);
      return;
    }
    for (const file of Array.from(files).slice(0, room)) {
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");
      if (isImage && !ALLOWED_IMAGE_MIMES.has(file.type)) {
        setError(`${file.name}: only PNG, JPEG or WebP images.`);
        continue;
      }
      if (isImage && file.size > MAX_IMAGE_BYTES) {
        setError(`${file.name}: max 5MB per image.`);
        continue;
      }
      if (isVideo && !ALLOWED_VIDEO_MIMES.has(file.type)) {
        setError(`${file.name}: only MP4 video.`);
        continue;
      }
      if (isVideo && file.size > MAX_VIDEO_BYTES) {
        setError(`${file.name}: max 50MB per video.`);
        continue;
      }
      if (!isImage && !isVideo) {
        setError(`${file.name}: attach an image or a video.`);
        continue;
      }

      const id = crypto.randomUUID();
      setAttachments((prev) => [...prev, { id, name: file.name, status: "uploading" }]);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await apiFetch(isImage ? "/api/chat/upload-image" : "/api/chat/upload-video", {
          method: "POST",
          body: form,
        });
        if (!res.ok) throw new Error("upload failed");
        const payload = (await res.json()) as { image_path?: string; video_path?: string };
        const path = payload.image_path ?? payload.video_path;
        if (!path) throw new Error("no path");
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { id, name: file.name, status: "ready", path } : a)),
        );
      } catch {
        setAttachments((prev) => prev.filter((a) => a.id !== id));
        setError(`Couldn’t upload ${file.name}.`);
      }
    }
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/feedback/product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim().slice(0, MAX_CHARS),
          attachments: attachments
            .filter((a): a is Done => a.status === "ready")
            .map((a) => a.path),
          source,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "Couldn’t send that. Try again.");
        return;
      }
      if (showRequests) setJustSent(true);
      else setSent(true);
      setBody("");
      setAttachments([]);
      announceFeedbackChanged();
    } catch {
      setError("Couldn’t send that. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent && !showRequests) {
    return (
      <div className="rounded-xl border border-rule bg-cream p-4">
        <p className="text-[16px] font-medium text-ink">Thanks, we have it.</p>
        <p className="mt-1 text-[13px] text-inkMuted">
          The team reads every one of these.
        </p>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="mt-4 rounded-cta border border-rule bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-creamDeep"
        >
          Send more feedback
        </button>
      </div>
    );
  }

  return (
    <div>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setJustSent(false);
        }}
        maxLength={MAX_CHARS}
        rows={7}
        placeholder="What is working, what is not, what you wish it did instead."
        aria-label="Your feedback"
        className="w-full resize-y rounded-xl border border-rule bg-white px-3.5 py-3 text-[16px] leading-[1.55] text-ink placeholder:text-inkLight focus:border-ink/30 focus:outline-none"
      />

      {attachments.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-rule bg-cream px-2 py-1 text-[13px] text-ink"
            >
              <span className="max-w-[180px] truncate">{a.name}</span>
              {a.status === "uploading" ? (
                <span className="text-inkMuted">uploading…</span>
              ) : (
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="grid h-4 w-4 place-items-center rounded-full text-inkMuted hover:bg-ink/10 hover:text-ink"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,video/mp4,.mp4"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-cta border border-rule bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-creamDeep"
        >
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
          Add image or video
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex items-center rounded-cta border border-transparent bg-ink px-3.5 py-1.5 text-[13px] font-medium text-cream transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? "Sending…" : "Submit"}
        </button>
      </div>

      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      {justSent && !error && (
        <p role="status" className="mt-2 text-[13px] text-ink">
          Sent. It is at the top of your list.
        </p>
      )}
      {showRequests && <FeedbackRequestList />}
    </div>
  );
}
