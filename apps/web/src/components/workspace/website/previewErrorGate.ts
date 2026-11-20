import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWorkspace } from "../WorkspaceShell";
import { openBillingSettings } from "@/lib/workspace/openBilling";

export type PreviewFixOutcome = { ok: true } | { ok: false; message: string; credit?: boolean };

export type PreviewErrorGate = {
  active: boolean;
  busy: boolean;
  failed: boolean;
  fix: (message: string) => Promise<PreviewFixOutcome>;
  openBilling: () => void;
};

const MANUAL = Symbol("manual");
const gates = new Map<symbol, PreviewErrorGate>();
let current: PreviewErrorGate | null = null;
const listeners = new Set<() => void>();

function pick(): PreviewErrorGate | null {
  let latest: PreviewErrorGate | null = null;
  let latestActive: PreviewErrorGate | null = null;
  for (const gate of gates.values()) {
    latest = gate;
    if (gate.active) latestActive = gate;
  }
  return latestActive ?? latest;
}

function publish(owner: symbol, next: PreviewErrorGate | null): void {
  if (next) gates.set(owner, next);
  else gates.delete(owner);
  const picked = pick();
  if (picked === current) return;
  current = picked;
  listeners.forEach((listener) => listener());
}

export function setPreviewErrorGate(next: PreviewErrorGate | null): void {
  publish(MANUAL, next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => current;

export function usePreviewErrorGate(): PreviewErrorGate | null {
  return useSyncExternalStore(subscribe, read, read);
}

export function usePreviewErrorFix(input: {
  active: boolean;
  busy: boolean;
  failed: boolean;
  refine: (message: string) => Promise<PreviewFixOutcome>;
}): void {
  const { openTab } = useWorkspace();
  const refineRef = useRef(input.refine);
  refineRef.current = input.refine;
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;
  const ownerRef = useRef<symbol | null>(null);
  ownerRef.current ??= Symbol("preview");
  const owner = ownerRef.current;
  const { active, busy, failed } = input;
  useEffect(() => {
    publish(owner, {
      active,
      busy,
      failed,
      fix: (message) => refineRef.current(message),
      openBilling: () => openBillingSettings(openTabRef.current),
    });
  }, [owner, active, busy, failed]);
  useEffect(() => () => publish(owner, null), [owner]);
}
