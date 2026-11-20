import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export function Screen({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <SafeAreaView style={styles.safe} edges={["top"]}>{children}</SafeAreaView>;
}

export function ScreenHeader({
  title,
  left,
  right,
}: {
  title: string;
  left?: ReactNode;
  right?: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  if (left) {
    return (
      <View style={styles.header}>
        <View style={styles.headerSlot}>{left}</View>
        <View style={styles.headerTitleFill} pointerEvents="none">
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={styles.headerSlot}>{right}</View>
      </View>
    );
  }

  return (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      {right ? <View>{right}</View> : null}
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.panel2 },
  header: {
    minHeight: 54,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerSlot: { minWidth: 28, justifyContent: "center" },
  headerTitleFill: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: font.size.title, fontWeight: "600", color: colors.ink },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.sm },
  emptyTitle: { fontSize: font.size.lg, fontWeight: "800", color: colors.ink },
  emptyBody: { fontSize: font.size.base, color: colors.muted, textAlign: "center", lineHeight: 20 },
});
