"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Portal } from "@/components/ui/Portal";
import { ImportFlow } from "./ImportFlow";
import { useSetupOptional } from "./SetupProvider";
import type { SetupResponse } from "./setupState";

export function showAddKnowledge(s: SetupResponse | null, canManageSetup: boolean): boolean {
  return canManageSetup && !!s && s.enabled === true && s.docs.status !== "pending";
}

export function AddKnowledgeButton({ onClose }: { onClose?: () => void } = {}) {
  const [open, setOpenState] = useState(false);
  const setup = useSetupOptional();
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (!v) onClose?.();
  };
  return (
    <div className="mt-3 flex items-center gap-3 border-t border-rule pt-3">
      <button
        type="button"
        onClick={() => { setOpen(true); void setup?.imports?.refresh(); }}
        className="inline-flex h-10 items-center gap-2 rounded-cta border border-dashed border-rule px-3 text-[13px] font-medium text-ink hover:border-ink hover:bg-creamDeep"
      >
        <Plus className="h-3.5 w-3.5 text-inkMuted" aria-hidden />
        Add knowledge
      </button>
      <span className="text-[13px] text-inkMuted">Notes, plans or past work Zavi should know</span>
      {open && (
        <Portal>
          <div className="workspace-shell fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-ink/30 p-4 pt-[8vh]" onClick={() => setOpen(false)}>
            <div role="dialog" aria-modal="true" aria-label="Add knowledge" className="w-full max-w-[640px] rounded-2xl bg-cream p-6 shadow-pop" onClick={(e) => e.stopPropagation()}>
              <div className="mb-4 flex items-center">
                <p className="flex-1 text-[20px] font-semibold text-ink">Add knowledge</p>
                <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded-cta p-1.5 text-inkMuted hover:bg-creamDeep">
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
              <ImportFlow
                onDone={() => {
                  setOpen(false);
                  void setup?.refresh();
                }}
              />
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}
