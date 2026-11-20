
import { isTransientNetworkError } from "@/lib/api";

export type UploadFailure =
  | { kind: "http"; status: number; body: string }
  | { kind: "thrown"; error: unknown; sizeBytes?: number };

export const PROXY_SAFE_UPLOAD_BYTES = 4 * 1024 * 1024;

function formatMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  const shown = mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1).replace(/\.0$/, "");
  return `${shown} MB`;
}

function parseErrorBody(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    const err = parsed?.error;
    return {
      code: typeof err?.code === "string" ? err.code : undefined,
      message: typeof err?.message === "string" ? err.message : undefined,
    };
  } catch {
    return {};
  }
}

export function uploadErrorMessage(
  fileName: string,
  maxMb: number,
  failure: UploadFailure,
): string {
  const prefix = `Couldn't upload ${fileName}:`;
  if (failure.kind === "thrown") {
    const size = failure.sizeBytes;
    if (
      isTransientNetworkError(failure.error) &&
      size !== undefined &&
      size > PROXY_SAFE_UPLOAD_BYTES
    ) {
      return `Couldn't upload ${fileName} (${formatMb(size)}): the upload didn't go through. Files over ${formatMb(PROXY_SAFE_UPLOAD_BYTES)} can be refused, so try a smaller file or check your connection.`;
    }
    return isTransientNetworkError(failure.error)
      ? `${prefix} couldn't reach the server. Check your connection and try again.`
      : `${prefix} upload failed. Try again.`;
  }
  const { code, message } = parseErrorBody(failure.body);
  if (failure.status === 413) {
    return `${prefix} the server didn't accept a file this large. Try a smaller file.`;
  }
  if (code === "file_too_large") {
    return `${prefix} the file is too large (max ${maxMb}MB).`;
  }
  if (failure.status === 401) {
    return `${prefix} your session expired. Refresh the page and try again.`;
  }
  if (code === "invalid_mp4" || code === "invalid_pdf") {
    return `${prefix} the file content doesn't match its type. Re-export it and try again.`;
  }
  if (message) return `${prefix} ${message}`;
  return `${prefix} upload failed (HTTP ${failure.status}). Try again.`;
}
