
import { parseUiBlock, type UiBlock } from "@zavi/shared";
import { mintSignedUrl } from "./artifacts/useArtifactContent";

export async function loadUiBlock(
  artifactId: string,
  fetchImpl: typeof fetch = fetch,
  previewUrl: string | null = null,
  signal: AbortSignal = new AbortController().signal,
): Promise<UiBlock | null> {
  try {
    let raw = previewUrl
      ? await fetchImpl(previewUrl, { signal }).catch(() => null)
      : null;
    if (!raw?.ok) {
      const signedUrl = await mintSignedUrl(artifactId, signal);
      raw = await fetchImpl(signedUrl, { signal });
    }
    if (!raw.ok) return null;
    return parseUiBlock(await raw.json());
  } catch {
    return null;
  }
}

export const CHART_COLORS = {
  series: "#3b82f6",
  positive: "#16a34a",
  negative: "#dc2626",
  ink: "rgb(var(--c-ink))",
  muted: "rgb(var(--c-ink-muted))",
  rule: "rgb(var(--c-rule))",
  surface: "rgb(var(--c-cream))",
};

const DISMISSED_KEY = "zavi.report.dismissed";
const dismissedMemory = new Set<string>();

export function dismissReport(artifactId: string): void {
  dismissedMemory.add(artifactId);
  try {
    const seen = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as string[];
    if (!seen.includes(artifactId)) {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...seen.slice(-49), artifactId]));
    }
  } catch {
  }
}

export function reportDismissed(artifactId: string): boolean {
  if (dismissedMemory.has(artifactId)) return true;
  try {
    return (JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]).includes(artifactId);
  } catch {
    return false;
  }
}

