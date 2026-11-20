import { memo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import type { Artifact } from "../../features/artifacts/types";
import { ArtifactGlyph } from "./ArtifactGlyph";
import { artifactFormat, ArtifactPreviewTile } from "./ArtifactPreviewTile";

export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  busy = false,
  onPress,
  onOverflow,
  style,
}: {
  artifact: Artifact;
  busy?: boolean;
  onPress?: () => void;
  onOverflow?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const format = artifactFormat(artifact);
  const created = new Date(artifact.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <View style={[styles.card, style]}>
      <Pressable
        style={styles.open}
        onPress={onPress}
        disabled={busy || !onPress}
        accessibilityRole="button"
        accessibilityLabel={`Open ${artifact.title}, ${format}`}
        accessibilityState={{ disabled: busy || !onPress, busy }}
      >
        <ArtifactPreviewTile artifact={artifact} />
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>
            {artifact.title}
          </Text>
          <Text style={styles.format} numberOfLines={1}>
            {`${format} · ${created}`}
          </Text>
        </View>
      </Pressable>
      <Pressable
        style={styles.overflow}
        onPress={onOverflow}
        disabled={busy || !onOverflow}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Options for ${artifact.title}`}
        accessibilityState={{ disabled: busy || !onOverflow, busy }}
      >
        <ArtifactGlyph name="more" size={19} color={colors.ink} />
      </Pressable>
      {busy ? (
        <View style={styles.busyOverlay} accessible accessibilityLabel={`Updating ${artifact.title}`}>
          <ActivityIndicator size="small" color={colors.ink} />
        </View>
      ) : null}
    </View>
  );
});

export function ArtifactGrid({
  artifacts,
  busyArtifactId,
  onPress,
  onOverflow,
  contentContainerStyle,
}: {
  artifacts: Artifact[];
  busyArtifactId?: string | null;
  onPress?: (artifact: Artifact) => void;
  onOverflow?: (artifact: Artifact) => void;
  contentContainerStyle?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const rows: Artifact[][] = [];
  for (let index = 0; index < artifacts.length; index += 2) {
    rows.push(artifacts.slice(index, index + 2));
  }

  return (
    <View style={[styles.grid, contentContainerStyle]}>
      {rows.map((row) => (
        <View key={row[0].id} style={styles.row}>
          {row.map((artifact) => (
            <View key={artifact.id} style={styles.gridItem}>
              <ArtifactCard
                artifact={artifact}
                busy={busyArtifactId === artifact.id}
                onPress={onPress ? () => onPress(artifact) : undefined}
                onOverflow={onOverflow ? () => onOverflow(artifact) : undefined}
              />
            </View>
          ))}
          {row.length === 1 ? <View style={styles.gridItem} /> : null}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  grid: { gap: space.md },
  row: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  gridItem: { flex: 1 },
  card: {
    width: "100%",
    overflow: "hidden",
    position: "relative",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 19,
    backgroundColor: colors.panel,
  },
  open: { width: "100%" },
  info: {
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  title: {
    paddingRight: space.md,
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.md,
    lineHeight: 18,
    color: colors.ink,
  },
  format: {
    marginTop: space.xs,
    paddingRight: 30,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: font.size.sm,
    lineHeight: 16,
    color: colors.muted,
  },
  overflow: {
    position: "absolute",
    right: space.xs,
    bottom: 4,
    zIndex: 2,
    width: 30,
    height: 36,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
  },
  busyOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.veilStrong,
  },
});
