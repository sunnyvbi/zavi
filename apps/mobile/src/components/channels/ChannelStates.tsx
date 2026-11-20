import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { useReduceMotion } from "../../lib/motion";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

function usePulse() {
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

  return pulse;
}

export function ChannelListSkeleton() {
  const styles = useStyles(makeStyles);
  const pulse = usePulse();

  return (
    <Animated.View
      style={[styles.skeletonList, { opacity: pulse }]}
      accessible
      accessibilityLabel="Loading channels"
      accessibilityState={{ busy: true }}
    >
      {Array.from({ length: 6 }, (_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <View style={styles.skeletonLogo} />
          <View style={styles.skeletonInfo}>
            <View style={styles.skeletonTitle} />
            <View style={styles.skeletonLine} />
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

export function ChannelActionsSkeleton({ count = 3 }: { count?: number }) {
  const styles = useStyles(makeStyles);
  const pulse = usePulse();

  return (
    <Animated.View
      style={{ opacity: pulse }}
      accessible
      accessibilityLabel="Loading actions"
      accessibilityState={{ busy: true }}
    >
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.actionCard}>
          <View style={styles.actionStatus}>
            <View style={styles.actionDot} />
            <View style={[styles.bar, { width: 84, height: 8 }]} />
          </View>
          <View style={[styles.bar, styles.actionTitle]} />
          <View style={[styles.bar, styles.actionLine, { width: "100%" }]} />
          <View style={[styles.bar, styles.actionLine, { width: "92%" }]} />
          <View style={[styles.bar, styles.actionLine, { width: "70%" }]} />
          <View style={styles.actionFooter}>
            <View style={[styles.bar, { width: 96, height: 10 }]} />
            <View style={styles.actionButton} />
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

export function ChannelsErrorState({ onRetry }: { onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.state} accessibilityRole="alert">
      <Text style={styles.body}>Couldn't load channels</Text>
      <Text style={styles.bodyHint}>Check your connection and try again.</Text>
      <Pressable
        style={styles.retry}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry loading channels"
      >
        <Text style={styles.retryText}>Retry</Text>
      </Pressable>
    </View>
  );
}

export function ChannelsEmptyState() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.state}>
      <Text style={styles.body}>Nothing waiting here yet.</Text>
    </View>
  );
}

export function StatusSpinner({ size = 11 }: { size?: number }) {
  const styles = useStyles(makeStyles);
  const reduceMotion = useReduceMotion();
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      spin.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    animation.start();
    return () => animation.stop();
  }, [spin, reduceMotion]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <Animated.View
      style={[styles.spinner, { width: size, height: size, borderRadius: size / 2, transform: [{ rotate }] }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  bar: { borderRadius: radius.pill, backgroundColor: colors.soft },
  actionCard: {
    marginTop: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 13,
    backgroundColor: colors.bg,
  },
  actionStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
  actionDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.soft },
  actionTitle: { marginTop: 10, width: "60%", height: 12 },
  actionLine: { marginTop: 9, height: 10 },
  actionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  actionButton: { width: 104, height: 36, borderRadius: radius.pill, backgroundColor: colors.soft },
  skeletonList: { borderTopWidth: 1, borderTopColor: colors.line },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    minHeight: 83,
    paddingVertical: 17,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  skeletonLogo: { width: 37, height: 37, borderRadius: radius.pill, backgroundColor: colors.soft },
  skeletonInfo: { flex: 1, gap: space.sm },
  skeletonTitle: { width: "45%", height: 12, borderRadius: radius.pill, backgroundColor: colors.soft },
  skeletonLine: { width: "75%", height: 10, borderRadius: radius.pill, backgroundColor: colors.soft },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  body: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.base,
    lineHeight: 20,
    textAlign: "center",
    color: colors.ink,
  },
  bodyHint: {
    marginTop: -4,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: font.size.sm,
    lineHeight: 18,
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
  retryText: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.sm,
    color: colors.onInk,
  },
  spinner: {
    borderWidth: 1.5,
    borderColor: colors.spinnerTrack,
    borderTopColor: colors.spinnerHead,
  },
});
