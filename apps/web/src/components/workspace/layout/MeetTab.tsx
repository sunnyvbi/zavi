"use client";

import { NotetakerPanel } from "../settings/NotetakerPanel";
import { useWorkspace } from "../WorkspaceShell";
import { isMember } from "@/lib/members";

export function MeetTab() {
  const { role } = useWorkspace();
  return (
    <div className="ws-scroll h-full min-h-0 px-6 py-6">
      <div className="mx-auto w-full max-w-[880px]">
        <div className="mb-5">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight text-ink">
            Meet
          </h1>
          <p className="mt-1 text-[16px] leading-6 text-inkMuted">
            Send Zavi to your meetings so your AI team always knows what&apos;s
            blocked and who&apos;s on what.
          </p>
        </div>
        <NotetakerPanel readOnly={isMember(role)} />
      </div>
    </div>
  );
}
