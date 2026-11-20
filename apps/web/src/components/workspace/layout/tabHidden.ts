import { createContext, useContext } from "react";

export const TabHiddenContext = createContext(false);

export function useTabHidden(): boolean {
  return useContext(TabHiddenContext);
}
