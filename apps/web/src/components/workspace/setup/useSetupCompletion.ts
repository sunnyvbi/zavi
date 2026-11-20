"use client";

import { useRef, useState } from "react";
import type { useSetupOptional } from "./SetupProvider";
import { summarizeReads } from "./importReads";

export function useSetupCompletion(setup: ReturnType<typeof useSetupOptional>) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const inFlight = useRef(false);
  const saved = useRef(false);
  const started = useRef(false);
  const finish = async (outcome: "done" | "skipped", skipPastWork = false) => {
    if (!setup || inFlight.current) return false;
    inFlight.current = true;
    setState({ busy: true, error: null });
    try {
      if (skipPastWork && setup.state?.enabled && setup.state.docs.status === "pending") await setup.mark({ step: "docs", outcome: "skipped" });
      if (!saved.current) {
        await setup.mark({ step: "connectors", outcome });
        saved.current = true;
      }
      const reading = summarizeReads(setup.imports?.files).reading;
      if (reading.length) setup.setAfterRead({ files: reading.map((file) => file.id), untouched: [] });
      if (!started.current) {
        started.current = true;
        void setup.startDraft();
      }
      await setup.mark({ step: "done" });
      setState({ busy: false, error: null });
      return true;
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : "Couldn't finish setup. Try again." });
      return false;
    } finally {
      inFlight.current = false;
    }
  };
  return { ...state, finish };
}
