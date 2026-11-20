"use client";

import { createContext, useContext } from "react";

const GroupMeta = createContext<string | null>(null);

export const GroupMetaProvider = GroupMeta.Provider;

export function useGroupMeta(): string | null {
  return useContext(GroupMeta);
}

export function groupMetaLine(index: number, size: number, word: string, long = false): string {
  return long ? `Suggestion ${index + 1} of ${size} for the same ${word}` : `${index + 1} of ${size} · Same ${word}`;
}
