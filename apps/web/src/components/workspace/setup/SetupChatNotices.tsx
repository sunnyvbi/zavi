"use client";

import { cn } from "@/lib/cn";
import { AfterSetupReadNote } from "./AfterSetupReadNote";
import { StrategyProgressNotice } from "./StrategyProgressNotice";
import { useSetupOptional } from "./SetupProvider";

export function SetupChatNotices({ embedded = false }: { embedded?: boolean }) {
  const setup = useSetupOptional();
  const finished = setup?.canManageSetup && setup.state?.enabled === true && setup.state.done;

  return (
    <>
      {finished && (
        <div className={cn("mx-auto w-full max-w-2xl px-4", embedded ? "mb-4" : "shrink-0")}>
          {setup.finishNote && <p role="status" className="mb-3 text-sm text-inkMuted">{setup.finishNote}</p>}
          <AfterSetupReadNote />
        </div>
      )}
      <StrategyProgressNotice embedded={embedded} />
    </>
  );
}
