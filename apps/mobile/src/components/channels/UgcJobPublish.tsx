import { useRef, useState, type ComponentProps } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Icon } from "../Icon";
import { OptionSheet } from "../OptionSheet";
import { UnderlinedText } from "../UnderlinedText";
import { FocusRing } from "../ZaviTextField";
import type { Revealable } from "../useKeyboardReveal";
import { ToneChip } from "./UgcParts";
import { ErrorText, ReadOnlyNote, StateLine, UgcButton } from "./UgcParts";
import {
  EMPTY_PUBLISH_FORM,
  PUBLISH_PLATFORMS,
  canCheckAgain,
  localDateTimeText,
  platformLabel,
  publicationBadge,
  publicationLine,
  publicationTitle,
  publishBody,
  publishSub,
  whenInvalid,
  type PublishForm,
} from "../../features/channels/ugcJob";
import { useAddPublication, usePublications, useVerifyPublication } from "../../features/channels/ugcJobHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const errorOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function PublishCard({ orderId, first, canWrite, reveal }: { orderId: string; first: string; canWrite: boolean; reveal: (t: Revealable | null) => void }) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const q = usePublications(orderId, true);
  const add = useAddPublication(orderId);
  const verify = useVerifyPublication(orderId);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<PublishForm>(EMPTY_PUBLISH_FORM);
  const [picking, setPicking] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const refs = { account: useRef<TextInput>(null), url: useRef<TextInput>(null), when: useRef<TextInput>(null) };
  const lock = useRef(false);
  const data = q.data;
  const body = publishBody(form);
  const set = (patch: Partial<PublishForm>) => setForm((f) => ({ ...f, ...patch }));
  const example = localDateTimeText(new Date());

  function save() {
    if (!body || add.isPending || lock.current) return;
    lock.current = true;
    setFormError(null);
    add.mutate(body, {
      onSuccess: () => {
        setAdding(false);
        setForm((f) => ({ ...f, url: "", when: "" }));
      },
      onError: (e) => setFormError(errorOf(e, "Could not save that post. Try again.")),
      onSettled: () => {
        lock.current = false;
      },
    });
  }

  function recheck(id: string) {
    if (verify.isPending || lock.current) return;
    lock.current = true;
    setCheckError(null);
    setChecking(id);
    verify.mutate(id, {
      onError: (e) => setCheckError(errorOf(e, "Could not check that post. Try again.")),
      onSettled: () => {
        lock.current = false;
        setChecking(null);
      },
    });
  }

  const field = (label: string, key: "account" | "url" | "when", props: Partial<ComponentProps<typeof TextInput>>) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <FocusRing radius={radius.sm}>
        {(focus) => (
          <TextInput
            ref={refs[key]}
            style={styles.input}
            value={form[key]}
            onChangeText={(v) => set({ [key]: v } as Partial<PublishForm>)}
            onFocus={() => {
              focus.onFocus();
              reveal(refs[key].current);
            }}
            onBlur={focus.onBlur}
            placeholderTextColor={colors.muted}
            keyboardAppearance={keyboardAppearance}
            selectionColor={textSelectionColor}
            cursorColor={colors.ink}
            selectionHandleColor={colors.ink}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={label}
            {...props}
          />
        )}
      </FocusRing>
    </View>
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Where it is published</Text>
      {!data ? (
        <StateLine loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Text style={styles.sub}>{publishSub(data.publisher, first)}</Text>
          {data.publications.length === 0 ? <Text style={styles.body}>Not posted yet.</Text> : null}
          {data.publications.map((p) => {
            const badge = publicationBadge(p);
            return (
              <View key={p.id} style={styles.row}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowTitle}>{publicationTitle(p)}</Text>
                  <ToneChip tone={badge.tone} label={badge.text} />
                </View>
                <Text style={styles.meta}>{publicationLine(p, first)}</Text>
                {p.post_url ? (
                  <Pressable style={styles.link} onPress={() => void Linking.openURL(p.post_url ?? "").catch(() => {})} accessibilityRole="link" accessibilityLabel={`Open the post on ${platformLabel(p.platform)}`}>
                    {}
                    <View style={styles.underline}>
                      <Text style={styles.linkText} numberOfLines={1} ellipsizeMode="middle">
                        {p.post_url}
                      </Text>
                    </View>
                  </Pressable>
                ) : null}
                {p.verification_note ? <Text style={styles.meta}>{p.verification_note}</Text> : null}
                {canWrite && canCheckAgain(p) ? (
                  <Pressable
                    style={[styles.link, verify.isPending && styles.disabled]}
                    onPress={() => recheck(p.id)}
                    disabled={verify.isPending}
                    accessibilityRole="button"
                    accessibilityLabel="Check again"
                    accessibilityState={{ disabled: verify.isPending, busy: checking === p.id }}
                  >
                    <UnderlinedText style={styles.linkText}>{checking === p.id ? "Checking" : "Check again"}</UnderlinedText>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          <ErrorText>{checkError}</ErrorText>
          {data.can_record && !canWrite ? <ReadOnlyNote /> : null}
          {data.can_record && canWrite && !adding ? (
            <View style={styles.start}>
              <UgcButton label="Add a post" variant="secondary" onPress={() => setAdding(true)} />
            </View>
          ) : null}
          {data.can_record && canWrite && adding ? (
            <View style={styles.form}>
              <View style={styles.modes} accessibilityRole="radiogroup" accessibilityLabel="Posted or planned">
                {(["live", "planned"] as const).map((m) => {
                  const on = form.mode === m;
                  return (
                    <Pressable
                      key={m}
                      style={({ pressed }) => [styles.mode, on && styles.modeOn, pressed && styles.pressed]}
                      onPress={() => set({ mode: m })}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={m === "live" ? "It is live" : "Planned"}
                    >
                      <Text style={[styles.modeText, on && styles.modeTextOn]}>{m === "live" ? "It is live" : "Planned"}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Platform</Text>
                <Pressable
                  style={({ pressed }) => [styles.picker, pressed && styles.pressed]}
                  onPress={() => setPicking(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`Platform, ${platformLabel(form.platform)}`}
                >
                  <Text style={styles.pickerText}>{platformLabel(form.platform)}</Text>
                  <Icon name="chevronDown" size={16} color={colors.muted} />
                </Pressable>
              </View>
              {field("Account", "account", { placeholder: "@youraccount" })}
              {form.mode === "live" ? field("Post link", "url", { placeholder: "https://", keyboardType: "url" }) : null}
              {field(form.mode === "live" ? "Posted at (optional, defaults to now)" : "Planned for", "when", { placeholder: example })}
              <Text style={styles.hint}>
                {whenInvalid(form) ? "Check this one. " : ""}Type the time as YYYY-MM-DD HH:MM, on your phone's clock.
              </Text>
              <ErrorText>{formError}</ErrorText>
              <View style={styles.buttons}>
                <UgcButton label="Not now" variant="secondary" disabled={add.isPending} onPress={() => setAdding(false)} />
                <UgcButton label={form.mode === "live" ? "Save and check" : "Save"} busy={add.isPending} busyLabel="Saving" disabled={!body} onPress={save} />
              </View>
            </View>
          ) : null}
        </>
      )}
      <OptionSheet
        open={picking}
        title="Platform"
        options={PUBLISH_PLATFORMS.map((p) => ({ value: p.value, label: p.label }))}
        value={form.platform}
        onPick={(v) => set({ platform: v })}
        onClose={() => setPicking(false)}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    title: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
    meta: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.4 },
    row: { gap: 4, paddingHorizontal: space.md, paddingVertical: 10, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    rowTop: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
    rowTitle: { flexShrink: 1, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    link: { alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 4 },
    linkText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    underline: { borderBottomWidth: 1, borderBottomColor: colors.ink },
    start: { alignSelf: "flex-start" },
    form: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    modes: { flexDirection: "row", gap: space.sm },
    mode: { minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
    modeOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    modeText: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.ink },
    modeTextOn: { color: colors.onInk },
    field: { gap: 4 },
    label: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    input: {
      minHeight: 44,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      fontFamily: font.family.medium,
      fontSize: 15,
      color: colors.ink,
    },
    picker: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
    },
    pickerText: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.ink },
    hint: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 16, color: colors.textSecondary },
    buttons: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
  });
