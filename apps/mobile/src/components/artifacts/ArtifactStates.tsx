import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export function ArtifactsSkeleton({ count = 6, layout = "grid" }: { count?: number; layout?: "grid" | "list" }) {
  const styles = useStyles(makeStyles);
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  const items = Array.from({ length: count }, (_, index) => index);
  const rows = Array.from({ length: Math.ceil(count / 2) }, (_, index) => items.slice(index * 2, index * 2 + 2));

  return (
    <Animated.View
      style={[styles.skeletonList, { opacity: pulse }]}
      accessible
      accessibilityLabel="Loading artifacts"
      accessibilityState={{ busy: true }}
    >
      {layout === "list"
        ? items.map((index) => (
            <View key={index} style={styles.skeletonRow}>
              <View style={styles.skeletonRowThumb} />
              <View style={styles.skeletonRowInfo}>
                <View style={styles.skeletonTitleLine}>
                  <View style={styles.skeletonTitle} />
                </View>
                <View style={styles.skeletonMetaLine}>
                  <View style={styles.skeletonFormat} />
                </View>
              </View>
              <View style={styles.skeletonRowOverflow} />
            </View>
          ))
        : rows.map((row) => (
            <View key={row[0]} style={styles.skeletonGridRow}>
              {row.map((index) => (
                <View key={index} style={styles.skeletonCard}>
                  <View style={styles.skeletonThumb} />
                  <View style={styles.skeletonInfo}>
                    <View style={styles.skeletonTitleLine}>
                      <View style={styles.skeletonTitle} />
                    </View>
                    <View style={styles.skeletonMetaLine}>
                      <View style={styles.skeletonFormat} />
                    </View>
                  </View>
                </View>
              ))}
              {row.length === 1 ? <View style={styles.skeletonGridSpacer} /> : null}
            </View>
          ))}
    </Animated.View>
  );
}

export function ArtifactsEmptyState({
  title = "No artifacts found",
  body = "Try another search or filter.",
}: {
  title?: string;
  body?: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.state} accessible accessibilityLabel={`${title}. ${body}`}>
      <View style={styles.emptyMark}>
        <Text style={styles.emptyMarkText}>0</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

export function ArtifactsErrorState({
  onRetry,
  title = "Artifacts could not load",
  body = "Check your connection and try again.",
}: {
  onRetry: () => void;
  title?: string;
  body?: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.state} accessible accessibilityLabel={`${title}. ${body}`} accessibilityRole="alert">
      <View style={styles.errorMark}>
        <Text style={styles.errorMarkText}>!</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <Pressable
        style={styles.retry}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry loading artifacts"
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  skeletonList: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: 20,
    paddingBottom: 20,
  },
  skeletonGridRow: { flexDirection: "row", gap: space.md },
  skeletonGridSpacer: { flex: 1 },
  skeletonCard: {
    flex: 1,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 19,
    backgroundColor: colors.panel,
  },
  skeletonThumb: { height: 135, backgroundColor: colors.soft },
  skeletonInfo: { padding: space.md },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    padding: space.md,
    backgroundColor: colors.panel,
  },
  skeletonRowThumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: colors.soft },
  skeletonRowInfo: { flex: 1, minWidth: 0 },
  skeletonRowOverflow: { width: 36, height: 36 },
  skeletonTitleLine: { height: 18, justifyContent: "center" },
  skeletonMetaLine: { height: 16, marginTop: space.xs, justifyContent: "center" },
  skeletonTitle: { width: "80%", height: 12, borderRadius: radius.pill, backgroundColor: colors.soft },
  skeletonFormat: { width: "35%", height: 10, borderRadius: radius.pill, backgroundColor: colors.soft },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  emptyMark: {
    width: 54,
    height: 54,
    marginBottom: space.lg,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.soft,
  },
  emptyMarkText: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.lg,
    color: colors.muted,
  },
  errorMark: {
    width: 54,
    height: 54,
    marginBottom: space.lg,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.approvalBg,
  },
  errorMarkText: {
    fontFamily: font.family.bold,
    includeFontPadding: false,
    fontSize: font.size.lg,
    color: colors.red,
  },
  title: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.lg,
    textAlign: "center",
    color: colors.ink,
  },
  body: {
    maxWidth: 260,
    marginTop: space.sm,
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
  retryText: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.sm,
    color: colors.onInk,
  },
});
