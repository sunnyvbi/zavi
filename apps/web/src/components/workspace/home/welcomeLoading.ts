import type { WorkspaceMode } from "../ZaviWelcome";

export function shouldFoldWelcomeIdeas(
  mode: WorkspaceMode,
  firstRunDone: boolean | null,
) {
  return mode === "grow" && firstRunDone === false;
}
