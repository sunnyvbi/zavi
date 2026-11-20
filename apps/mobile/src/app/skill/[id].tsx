import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen } from "../../components/Screen";
import { Markdown } from "../../components/Markdown";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ZaviTextField } from "../../components/ZaviTextField";
import { BackHeader, Message, PrimaryButton, settingsStyles } from "../../components/settings/SettingsUI";
import { useDeleteSkill, useSaveSkill, useSkills } from "../../features/skill/api";
import { SKILL_MAX_TITLE_CHARS, normalizeTags, type Skill } from "../../features/skill/skillText";
import { useCanManage } from "../../features/settings/api";
import { friendlyError } from "../../components/ErrorCard";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Draft = { title: string; body: string; tags: string };

const draftOf = (s: Skill | null): Draft => ({
  title: s?.title ?? "",
  body: s?.body_markdown ?? "",
  tags: s?.tags.join(", ") ?? "",
});

export default function SkillScreen() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id = "new" } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const q = useSkills();
  const canEdit = useCanManage();
  const save = useSaveSkill();
  const remove = useDeleteSkill();
  const skill = isNew ? null : (q.data ?? []).find((s) => s.id === id) ?? null;
  const [editing, setEditing] = useState(isNew);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (skill && !editing) setDraft(draftOf(skill));
  }, [skill, editing]);

  const baseline = draftOf(skill);
  const dirty =
    isNew ||
    draft.title.trim() !== baseline.title.trim() ||
    draft.body.trim() !== baseline.body.trim() ||
    normalizeTags(draft.tags).join(",") !== normalizeTags(baseline.tags).join(",");

  function onSave() {
    const body = draft.body.trim();
    if (!body) return setError("A skill needs a description. Describe how the company does this.");
    setError(null);
    save.mutate(
      { id: skill?.id ?? null, title: draft.title.trim(), body_markdown: body, tags: normalizeTags(draft.tags) },
      {
        onSuccess: () => (isNew ? router.back() : setEditing(false)),
        onError: (e) => setError(friendlyError(e, "Couldn't save this skill. Try again.")),
      },
    );
  }

  function onDelete() {
    if (!skill) return;
    setConfirmDelete(false);
    remove.mutate(skill.id, {
      onSuccess: () => router.back(),
      onError: (e) => setError(friendlyError(e, "Couldn't delete this skill. Try again.")),
    });
  }

  if (!isNew && !skill) {
    return (
      <Screen>
        <BackHeader title="Skill" />
        {q.isLoading ? (
          <ActivityIndicator style={styles.loading} color={colors.muted} />
        ) : (
          <View style={settingsStyles.content}>
            <Message tone="error">This skill was deleted or couldn&apos;t be loaded.</Message>
          </View>
        )}
      </Screen>
    );
  }

  if (editing) {
    return (
      <Screen>
        <BackHeader title={isNew ? "New skill" : "Edit skill"} />
        <KeyboardAvoider style={styles.flex}>
          <ScrollView
            contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
            keyboardShouldPersistTaps="handled"
          >
            <ZaviTextField
              title="Title"
              containerStyle={styles.field}
              value={draft.title}
              onChangeText={(title) => setDraft((d) => ({ ...d, title }))}
              placeholder="e.g. How we handle a refund request"
              maxLength={SKILL_MAX_TITLE_CHARS}
              accessibilityLabel="Skill title"
              autoFocus={isNew}
              maxLines={1}
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
            />
            <ZaviTextField
              title="What the skill is"
              containerStyle={styles.field}
              value={draft.body}
              onChangeText={(body) => {
                setDraft((d) => ({ ...d, body }));
                setError(null);
              }}
              placeholder="Describe the procedure in your own words: the steps, the judgement calls, what to do when it goes wrong."
              minLines={9}
              maxLines={12}
              accessibilityLabel="What the skill is"
            />
            <ZaviTextField
              title="Tags"
              containerStyle={styles.field}
              value={draft.tags}
              onChangeText={(tags) => setDraft((d) => ({ ...d, tags }))}
              placeholder="refunds, support, policy"
              autoCapitalize="none"
              accessibilityLabel="Tags"
              maxLines={1}
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
            />
            {error ? (
              <View style={styles.errorGap}>
                <Message tone="error">{error}</Message>
              </View>
            ) : null}
            <PrimaryButton
              label={isNew ? "Create skill" : "Save changes"}
              onPress={onSave}
              busy={save.isPending}
              disabled={!dirty}
            />
            <Pressable
              style={styles.cancel}
              onPress={() => {
                if (isNew) router.back();
                else {
                  setDraft(draftOf(skill));
                  setError(null);
                  setEditing(false);
                }
              }}
              disabled={save.isPending}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoider>
      </Screen>
    );
  }

  return (
    <Screen>
      <BackHeader title="Skill" />
      <ScrollView contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}>
        <Text style={styles.title}>{skill?.title || "Untitled skill"}</Text>
        {skill && skill.tags.length ? (
          <View style={styles.tags}>
            {skill.tags.map((t) => (
              <Text key={t} style={styles.tag}>
                {t}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={styles.body}>
          <Markdown body={skill?.body_markdown ?? ""} />
        </View>
        {error ? <Message tone="error">{error}</Message> : null}
        {canEdit ? (
          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
              onPress={() => {
                setDraft(draftOf(skill));
                setEditing(true);
              }}
              accessibilityRole="button"
            >
              <Text style={styles.actionText}>Edit</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.action, (pressed || remove.isPending) && styles.pressed]}
              onPress={() => setConfirmDelete(true)}
              disabled={remove.isPending}
              accessibilityRole="button"
            >
              <Text style={[styles.actionText, styles.danger]}>{remove.isPending ? "Deleting…" : "Delete"}</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
      <ConfirmDialog
        visible={confirmDelete}
        icon="trash"
        title="Delete this skill?"
        message="Every agent stops using it. This can't be undone."
        cancelLabel="Keep it"
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={onDelete}
      />
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: space.xl },
  title: { fontFamily: font.family.bold, fontSize: 20, lineHeight: 26, color: colors.ink },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.sm },
  tag: {
    fontFamily: font.family.medium,
    fontSize: font.size.xs,
    color: colors.muted,
    backgroundColor: colors.soft,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
  },
  body: { marginTop: space.md, marginBottom: space.md },
  field: { marginTop: 16 },
  errorGap: { marginTop: space.md },
  cancel: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: space.sm },
  cancelText: { fontFamily: font.family.semi, fontSize: font.size.base, color: colors.muted },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  action: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { fontFamily: font.family.semi, fontSize: font.size.sm, color: colors.ink },
  danger: { color: colors.red },
  pressed: { opacity: 0.6 },
});
