import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Appearance } from "react-native";
import type { ColorSchemeName } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SystemUI from "expo-system-ui";
import type { ReactNode } from "react";
import { ThemeContext, themeFor } from "../theme/theme";

const KEY = "zavi.pref.appearance";

export type AppearancePreference = "system" | "light" | "dark";

type KnownScheme = "light" | "dark";

type AppearanceState = {
  preference: AppearancePreference;
  setPreference: (p: AppearancePreference) => void;
  systemScheme: KnownScheme | null;
  scheme: KnownScheme;
};

const Ctx = createContext<AppearanceState | null>(null);

function isPreference(value: string | null): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

function knownScheme(value: ColorSchemeName | null | undefined): KnownScheme | null {
  return value === "light" || value === "dark" ? value : null;
}

function applyPreference(preference: AppearancePreference) {
  if (typeof Appearance.setColorScheme !== "function") return;
  try {
    Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
  } catch {
  }
}

export function AppearanceProvider(props: { children: ReactNode }): JSX.Element | null {
  const [preference, setPreferenceState] = useState<AppearancePreference | null>(null);
  const [systemScheme, setSystemScheme] = useState<KnownScheme | null>(() =>
    knownScheme(Appearance.getColorScheme()),
  );
  const preferenceRef = useRef<AppearancePreference>("system");

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(KEY)
      .then((value) => {
        if (!mounted) return;
        const next = isPreference(value) ? value : "system";
        preferenceRef.current = next;
        applyPreference(next);
        setPreferenceState(next);
      })
      .catch(() => {
        if (!mounted) return;
        applyPreference("system");
        setPreferenceState("system");
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (preference !== "system") return;

    const current = knownScheme(Appearance.getColorScheme());
    if (current) setSystemScheme(current);

    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      if (preferenceRef.current !== "system") return;
      const next = knownScheme(colorScheme);
      if (next) setSystemScheme(next);
    });
    return () => sub.remove();
  }, [preference]);

  const setPreference = useCallback((next: AppearancePreference) => {
    preferenceRef.current = next;
    applyPreference(next);
    setPreferenceState(next);
    void AsyncStorage.setItem(KEY, next).catch(() => {});
  }, []);

  const resolvedPreference = preference ?? "system";
  const scheme: KnownScheme =
    resolvedPreference === "system" ? systemScheme ?? "light" : resolvedPreference;
  const theme = themeFor(scheme);

  useEffect(() => {
    Promise.resolve()
      .then(() => SystemUI.setBackgroundColorAsync(theme.colors.bg))
      .catch(() => {});
  }, [theme]);

  const value = useMemo<AppearanceState>(
    () => ({ preference: resolvedPreference, setPreference, systemScheme, scheme }),
    [resolvedPreference, setPreference, systemScheme, scheme],
  );

  if (preference === null) return null;

  return (
    <Ctx.Provider value={value}>
      <ThemeContext.Provider value={theme}>{props.children}</ThemeContext.Provider>
    </Ctx.Provider>
  );
}

export function useAppearance(): AppearanceState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useAppearance must be used inside AppearanceProvider");
  return value;
}

export function appearanceLabel(p: AppearancePreference): "System" | "Light" | "Dark" {
  if (p === "light") return "Light";
  if (p === "dark") return "Dark";
  return "System";
}
