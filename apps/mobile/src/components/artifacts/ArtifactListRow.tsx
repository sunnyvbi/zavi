import { memo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import type { Artifact } from "../../features/artifacts/types";
import { ArtifactGlyph } from "./ArtifactGlyph";
import { artifactFormat, artifactTypeLabel, ArtifactPreviewTile } from "./ArtifactPreviewTile";

export const ArtifactListRow = memo(function ArtifactListRow({
  artifact,
  busy = false,
  onPress,
  onOverflow,
}: {
  artifact: Artifact;
  busy?: boolean;
  onPress?: () => void;
  onOverflow?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const created = new Date(artifact.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const meta = `${artifactTypeLabel(artifact.type)} · ${artifactFormat(artifact)} · ${created}`;

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.open}
        onPress={onPress}
        disabled={busy || !onPress}
        accessibilityRole="button"
        accessibilityLabel={`Open ${artifact.title}, ${meta}`}
        accessibilityState={{ disabled: busy || !onPress, busy }}
      >
        <ArtifactPreviewTile artifact={artifact} compact />
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>
            {artifact.title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
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
        <ArtifactGlyph name="more" size={20} color={colors.ink} />
      </Pressable>
      {busy ? (
        <View style={styles.busyOverlay} accessible accessibilityLabel={`Updating ${artifact.title}`}>
          <ActivityIndicator size="small" color={colors.ink} />
        </View>
      ) : null}
    </View>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    padding: space.md,
    backgroundColor: colors.panel,
  },
  open: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: font.family.semi,
    fontSize: 14,
    lineHeight: 18,
    color: colors.ink,
    includeFontPadding: false,
  },
  meta: {
    marginTop: space.xs,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  overflow: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  busyOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.veilStrong,
  },
});
