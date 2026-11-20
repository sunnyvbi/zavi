import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ErrorCard } from "../../components/ErrorCard";
import { Screen } from "../../components/Screen";
import { ZaviTextField, hintText } from "../../components/ZaviTextField";
import {
  BackHeader,
  Intro,
  Message,
  PrimaryButton,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import {
  FACT_HINT,
  FACT_LABEL,
  FACT_MAX,
  FACT_ORDER,
  emptyFacts,
  useCanManage,
  useCompanyFacts,
  useSaveCompanyFacts,
  type FactKey,
  type Facts,
} from "../../features/settings/api";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { useKeyboardOpen } from "../../components/useKeyboardReveal";

const MULTILINE: ReadonlySet<FactKey> = new Set(["competitors", "company_goals"]);

function validate(key: FactKey, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > FACT_MAX[key]) return `Keep this under ${FACT_MAX[key]} characters.`;
  if (key === "domain") {
    const host = v.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
    if (!host.includes(".")) return "Enter a full website address, e.g. https://www.example.com.";
  }
  if (key === "company_name" && v.length < 2) return "Use at least 2 characters.";
  return null;
}

export default function Company() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const canEdit = useCanManage();
  const factsQ = useCompanyFacts();
  const save = useSaveCompanyFacts();

  const [vals, setVals] = useState<Facts>(emptyFacts);
  const [errors, setErrors] = useState<Partial<Record<FactKey, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (factsQ.data) setVals(factsQ.data);
  }, [factsQ.data]);

  const loaded = factsQ.data ?? emptyFacts();
  const changed = FACT_ORDER.filter((k) => vals[k].trim() !== loaded[k].trim());

  async function onSave() {
    setNotice(null);
    const errs: Partial<Record<FactKey, string>> = {};
    for (const k of changed) {
      const msg = validate(k, vals[k]);
      if (msg) errs[k] = msg;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    try {
      const res = await save.mutateAsync(
        Object.fromEntries(changed.map((k) => [k, vals[k]])) as Partial<Facts>,
      );
      const dropped = (res.rejected ?? []).flatMap((r) => r.dropped);
      setNotice(
        dropped.length > 0
          ? `Saved. Dropped from competitors: ${dropped.join(", ")}.`
          : "Saved. Your agents use these from their next run.",
      );
    } catch {
    }
  }

  return (
    <Screen>
      <BackHeader title="Company" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[settingsStyles.content, { paddingBottom: canEdit ? 20 : insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Intro>
            {canEdit
              ? "Give your team the basics. Every agent reads these before it works."
              : "What your agents know about this company. Only owners and admins can change it."}
          </Intro>

          {factsQ.isLoading ? (
            <ActivityIndicator style={styles.loading} color={colors.muted} />
          ) : factsQ.isError ? (
            <Message tone="error">Couldn't load company details. Go back and try again.</Message>
          ) : (
            <>
              {FACT_ORDER.map((k) =>
                canEdit ? (
                  <View key={k} style={styles.field}>
                    <ZaviTextField
                      title={FACT_LABEL[k]}
                      error={!!errors[k]}
                      value={vals[k]}
                      onChangeText={(t) => {
                        setVals((v) => ({ ...v, [k]: t }));
                        setErrors((e) => ({ ...e, [k]: undefined }));
                        setNotice(null);
                      }}
                      minLines={MULTILINE.has(k) ? 3 : 1}
                      maxLines={MULTILINE.has(k) ? 6 : k === "domain" ? 1 : 4}
                      multiline={k !== "domain"}
                      returnKeyType={MULTILINE.has(k) ? "default" : "done"}
                      submitBehavior={MULTILINE.has(k) ? "newline" : "blurAndSubmit"}
                      maxLength={FACT_MAX[k]}
                      autoCapitalize={k === "domain" ? "none" : "sentences"}
                      autoCorrect={k !== "domain"}
                      keyboardType={k === "domain" ? "url" : "default"}
                      placeholder={k === "domain" ? undefined : FACT_HINT[k]}
                    />
                    {k === "domain" && !vals[k] ? (
                      <Text style={styles.oneLineHint} numberOfLines={1} pointerEvents="none">
                        {hintText(FACT_HINT[k])}
                      </Text>
                    ) : null}
                    {errors[k] ? <ErrorCard message={errors[k]} /> : null}
                  </View>
                ) : (
                  <View key={k} style={styles.field}>
                    <ZaviTextField
                      title={FACT_LABEL[k]}
                      value={loaded[k]}
                      editable={false}
                      minLines={1}
                      maxLines={MULTILINE.has(k) ? 6 : k === "domain" ? 1 : 4}
                      multiline={k !== "domain"}
                      placeholder="Not set"
                    />
                  </View>
                ),
              )}

              {save.isError ? (
                <Message tone="error">
                  {(save.error as Error)?.message || "Couldn't save. Try again."}
                </Message>
              ) : null}
              {notice ? <Message>{notice}</Message> : null}
            </>
          )}
        </ScrollView>

        {canEdit && factsQ.data ? (
          <View style={[styles.saveBar, { paddingBottom: keyboardOpen ? space.md : space.md + insets.bottom }]}>
            <PrimaryButton
              label="Save changes"
              onPress={() => void onSave()}
              disabled={changed.length === 0}
              busy={save.isPending}
              style={styles.saveButton}
            />
          </View>
        ) : null}
      </KeyboardAvoider>
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: space.xl },
  field: { marginTop: 16 },
  saveBar: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
  },
  saveButton: { marginTop: 0 },
  oneLineHint: {
    position: "absolute",
    top: 27,
    left: 13,
    right: 13,
    height: 40,
    lineHeight: 40,
    fontFamily: font.family.medium,
    fontSize: 15,
    includeFontPadding: false,
    color: colors.muted,
  },
});
