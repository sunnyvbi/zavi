
import type { PageContextPayload } from "./api";
import type { PageCapture } from "./capture";

export function toPageContext(capture: PageCapture): PageContextPayload {
  if (!capture.adapter) {
    return { url: capture.url, title: capture.title };
  }
  return {
    url: capture.url,
    title: capture.title,
    adapter_id: capture.adapter.adapter_id,
    schema_version: capture.adapter.schema_version,
    extraction: capture.adapter.extraction,
  };
}
