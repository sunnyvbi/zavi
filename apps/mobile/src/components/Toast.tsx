import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { font, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

const HIDE_AFTER_MS = 2600;

export function useToast(
  position: { top: number } | { bottom: number },
  opts: { fit?: "stretch" | "content" } = {},
): {
  show(message: string): void;
  toast: ReactNode;
} {
  const styles = useStyles(makeStyles);
  const fit = opts.fit ?? "stretch";
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => {
      timer.current = null;
      setMessage(null);
    }, HIDE_AFTER_MS);
  }, []);

  const toast = message ? (
    <View
      style={[styles.wrap, fit === "content" && styles.wrapCenter, position]}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
    >
      <View style={[styles.toast, fit === "content" && styles.toastContent]}>
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  ) : null;

  return { show, toast };
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { position: "absolute", left: 0, right: 0, paddingHorizontal: 24 },
  wrapCenter: { alignItems: "center" },
  toast: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.toastBg,
  },
  toastContent: { maxWidth: "85%", paddingVertical: 8, borderRadius: 999 },
  text: {
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: 12,
    color: colors.toastText,
  },
});
