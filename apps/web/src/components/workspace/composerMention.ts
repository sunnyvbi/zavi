export type ActiveComposerMention = {
  query: string;
  start: number;
  end: number;
};

export function getActiveComposerMention(
  value: string,
  caret = value.length,
): ActiveComposerMention | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, safeCaret));
  if (!match) return null;

  const query = match[1] ?? "";
  return {
    query,
    start: safeCaret - query.length - 1,
    end: safeCaret,
  };
}

export function removeActiveComposerMention(
  value: string,
  caret = value.length,
): { value: string; caret: number } {
  const mention = getActiveComposerMention(value, caret);
  if (!mention) return { value, caret: value.length };

  const nextValue = value.slice(0, mention.start) + value.slice(mention.end);
  return { value: nextValue, caret: mention.start };
}

export function replaceActiveComposerMention(
  value: string,
  caret = value.length,
): { value: string; caret: number } {
  return removeActiveComposerMention(value, caret);
}

export function splitComposerAtMention(
  value: string,
  position: number,
): { before: string; after: string } {
  const safePosition = Math.max(0, Math.min(position, value.length));
  return {
    before: value.slice(0, safePosition),
    after: value.slice(safePosition),
  };
}

export function shouldShowComposerHint(
  hint: string | null,
  hasSelectedMention: boolean,
): hint is string {
  return hint !== null && !hasSelectedMention;
}
