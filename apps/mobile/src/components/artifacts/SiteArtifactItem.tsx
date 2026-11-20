import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import type { SiteArtifact } from "../../features/artifacts/types";
import { siteBadge, siteHref, type SiteBadgeTone } from "../../features/artifacts/sites";
import { ArtifactGlyph } from "./ArtifactGlyph";

export const SiteArtifactItem = memo(function SiteArtifactItem({
  site,
  layout,
  onOpen,
  onOpenLive,
}: {
  site: SiteArtifact;
  layout: "grid" | "list";
  onOpen: (() => void) | null;
  onOpenLive: (url: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const badge = siteBadge(site);
  const href = siteHref(site);
  const created = new Date(site.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const open = onOpen ?? (href ? () => onOpenLive(href) : undefined);
  const label = `Open ${site.title}, website${badge ? `, ${badge.label}` : ""}`;

  const chip = badge ? (
    <View style={[styles.chip, { backgroundColor: chipBackground(colors, badge.tone) }]}>
      <Text style={[styles.chipText, { color: chipText(colors, badge.tone) }]} numberOfLines={1}>
        {badge.label}
      </Text>
    </View>
  ) : null;

  const live = href ? (
    <Pressable
      style={layout === "grid" ? styles.liveGrid : styles.liveList}
      onPress={() => onOpenLive(href)}
      hitSlop={8}
      accessibilityRole="link"
      accessibilityLabel={`Open ${site.title} live site`}
    >
      <ArtifactGlyph name="open" size={layout === "grid" ? 17 : 20} color={colors.ink} />
    </Pressable>
  ) : null;

  if (layout === "list") {
    return (
      <View style={styles.row}>
        <Pressable style={styles.rowOpen} onPress={open} disabled={!open} accessibilityRole="button" accessibilityLabel={label}>
          <View style={[styles.tileCompact, { backgroundColor: colors.avatarGreen }]}>
            <View style={[styles.iconBadge, styles.iconBadgeCompact]}>
              <ArtifactGlyph name="globe" size={18} color={colors.ink} />
            </View>
          </View>
          <View style={styles.info}>
            <Text style={styles.rowTitle} numberOfLines={1}>{site.title}</Text>
            <View style={styles.metaLine}>
              <Text style={styles.meta} numberOfLines={1}>{`Website · ${created}`}</Text>
              {chip}
            </View>
          </View>
        </Pressable>
        {live}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Pressable style={styles.cardOpen} onPress={open} disabled={!open} accessibilityRole="button" accessibilityLabel={label}>
        <View style={[styles.tile, { backgroundColor: colors.avatarGreen }]}>
          <View style={styles.iconBadge}>
            <ArtifactGlyph name="globe" size={24} color={colors.ink} />
          </View>
          {chip}
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardTitle} numberOfLines={1}>{site.title}</Text>
          <Text style={styles.cardMeta} numberOfLines={1}>{`Website · ${created}`}</Text>
        </View>
      </Pressable>
      {live}
    </View>
  );
});

function chipBackground(colors: Colors, tone: SiteBadgeTone): string {
  if (tone === "success") return colors.greenFill;
  if (tone === "danger") return colors.redFill;
  return colors.panel;
}

function chipText(colors: Colors, tone: SiteBadgeTone): string {
  return tone === "success" || tone === "danger" ? colors.onAccent : colors.ink;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: {
    width: "100%",
    overflow: "hidden",
    position: "relative",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 19,
    backgroundColor: colors.panel,
  },
  cardOpen: { width: "100%" },
  tile: {
    height: 135,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
  },
  iconBadgeCompact: { width: 32, height: 32, borderRadius: radius.sm },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  chipText: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.xs,
    lineHeight: 16,
  },
  cardInfo: { padding: space.md },
  cardTitle: {
    paddingRight: space.md,
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.md,
    lineHeight: 18,
    color: colors.ink,
  },
  cardMeta: {
    marginTop: space.xs,
    paddingRight: 30,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: font.size.sm,
    lineHeight: 16,
    color: colors.muted,
  },
  liveGrid: {
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
  rowOpen: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.md },
  tileCompact: {
    width: 56,
    height: 56,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  info: { flex: 1, minWidth: 0 },
  rowTitle: {
    fontFamily: font.family.semi,
    fontSize: 14,
    lineHeight: 18,
    color: colors.ink,
    includeFontPadding: false,
  },
  metaLine: { marginTop: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  meta: {
    flexShrink: 1,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  liveList: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
});
