export type HistoryOpenContext = {
  rowSlug: string;
  rowThreadId: string;
  operatorSlug: string;
  activeTabKind: string | undefined;
  hasBuildTab: boolean;
  buildThreadId: string | null | undefined;
  buildChatFollowsThread: boolean;
};

export function historyRowBindsToBuild(ctx: HistoryOpenContext): boolean {
  return (
    ctx.rowSlug === ctx.operatorSlug &&
    ctx.activeTabKind === "build" &&
    ctx.hasBuildTab &&
    ctx.buildChatFollowsThread &&
    typeof ctx.buildThreadId === "string" &&
    ctx.rowThreadId === ctx.buildThreadId
  );
}
