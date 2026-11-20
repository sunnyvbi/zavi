import { createContext, useContext } from "react";

export type EmailCardAskFinder = (cardId: string, title: string) => (() => void) | null;

export const EmailCardAsk = createContext<EmailCardAskFinder | null>(null);

export function useEmailCardAsk(cardId: string | null, title: string): (() => void) | null {
  const find = useContext(EmailCardAsk);
  return cardId && find ? find(cardId, title) : null;
}
