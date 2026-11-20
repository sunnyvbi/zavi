import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Icon } from "../Icon";
import { SkeletonBlock } from "../Skeleton";
import { hintText } from "../ZaviTextField";
import { Message, SecondaryButton, SectionLabel, settingsStyles } from "../settings/SettingsUI";
import { useSkills } from "../../features/skill/api";
import { matchesSkill, previewOf, type Skill } from "../../features/skill/skillText";
import { useCanManage } from "../../features/settings/api";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function SkillsList() {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const q = useSkills();
  const canEdit = useCanManage();
  const [query, setQuery] = useState("");
  const skills = q.data ?? [];
  const shown = skills.filter((s) => matchesSkill(s, query));
  const openSkill = (id: string) => router.push({ pathname: "/skill/[id]", params: { id } });

  return (
    <ScrollView
      contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.head}>
        <Text style={styles.intro}>Skills help you create outcomes with repeatability.</Text>
        {canEdit && q.isLoading ? (
          <SkeletonBlock width={112} height={36} radius={radius.pill} />
        ) : canEdit && skills.length > 0 ? (
          <Pressable
            style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}
            onPress={() => openSkill("new")}
            accessibilityRole="button"
          >
            <Icon name="plus" size={16} color={colors.onInk} />
            <Text style={styles.newText}>New skill</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.search}>
        <Icon name="search" size={17} color={colors.muted} />
        <TextInput
          keyboardAppearance={keyboardAppearance}
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={hintText("Search for skills")}
          placeholderTextColor={colors.muted}
          cursorColor={colors.ink}
          selectionColor={textSelectionColor}
          selectionHandleColor={colors.ink}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search skills"
          clearButtonMode="while-editing"
        />
      </View>

      <SectionLabel>Active Skills</SectionLabel>
      {q.isLoading ? (
        <SkillsSkeleton />
      ) : q.isError ? (
        <View style={styles.gap}>
          <Message tone="error">Couldn&apos;t load skills. Check your connection and try again.</Message>
          <SecondaryButton label="Retry" onPress={() => void q.refetch()} />
        </View>
      ) : skills.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            <Text style={styles.strong}>Skills</Text> are short write-ups of how your company does a recurring task:
            refunds, onboarding a host, qualifying a lead. Every agent reads them, so writing one teaches the whole
            fleet at once.
          </Text>
          {canEdit ? (
            <Pressable
              style={({ pressed }) => [styles.newButton, styles.firstButton, pressed && styles.pressed]}
              onPress={() => openSkill("new")}
              accessibilityRole="button"
            >
              <Icon name="plus" size={16} color={colors.onInk} />
              <Text style={styles.newText}>Write your first skill</Text>
            </Pressable>
          ) : null}
        </View>
      ) : shown.length === 0 ? (
        <Text style={styles.muted}>No skills match this search.</Text>
      ) : (
        <View style={styles.cards}>
          {shown.map((s) => (
            <SkillCard key={s.id} skill={s} onPress={() => openSkill(s.id)} />
          ))}
        </View>
      )}

      <Text style={[styles.muted, styles.footer]}>Uploading a skill file is on the web under Connectors, Skills.</Text>
    </ScrollView>
  );
}

function SkillsSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.cards} accessible accessibilityLabel="Loading skills" accessibilityState={{ busy: true }}>
      {Array.from({ length: 4 }, (_, i) => (
        <View key={i} style={styles.card}>
          <SkeletonBlock width="55%" height={16} style={styles.skeletonTitle} />
          <SkeletonBlock height={13} style={styles.skeletonLine} />
          <SkeletonBlock height={13} style={styles.skeletonLine} />
          <SkeletonBlock width="70%" height={13} style={styles.skeletonLine} />
          <View style={styles.cardFoot}>
            <SkeletonBlock width={60} height={12} />
            <SkeletonBlock width={70} height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

function SkillCard({ skill, onPress }: { skill: Skill; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={skill.title || "Untitled skill"}
    >
      <Text style={styles.cardTitle} numberOfLines={2}>
        {skill.title || "Untitled skill"}
      </Text>
      <Text style={styles.cardBody} numberOfLines={3}>
        {previewOf(skill.body_markdown)}
      </Text>
      <View style={styles.cardFoot}>
        <View style={styles.shared}>
          <Icon name="check" size={13} color={colors.muted} />
          <Text style={styles.footText}>Shared</Text>
        </View>
        <Text style={styles.footText}>{new Date(skill.updated_at).toLocaleDateString()}</Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  intro: { flex: 1, fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, color: colors.muted },
  newButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  firstButton: { alignSelf: "flex-start", marginTop: space.md },
  newText: { fontFamily: font.family.semi, fontSize: font.size.sm, color: colors.onInk },
  pressed: { opacity: 0.85 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.md,
    marginBottom: -8,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
  },
  searchInput: { flex: 1, fontFamily: font.family.medium, fontSize: 15, color: colors.ink, paddingVertical: 10 },
  skeletonTitle: { marginVertical: 2 },
  skeletonLine: { marginVertical: 2.5 },
  gap: { gap: space.md },
  empty: { paddingVertical: space.sm },
  emptyText: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 20, color: colors.muted },
  strong: { fontFamily: font.family.semi, color: colors.ink },
  muted: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, color: colors.muted },
  footer: { marginTop: space.lg },
  cards: { gap: space.sm },
  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.panel,
    padding: space.md,
    gap: space.xs,
  },
  cardPressed: { backgroundColor: colors.soft },
  cardTitle: { fontFamily: font.family.semi, fontSize: font.size.base, lineHeight: 20, color: colors.ink },
  cardBody: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, color: colors.muted },
  cardFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: space.xs },
  shared: { flexDirection: "row", alignItems: "center", gap: 4 },
  footText: { fontFamily: font.family.medium, fontSize: font.size.xs, color: colors.muted },
});
