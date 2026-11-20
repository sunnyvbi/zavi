import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { Icon } from "../Icon";
import { ChannelLogo } from "./ChannelGlyph";
import {
  coverOf,
  handleChips,
  metaLine,
  ratingLine,
  platformChannel,
  type HandleChip,
} from "../../features/channels/creatorProfile";
import type { CreatorCard } from "../../features/channels/ugc";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function CreatorCover({ c, onPlayIntro, introBusy }: { c: CreatorCard; onPlayIntro?: () => void; introBusy?: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const cover = coverOf(c);
  const rating = ratingLine(c.rating);
  const meta = metaLine(c);
  return (
    <View style={styles.cover} accessibilityLabel={cover.kind === "photo" ? `${c.display_name}'s photo` : undefined}>
      {cover.kind === "initials" ? (
        <View style={styles.initialsBox}>
          <Text style={styles.initials}>{cover.text}</Text>
        </View>
      ) : (
        <Image source={{ uri: cover.url }} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityLabel={cover.kind === "illustration" ? `Illustration for ${c.display_name}'s niches` : `${c.display_name}'s photo`} />
      )}
      <View style={styles.tags}>
        {cover.kind === "illustration" ? (
          <View style={styles.tag}>
            <Text style={styles.tagText}>Illustration</Text>
          </View>
        ) : null}
        {c.has_intro_video && onPlayIntro ? (
          <Pressable style={({ pressed }) => [styles.tag, pressed && styles.pressed]} onPress={onPlayIntro} disabled={introBusy} accessibilityRole="button" accessibilityLabel={`Play ${c.display_name}'s intro video`}>
            {introBusy ? <Icon name="loader" size={13} color={colors.onInk} /> : <View style={styles.play} />}
            <Text style={styles.tagText}>{introBusy ? "Loading…" : "Play intro"}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.foot}>
        <View style={styles.footRow}>
          <Text style={styles.name} numberOfLines={1}>
            {c.display_name}
          </Text>
          {c.invited ? (
            <View style={styles.tag}>
              <Text style={styles.tagText}>Invited</Text>
            </View>
          ) : rating.reviewed ? (
            <View style={styles.starRow}>
              <Text style={styles.star}>★</Text>
              <Text style={styles.tagText}>{rating.text}</Text>
            </View>
          ) : (
            <View style={styles.tag}>
              <Text style={styles.tagText}>{rating.text}</Text>
            </View>
          )}
        </View>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Chip({ chip }: { chip: HandleChip }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const channel = platformChannel(chip.platform);
  const inner = (
    <>
      {channel ? <ChannelLogo slug={channel} size={18} /> : null}
      <Text style={styles.chipText} numberOfLines={1}>
        {chip.text}
      </Text>
      {chip.url ? <Icon name="externalLink" size={12} color={colors.muted} /> : null}
    </>
  );
  return chip.url ? (
    <Pressable style={({ pressed }) => [styles.chip, pressed && styles.pressed]} onPress={() => void Linking.openURL(chip.url as string).catch(() => {})} accessibilityRole="link" accessibilityLabel={chip.hint}>
      {inner}
    </Pressable>
  ) : (
    <View style={styles.chip} accessibilityLabel={chip.hint}>
      {inner}
    </View>
  );
}

export function HandleChips({ socials }: { socials: CreatorCard["socials"] }) {
  const styles = useStyles(makeStyles);
  const chips = handleChips(socials);
  if (!chips.length) return null;
  return (
    <View style={styles.chips}>
      {chips.map((c) => (
        <Chip key={c.key} chip={c} />
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    cover: { height: 240, borderRadius: 16, overflow: "hidden", backgroundColor: colors.soft },
    initialsBox: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", paddingBottom: 40, backgroundColor: colors.ink },
    initials: { fontFamily: font.family.semi, fontSize: 40, letterSpacing: 1, color: colors.onInk },
    tags: { position: "absolute", top: 10, right: 10, flexDirection: "row", gap: 8 },
    tag: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: "rgba(0,0,0,0.55)" },
    tagText: { fontFamily: font.family.semi, fontSize: 12, color: "#ffffff" },
    foot: { position: "absolute", left: 0, right: 0, bottom: 0, gap: 2, paddingHorizontal: 14, paddingTop: 28, paddingBottom: 12, backgroundColor: "rgba(0,0,0,0.5)" },
    footRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { flexShrink: 1, fontFamily: font.family.semi, fontSize: 20, color: "#ffffff" },
    play: { width: 0, height: 0, borderTopWidth: 5, borderBottomWidth: 5, borderLeftWidth: 8, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: "#ffffff" },
    star: { fontSize: 13, color: "#f5b301" },
    starRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    meta: { fontFamily: font.family.medium, fontSize: 13, color: "rgba(255,255,255,0.85)" },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3, paddingLeft: 3, paddingRight: 9, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
    chipText: { maxWidth: 140, fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    pressed: { opacity: 0.7 },
  });
