import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import Svg, { Path } from "react-native-svg";
import { Chip, ReadOnlyNote, StateLine, UgcScreen } from "../../../../components/channels/UgcParts";
import { CreatorCover, HandleChips } from "../../../../components/channels/CreatorProfileParts";
import { MediaViewer } from "../../../../components/MediaViewer";
import { followersNote, packagesHeading } from "../../../../features/channels/creatorProfile";
import { useIntroVideo } from "../../../../features/channels/introVideo";
import { money, nicheLabel, packageFacts } from "../../../../features/channels/ugc";
import { bookLabel, bookRoute } from "../../../../features/channels/ugcHire";
import { useCanWrite, useCreatorCard } from "../../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../../lib/flags";
import { font, radius, space, type Colors } from "../../../../theme/tokens";
import { useStyles, useTheme } from "../../../../theme/theme";

export default function CreatorProfileRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <CreatorProfile />;
}

function CreatorProfile() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const q = useCreatorCard(id);
  const canWrite = useCanWrite();
  const c = q.data;
  const intro = useIntroVideo(c?.human_member_id ?? id, c?.display_name ?? "Creator");

  return (
    <UgcScreen title={c?.display_name ?? "Creator"}>
      {!c ? (
        <StateLine loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} empty="This creator isn't available." />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <CreatorCover c={c} onPlayIntro={c.has_intro_video ? () => void intro.play() : undefined} introBusy={intro.busy} />
          {intro.error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {intro.error}
            </Text>
          ) : null}
          <HandleChips socials={c.socials} />
          {followersNote(c.socials) ? <Text style={styles.sub}>{followersNote(c.socials)}</Text> : null}
          {c.invited ? <Chip label={c.status_label ?? "Not on Zavi yet"} /> : null}
          {c.bio ? <Text style={styles.bio}>{c.bio}</Text> : null}
          {c.niches.length ? (
            <View style={styles.chips}>
              {c.niches.map((n) => (
                <Chip key={n} label={nicheLabel(n)} />
              ))}
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            onPress={() => router.push({ pathname: "/channels/ugc/thread/[id]", params: { id: c.human_member_id } })}
            accessibilityRole="button"
            accessibilityLabel={`Message ${c.display_name}`}
          >
            <Text style={styles.primaryText}>Message</Text>
          </Pressable>

          {c.packages.length ? (
            <View style={styles.section}>
              <Text style={styles.caps}>{packagesHeading(c.packages, money)}</Text>
              {c.packages.map((p) => (
                <View key={p.id} style={styles.pkg}>
                  <View style={styles.pkgText}>
                    <Text style={styles.lineMain}>{p.title}</Text>
                    <Text style={styles.sub}>{packageFacts(p)}</Text>
                  </View>
                  <View style={styles.priceBox}>
                    <Text style={styles.price}>{money(p.price_cents)}</Text>
                    {c.bookable && canWrite ? (
                      <Pressable
                        style={({ pressed }) => [styles.book, pressed && styles.bookPressed]}
                        onPress={() => {
                          const to = bookRoute(p);
                          router.push({ pathname: to.pathname as never, params: to.params });
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Book ${p.title}, ${money(p.business_total_cents)}`}
                      >
                        <Text style={styles.bookText}>{bookLabel(p)}</Text>
                        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                          <Path d="M5 12h14M12 5l7 7-7 7" stroke={colors.onInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                        </Svg>
                      </Pressable>
                    ) : c.bookable ? (
                      <Text style={styles.sub}>{bookLabel(p)}</Text>
                    ) : null}
                  </View>
                </View>
              ))}
              {!c.bookable ? <Text style={styles.sub}>Booking isn't open for this creator yet.</Text> : !canWrite ? <ReadOnlyNote /> : null}
            </View>
          ) : null}
        </ScrollView>
      )}
      <MediaViewer item={intro.item} onClose={intro.close} />
    </UgcScreen>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    bio: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.ink },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    primary: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.ink },
    primaryText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
    pressed: { opacity: 0.7 },
    section: { gap: space.sm, marginTop: space.sm },
    caps: { fontFamily: font.family.semi, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: colors.muted },
    line: { gap: 2, paddingVertical: 4 },
    lineMain: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    pkg: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    pkgText: { flex: 1, gap: 2 },
    price: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    priceBox: { alignItems: "flex-end", gap: 1 },
    book: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.ink },
    bookText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.onInk },
    bookPressed: { opacity: 0.8 },
    error: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 17, color: colors.red },
  });
