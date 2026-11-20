export type AttachmentKind = "image" | "video" | "doc";

type Base = { id: string; kind: AttachmentKind; name: string; previewUri: string; mime: string };

export type Attachment =
  | (Base & { status: "uploading" })
  | (Base & { status: "ready"; path: string })
  | (Base & { status: "error"; message: string });

export function readyPaths(attachments: Attachment[], kind: AttachmentKind): string[] {
  return attachments
    .filter(
      (a): a is Extract<Attachment, { status: "ready" }> => a.status === "ready" && a.kind === kind,
    )
    .map((a) => a.path);
}

export function uploadsPending(attachments: Attachment[]): boolean {
  return attachments.some((a) => a.status === "uploading");
}

export function countOf(attachments: Attachment[], kind: AttachmentKind): number {
  return attachments.filter((a) => a.kind === kind).length;
}
