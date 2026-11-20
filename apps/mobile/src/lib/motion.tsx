import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "zavi.pref.reduceMotion";

type MotionState = {
  reduceMotion: boolean;
  appReduceMotion: boolean;
  systemReduceMotion: boolean;
  setAppReduceMotion: (on: boolean) => void;
};

const Ctx = createContext<MotionState | null>(null);

export function MotionProvider({ children }: { children: React.ReactNode }) {
  const [systemReduceMotion, setSystem] = useState(false);
  const [appReduceMotion, setApp] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (mounted) setSystem(on);
      })
      .catch(() => {});
    AsyncStorage.getItem(KEY)
      .then((v) => {
        if (mounted) setApp(v === "1");
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setSystem);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const setAppReduceMotion = useCallback((on: boolean) => {
    setApp(on);
    void AsyncStorage.setItem(KEY, on ? "1" : "0").catch(() => {});
  }, []);

  const value = useMemo<MotionState>(
    () => ({
      reduceMotion: systemReduceMotion || appReduceMotion,
      appReduceMotion,
      systemReduceMotion,
      setAppReduceMotion,
    }),
    [systemReduceMotion, appReduceMotion, setAppReduceMotion],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMotion(): MotionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMotion must be used inside MotionProvider");
  return v;
}

export function useReduceMotion(): boolean {
  return useMotion().reduceMotion;
}
