import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { Icon } from "../Icon";
import { UnderlinedText } from "../UnderlinedText";
import { Caps, CreatorAvatar, UgcButton } from "./UgcParts";
import type { CreatorSummaryView } from "../../features/channels/ugcHire";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function CreatorPhoto({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const styles = useStyles(makeStyles);
  if (!url) return <CreatorAvatar name={name} size={size} />;
  return (
    <Image
      source={{ uri: url }}
      style={[styles.photo, { width: size, height: size, borderRadius: size / 2 }]}
      contentFit="cover"
      accessibilityLabel={`${name}'s photo`}
    />
  );
}

export function CreatorSummaryBlock({ s }: { s: CreatorSummaryView }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.summary}>
      <View style={styles.summaryHead}>
        <Text style={s.reviewed ? styles.rating : styles.noReviews}>{s.reviewed ? `★ ${s.rating}` : s.rating}</Text>
        {s.lanes ? <Text style={styles.meta}>{s.lanes}</Text> : null}
      </View>
      {s.socials.map((a) => (
        <View key={a.key} style={styles.social}>
          <Text style={styles.handle}>{a.handle}</Text>
          {a.followers ? <Text style={styles.meta}>{a.followers}</Text> : null}
          {a.url ? (
            <Pressable
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
              onPress={() => void Linking.openURL(a.url as string).catch(() => {})}
              hitSlop={6}
              accessibilityRole="link"
              accessibilityLabel={`${a.viewLabel}, ${a.handle}`}
            >
              <UnderlinedText style={styles.linkText}>{a.viewLabel}</UnderlinedText>
            </Pressable>
          ) : null}
        </View>
      ))}
      {s.followersNote ? <Text style={styles.meta}>{s.followersNote}</Text> : null}
      {s.packages.length ? (
        <View style={styles.packages}>
          <Caps>Packages</Caps>
          {s.packages.map((p) => (
            <Text key={p.id} style={styles.pkg}>
              <Text style={styles.pkgHead}>{p.head}</Text>
              {` · ${p.terms}`}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.loadError} accessibilityRole="alert">
      <Text style={styles.loadErrorText}>{message}</Text>
      <UgcButton label="Retry" variant="secondary" onPress={onRetry} />
    </View>
  );
}

export function YesNo({ value, onChange, label, disabled = false }: { value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.pills} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {([false, true] as const).map((v) => (
        <Pressable
          key={String(v)}
          style={({ pressed }) => [styles.pill, value === v && styles.pillOn, pressed && styles.pressed, disabled && styles.disabled]}
          onPress={() => onChange(v)}
          disabled={disabled}
          accessibilityRole="radio"
          accessibilityLabel={v ? "Yes" : "No"}
          accessibilityState={{ checked: value === v, disabled }}
        >
          <Text style={[styles.pillText, value === v && styles.pillTextOn]}>{v ? "Yes" : "No"}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function TickRow({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.tickRow, pressed && styles.pressed, disabled && styles.disabled]}
      onPress={() => onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
    >
      <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Icon name="tick" size={14} color={colors.onInk} /> : null}</View>
      <Text style={styles.tickText}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    photo: { backgroundColor: colors.soft },
    summary: { alignSelf: "stretch", gap: 6, padding: space.md, borderRadius: radius.sm, backgroundColor: colors.soft },
    summaryHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
    rating: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    noReviews: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 17, color: colors.blue },
    meta: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    social: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.sm },
    handle: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    link: { alignSelf: "flex-start" },
    linkText: { fontFamily: font.family.medium, fontSize: 12, color: colors.blue },
    packages: { gap: 4, marginTop: 4 },
    pkg: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    pkgHead: { fontFamily: font.family.semi, color: colors.ink },
    loadError: { alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingTop: 40 },
    loadErrorText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted, textAlign: "center" },
    pills: { flexDirection: "row", gap: space.sm },
    pill: { minHeight: 36, minWidth: 64, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
    pillOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    pillText: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 18, color: colors.ink },
    pillTextOn: { color: colors.onInk },
    tickRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 4 },
    box: { width: 22, height: 22, marginTop: 1, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: colors.ink, borderRadius: 6 },
    boxOn: { backgroundColor: colors.ink },
    tickText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.4 },
  });
