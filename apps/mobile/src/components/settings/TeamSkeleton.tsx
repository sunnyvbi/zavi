import { StyleSheet, View } from "react-native";
import { SkeletonBlock } from "../Skeleton";
import { ListGroup } from "./SettingsUI";
import { space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export function TeamSectionLabelSkeleton() {
  const styles = useStyles(makeStyles);
  return <SkeletonBlock width={80} height={11} radius={4} style={styles.sectionLabel} />;
}

export function TeamInviteButtonSkeleton() {
  const styles = useStyles(makeStyles);
  return <SkeletonBlock width="100%" height={44} radius={10} style={styles.button} />;
}

export function TeamMembersSkeleton({ rows = 4 }: { rows?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <ListGroup>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.row, i > 0 && styles.rowDivider]}>
          <SkeletonBlock width={36} height={36} radius={18} />
          <View style={styles.text}>
            <SkeletonBlock width="70%" height={14} />
          </View>
          <SkeletonBlock width={56} height={22} radius={11} />
        </View>
      ))}
    </ListGroup>
  );
}

export function TeamInvitesSkeleton({ rows = 2 }: { rows?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <ListGroup>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.row, styles.inviteRow, i > 0 && styles.rowDivider]}>
          <SkeletonBlock width={36} height={36} radius={18} />
          <View style={styles.text}>
            <SkeletonBlock width="70%" height={14} />
            <SkeletonBlock width="40%" height={12} style={styles.meta} />
          </View>
          <SkeletonBlock width={62} height={32} radius={8} />
        </View>
      ))}
    </ListGroup>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 60,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    backgroundColor: colors.panel,
  },
  inviteRow: { minHeight: 72, paddingVertical: 14 },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  text: { flex: 1, minWidth: 0 },
  meta: { marginTop: 8 },
  sectionLabel: { marginTop: 28, marginBottom: space.md, marginLeft: space.xs },
  button: { marginTop: space.sm },
});
