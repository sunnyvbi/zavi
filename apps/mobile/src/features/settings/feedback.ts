import { File } from "expo-file-system";
import { useMutation } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { uploadChatFile, type PickedImage } from "../agents/uploadImage";

export const MAX_FEEDBACK_ATTACHMENTS = 5;
export const MAX_FEEDBACK_CHARS = 4000;

export type FeedbackAttachmentKind = "image" | "video";

type BaseAttachment = {
  id: string;
  kind: FeedbackAttachmentKind;
  name: string;
  uri: string;
  sizeLabel: string;
};

export type FeedbackAttachment =
  | (BaseAttachment & { status: "uploading" })
  | (BaseAttachment & { status: "ready"; path: string });

export function makeFeedbackAttachment(
  kind: FeedbackAttachmentKind,
  file: PickedImage,
): Extract<FeedbackAttachment, { status: "uploading" }> {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    name: file.name,
    uri: file.uri,
    sizeLabel: sizeLabel(file.uri),
    status: "uploading",
  };
}

export function uploadFeedbackAttachment(
  a: FeedbackAttachment,
): Promise<string> {
  return a.kind === "image"
    ? uploadChatFile(a.uri, "/api/chat/upload-image", "image_path")
    : uploadChatFile(a.uri, "/api/chat/upload-video", "video_path");
}

export function readyFeedbackPaths(
  attachments: FeedbackAttachment[],
): string[] {
  return attachments
    .filter(
      (a): a is Extract<FeedbackAttachment, { status: "ready" }> =>
        a.status === "ready",
    )
    .map((a) => a.path);
}

export function hasFeedbackUploads(attachments: FeedbackAttachment[]): boolean {
  return attachments.some((a) => a.status === "uploading");
}

export function normalizeFeedbackPickError(message: string): string {
  const withoutSkipping = message.replace(/^Skipping\s+/, "");
  const imageType = withoutSkipping.replace(
    ": only PNG/JPEG/WebP allowed.",
    ": only PNG, JPEG or WebP images.",
  );
  const videoLimit = imageType.match(
    /^(.+) is over 50MB\. Pick a shorter video\.$/,
  );
  return videoLimit ? `${videoLimit[1]}: max 50MB per video.` : imageType;
}

export function useSubmitFeedback() {
  return useMutation({
    mutationFn: (input: {
      body: string;
      attachments: string[];
      source?: "settings" | "menu";
    }) =>
      apiJson<{ ok: true; feedback_id: string }>("/api/feedback/product", {
        method: "POST",
        body: JSON.stringify({
          body: input.body.trim().slice(0, MAX_FEEDBACK_CHARS),
          attachments: input.attachments,
          source: input.source ?? "settings",
        }),
      }),
  });
}

function sizeLabel(uri: string): string {
  try {
    const f = new File(uri);
    if (!f.exists || f.size <= 0) return "";
    if (f.size >= 1024 * 1024)
      return `${trimNumber(f.size / (1024 * 1024))} MB`;
    return `${Math.max(1, Math.round(f.size / 1024))} KB`;
  } catch {
    return "";
  }
}

function trimNumber(n: number): string {
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
}
