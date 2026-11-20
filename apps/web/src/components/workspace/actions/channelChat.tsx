"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ActionItem } from "./types";

export const ANSWER_PLACEHOLDER = "Type your answer for Zavi";

export type ChannelChatMode = "ask" | "redo";

export type ChannelChatPin =
  | {
      target: "action";
      action: ActionItem;
      mode: ChannelChatMode;
      onRedo: (note: string) => void | Promise<unknown>;
      answer?: boolean;
      draft?: { text: string; nonce: number; autoSend?: boolean; onStarted?: () => void };
    }
  | {
      target: "channel";
      draft?: {
        text: string;
        nonce: number;
        autoSend?: boolean;
        onStarted?: () => void;
      };
    };

export type ChannelChatOpener = (pin: ChannelChatPin) => void;

const ChannelChatContext = createContext<ChannelChatOpener | null>(null);

export function ChannelChatProvider({
  open,
  children,
}: {
  open: ChannelChatOpener;
  children: ReactNode;
}) {
  return (
    <ChannelChatContext.Provider value={open}>
      {children}
    </ChannelChatContext.Provider>
  );
}

export function useChannelChatOpener(): ChannelChatOpener | null {
  return useContext(ChannelChatContext);
}
