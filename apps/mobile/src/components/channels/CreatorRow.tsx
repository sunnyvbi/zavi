import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { ChannelLogo } from "./ChannelGlyph";
import { Chip } from "./UgcParts";
import { coverOf, compactCount, initials, platformChannel, ratingLine } from "../../features/channels/creatorProfile";
import { locationLine, money, nicheChips, nicheLabel, type CreatorSearchRow } from "../../features/channels/ugc";
import { useCreatorCard } from "../../features/channels/ugcHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

const SIZE = 60;

export function CreatorRow({ c, onOpen }: { c: CreatorSearchRow; onOpen: () => void }) {
  const styles = useStyles(makeStyles);
  const card = useCreatorCard(c.invited ? "" : c.human_member_id).data;
  const cover = card ? coverOf(card) : null;
  const rating = card ? ratingLine(card.rating) : null;
  const place = locationLine(c.location);
  const platforms = c.platforms.slice(0, 3).map(nicheLabel).join(", ");
  const handles = (c.handles ?? []).slice(0, 4);
  const niches = nicheChips(c.niches);
  const packages = c.packages?.length ?? 0;
  const price = c.from_price_business_total_cents;

  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${c.display_name}, view profile`}>
      <View style={styles.photo}>
        {cover && cover.kind !== "initials" ? (
          <Image source={{ uri: cover.url }} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityLabel={`${c.display_name}'s photo`} />
        ) : (
          <Text style={styles.initials}>{initials(c.display_name)}</Text>
        )}
      </View>
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.name} numberOfLines={1}>
            {c.display_name}
          </Text>
          <View style={styles.priceBox}>
            {price ? (
              <>
                <Text style={styles.from}>From</Text>
                <Text style={styles.price}>{money(price)}</Text>
              </>
            ) : null}
          </View>
        </View>
        <View style={styles.meta}>
          {c.invited ? (
            <Chip label={c.status_label ?? "Not on Zavi yet"} />
          ) : rating ? (
            <Text style={[styles.rating, rating.reviewed && styles.rated]}>{rating.reviewed ? `★ ${rating.text}` : rating.text}</Text>
          ) : null}
          <Text style={styles.sub} numberOfLines={1}>
            {[place, platforms].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {card?.bio ? (
          <Text style={styles.bio} numberOfLines={1}>
            {card.bio}
          </Text>
        ) : null}
        {handles.length > 0 ? (
          <View style={styles.chips}>
            {handles.map((h) => {
              const channel = platformChannel(h.platform);
              return (
                <View key={`${h.platform}:${h.handle}`} style={styles.handle} accessibilityLabel={`${h.platform} ${h.handle}${h.followers !== null ? `, ${h.followers} followers, self-reported` : ""}`}>
                  {channel ? <ChannelLogo slug={channel} size={16} /> : null}
                  <Text style={styles.handleText} numberOfLines={1}>
                    {h.followers !== null ? compactCount(h.followers) : h.platform === "linkedin" ? h.handle : `@${h.handle}`}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}
        <View style={styles.chips}>
          {niches.shown.map((n) => (
            <Chip key={n} label={nicheLabel(n)} />
          ))}
          {niches.more > 0 ? <Chip label={`+${niches.more}`} /> : null}
        </View>
        {packages > 0 ? <Text style={styles.sub}>{`${packages} ${packages === 1 ? "package" : "packages"}`}</Text> : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
    pressed: { opacity: 0.7 },
    photo: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: colors.soft },
    initials: { fontFamily: font.family.semi, fontSize: 20, color: colors.ink },
    body: { flex: 1, minWidth: 0, gap: 4 },
    top: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
    name: { flex: 1, includeFontPadding: false, fontFamily: font.family.semi, fontSize: 16, color: colors.ink },
    priceBox: { alignItems: "flex-end" },
    from: { fontFamily: font.family.regular, fontSize: 10, color: colors.muted },
    price: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    meta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    rating: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: "hidden", fontFamily: font.family.semi, fontSize: 11, color: colors.textSecondary, backgroundColor: colors.soft },
    rated: { color: colors.ink },
    sub: { flexShrink: 1, includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, color: colors.muted },
    bio: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    handle: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 2, paddingLeft: 2, paddingRight: 8, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
    handleText: { maxWidth: 110, fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
  });
