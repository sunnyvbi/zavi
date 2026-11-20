"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Artifact } from "./types";

export const ARTIFACT_PANE_MIN_VIEWPORT_PX = 1024;

export type OpenArtifactRequest = {
  artifact: Artifact;
  onDownload: () => void;
  report?: { summary: string; sources: string | null; createdAt: string; threadId?: string | null };
  autoOpened?: boolean;
};

type ArtifactPreviewValue = {
  canDock: boolean;
  open: OpenArtifactRequest | null;
  openArtifact: (request: OpenArtifactRequest) => void;
  close: () => void;
};

const NO_DOCK: ArtifactPreviewValue = {
  canDock: false,
  open: null,
  openArtifact: () => {},
  close: () => {},
};

const ArtifactPreviewContext = createContext<ArtifactPreviewValue>(NO_DOCK);

function useWideViewport(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(min-width: ${ARTIFACT_PANE_MIN_VIEWPORT_PX}px)`);
    const sync = () => setWide(query.matches);
    sync();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", sync);
      return () => query.removeEventListener("change", sync);
    }
    return undefined;
  }, []);
  return wide;
}

export function ArtifactPreviewProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<OpenArtifactRequest | null>(null);
  const wide = useWideViewport();
  const close = useCallback(() => setOpen(null), []);
  const openArtifact = useCallback((request: OpenArtifactRequest) => setOpen(request), []);

  useEffect(() => {
    if (!wide) setOpen(null);
  }, [wide]);

  const value = useMemo<ArtifactPreviewValue>(
    () => ({ canDock: wide, open, openArtifact, close }),
    [wide, open, openArtifact, close],
  );
  return (
    <ArtifactPreviewContext.Provider value={value}>{children}</ArtifactPreviewContext.Provider>
  );
}

export function useArtifactPreview(): ArtifactPreviewValue {
  return useContext(ArtifactPreviewContext);
}
