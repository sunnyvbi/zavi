import { Image } from "expo-image";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import type { IconName } from "./Icon";
import { Icon } from "./Icon";
import { UnderlinedText } from "./UnderlinedText";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export const PRIVACY_URL = "https://www.zaviagent.com/privacy";

const DATA_ITEMS: { title: string; body: string; icon: IconName; iconBg: "blueTint" | "greenTint" | "slateTint" }[] = [
  {
    title: "Your messages",
    body: "What you type or say to Zavi.",
    icon: "messageSquare",
    iconBg: "blueTint",
  },
  {
    title: "Your business data",
    body: "Files you add and data from tools you connect, like ads, analytics and your site.",
    icon: "database",
    iconBg: "greenTint",
  },
  {
    title: "Only what the task needs",
    body: "Sent only when Zavi works on something for you.",
    icon: "filter",
    iconBg: "slateTint",
  },
];

export function AiConsentGate({
  onAgree,
  onDecline,
  declineLabel = "Not now",
}: {
  onAgree: () => void;
  onDecline?: () => void;
  declineLabel?: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors, dark } = useTheme();
  return (
    <View style={styles.screen}>
      {}
      <View style={styles.wash} pointerEvents="none">
        {dark ? (
          <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
            <Defs>
              <RadialGradient id="glowBlue" cx="80%" cy="55%" rx="75%" ry="70%">
                <Stop offset="0%" stopColor={colors.accent.blue} stopOpacity={0.3} />
                <Stop offset="100%" stopColor={colors.accent.blue} stopOpacity={0} />
              </RadialGradient>
              <RadialGradient id="glowPeach" cx="15%" cy="30%" rx="65%" ry="65%">
                <Stop offset="0%" stopColor={colors.accent.orange} stopOpacity={0.07} />
                <Stop offset="100%" stopColor={colors.accent.orange} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#glowPeach)" />
            <Rect width="100%" height="100%" fill="url(#glowBlue)" />
          </Svg>
        ) : (
          <Image source={require("../../assets/images/consent-bg.webp")} style={StyleSheet.absoluteFill} contentFit="cover" />
        )}
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <LinearGradient id="washFade" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="45%" stopColor={colors.bg} stopOpacity={0} />
              <Stop offset="100%" stopColor={colors.bg} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#washFade)" />
        </Svg>
      </View>

      {}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          {}
          <View style={styles.iconWrap}>
            <View style={styles.iconChip}>
              <Icon name="shieldCheck" size={28} color={colors.ink} strokeWidth={1.8} />
            </View>
            <View style={styles.iconBadge}>
              <Icon name="lock" size={12} color={colors.onInk} strokeWidth={2} />
            </View>
          </View>

          {}
          <View style={styles.titleRow} accessible accessibilityRole="header" accessibilityLabel="Before Zavi starts.">
            <Text style={styles.title}>Before Zavi </Text>
            <View>
              <View style={styles.marker} />
              <Text style={styles.title}>starts.</Text>
            </View>
          </View>
          <Text style={styles.body}>
            To do the work, Zavi sends your messages and business data to third-party AI models from Anthropic and
            OpenAI.
          </Text>
        </View>

        {}
        <View style={styles.items}>
          {DATA_ITEMS.map((item, index) => (
            <View key={item.title} style={[styles.item, index > 0 && styles.itemDivider]}>
              <View style={[styles.itemIcon, { backgroundColor: colors.consent[item.iconBg] }]}>
                <Icon name={item.icon} size={17} color={colors.ink} strokeWidth={1.9} />
              </View>
              <View style={styles.itemText}>
                <Text style={styles.itemTitle}>{item.title}</Text>
                <Text style={styles.itemBody}>{item.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {}
        <View style={styles.footnote}>
          <Text style={styles.footnoteText}>You can see this again any time in</Text>
          <View style={styles.footnoteLinkRow}>
            <Text style={styles.footnoteText}>Settings ›</Text>
            <Pressable
              onPress={() => void Linking.openURL(PRIVACY_URL).catch(() => {})}
              accessibilityRole="link"
              hitSlop={8}
            >
              <UnderlinedText style={styles.link}>Privacy policy</UnderlinedText>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {}
      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          onPress={onAgree}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Agree and continue</Text>
        </Pressable>
        {onDecline ? (
          <Pressable
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            onPress={onDecline}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>{declineLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const text = { includeFontPadding: false } as const;

const makeStyles = (colors: Colors, dark: boolean) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  wash: { position: "absolute", top: 0, left: 0, right: 0, height: 320, opacity: dark ? 1 : 0.9 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
    gap: space.md,
  },
  header: { alignItems: "center" },
  iconWrap: { marginTop: space.lg, marginBottom: space.md },
  iconChip: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.consent.border,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBadge: {
    position: "absolute",
    top: -10,
    right: -10,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.consent.button,
    borderWidth: 2,
    borderColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  titleRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", marginTop: 20 },
  title: { ...text, fontFamily: font.family.semi, fontSize: 24, lineHeight: 30, color: colors.ink },
  marker: {
    position: "absolute",
    left: -2,
    right: -2,
    bottom: 2,
    height: 9,
    borderRadius: 4,
    backgroundColor: colors.consent.highlight,
  },
  body: {
    ...text,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: space.md,
  },
  items: {
    marginTop: 20,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg,
    overflow: "hidden",
  },
  item: { flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: 14 },
  itemDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  itemIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.consent.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  itemText: { flex: 1, minWidth: 0, gap: 2 },
  itemTitle: { ...text, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
  itemBody: {
    ...text,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  footnote: { marginTop: space.lg, alignItems: "center" },
  footnoteLinkRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", columnGap: space.xs },
  footnoteText: {
    ...text,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    textAlign: "center",
  },
  link: { ...text, fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
  primary: {
    alignSelf: "stretch",
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { ...text, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.onInk },
  secondary: { height: 46, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  secondaryText: { ...text, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
  pressed: { opacity: 0.8 },
});
