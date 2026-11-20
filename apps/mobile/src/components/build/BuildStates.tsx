import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useReduceMotion } from "../../lib/motion";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export function BuildSkeleton({ rows = 4, label }: { rows?: number; label: string }) {
  const styles = useStyles(makeStyles);
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(0.7);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, reduceMotion]);

  return (
    <Animated.View
      style={[styles.group, { opacity: pulse }]}
      accessible
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
    >
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.row, i === rows - 1 && styles.rowLast]}>
          <View style={styles.title} />
          <View style={styles.line} />
        </View>
      ))}
    </Animated.View>
  );
}

export function BuildErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.state} accessibilityRole="alert">
      <Text style={styles.body}>{text}</Text>
      <Pressable style={styles.retry} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry">
        <Text style={styles.retryText}>Retry</Text>
      </Pressable>
    </View>
  );
}

export function BuildEmptyState({ text }: { text: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.state}>
      <Text style={styles.body}>{text}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  group: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  row: {
    gap: space.sm,
    minHeight: 64,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowLast: { borderBottomWidth: 0 },
  title: { width: "55%", height: 12, borderRadius: radius.pill, backgroundColor: colors.soft },
  line: { width: "35%", height: 10, borderRadius: radius.pill, backgroundColor: colors.soft },
  state: { alignItems: "center", justifyContent: "center", paddingVertical: space.xl * 2, paddingHorizontal: space.xl },
  body: {
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: font.size.base,
    lineHeight: 20,
    textAlign: "center",
    color: colors.muted,
  },
  retry: {
    minHeight: 44,
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.ink,
  },
  retryText: { fontFamily: font.family.semi, includeFontPadding: false, fontSize: font.size.sm, color: colors.onInk },
});
