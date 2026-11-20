
import { pickAdapter } from "../adapters";
import type { AdapterExtraction } from "../adapters/types";

export type PageCaptureRaw = {
  url: string;
  title: string;
  adapter: AdapterExtraction | null;
};

export function capture(): PageCaptureRaw {
  let adapter: AdapterExtraction | null = null;
  try {
    adapter = pickAdapter(
      { hostname: location.hostname, pathname: location.pathname },
      document,
    );
  } catch {
    adapter = null;
  }
  return { url: location.href, title: document.title, adapter };
}
