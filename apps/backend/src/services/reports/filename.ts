
import {
  sanitizeArtifactFilename,
  artifactMimeForFilename,
} from "@/services/agents/sdk/mcp-sandbox";
import { ExpectedToolError } from "@/services/tools/types";

const PDF_MIME = "application/pdf";

export type NormalizedFilename = {
  filename: string;
  mime: typeof PDF_MIME;
};

export function normalizeArtifactFilename(raw: string): NormalizedFilename {
  const sanitized = sanitizeArtifactFilename(raw);
  if (!sanitized) {
    throw new ExpectedToolError(
      "filename_invalid",
      "filename produced no usable characters after sanitization. Use a name like 'report.pdf'.",
    );
  }
  let filename = sanitized;
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1) : "";
  if (ext !== "pdf") {
    filename = `${filename}.pdf`;
  }
  if (filename.length > 120) {
    filename = `${filename.slice(0, 116)}.pdf`;
  }
  const mime = artifactMimeForFilename(filename);
  if (mime !== PDF_MIME) {
    throw new ExpectedToolError(
      "filename_invalid",
      `filename ${filename} did not resolve to ${PDF_MIME}.`,
    );
  }
  return { filename, mime: PDF_MIME };
}
