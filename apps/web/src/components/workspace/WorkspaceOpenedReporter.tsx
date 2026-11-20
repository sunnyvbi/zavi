"use client";

import { useWorkspaceOpenedSignal } from "@/lib/workspace/workspaceOpened";

export function WorkspaceOpenedReporter() {
  useWorkspaceOpenedSignal();
  return null;
}
