import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useActiveTenant } from "../workspaces/useActiveTenant";

function draftKey(tenant: string, slug: string, threadId?: string): string {
  return `zavi.draft.${tenant}:${slug}:${threadId ?? "new"}`;
}

export function useDraft(slug: string, threadId?: string) {
  const tenant = useActiveTenant();
  const key = draftKey(tenant, slug, threadId);
  const [value, setValue] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    setHydrated(false);
    AsyncStorage.getItem(key).then((v) => {
      if (!active) return;
      setValue(v ?? "");
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [key]);

  const update = useCallback(
    (text: string) => {
      setValue(text);
      if (text) void AsyncStorage.setItem(key, text);
      else void AsyncStorage.removeItem(key);
    },
    [key],
  );

  const clear = useCallback(() => {
    setValue("");
    void AsyncStorage.removeItem(key);
  }, [key]);

  return { value, update, clear, hydrated };
}
