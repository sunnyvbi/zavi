
export const BUILD_CHAT_DEFAULT_PX = 360;
export const BUILD_CHAT_MIN_PX = 340;
export const BUILD_PREVIEW_MIN_PX = 360;
export const PREVIEW_MIN_SCREEN_FRACTION = 0.45;
export const BUILD_SPLIT_MIN_PX = 1024;

export const BUILD_CHAT_WIDTH_KEY = "zavi:build-chat-width";

export function buildChatCeiling(geometry: {
  rowRight: number;
  chatLeft: number;
  gapPx: number;
  rowPaddingPx: number;
  screenWidth: number;
}): number {
  const { rowRight, chatLeft, gapPx, rowPaddingPx, screenWidth } = geometry;
  const previewFloor = Math.max(
    BUILD_PREVIEW_MIN_PX,
    screenWidth * PREVIEW_MIN_SCREEN_FRACTION,
  );
  const available = rowRight - chatLeft - gapPx - rowPaddingPx / 2 - previewFloor;
  return Math.max(BUILD_CHAT_MIN_PX, available);
}

export function clampBuildChatWidth(width: number, ceiling: number): number {
  const max = Math.max(BUILD_CHAT_MIN_PX, ceiling);
  return Math.round(Math.min(max, Math.max(BUILD_CHAT_MIN_PX, width)));
}
