import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Screen } from "../../components/Screen";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { Icon } from "../../components/Icon";
import { OptionSheet } from "../../components/OptionSheet";
import { ZaviTextField } from "../../components/ZaviTextField";
import { CardButton } from "../../components/reply/ui";
import { BuildErrorState, BuildSkeleton } from "../../components/build/BuildStates";
import { BackHeader, Segmented, SectionLabel, settingsStyles } from "../../components/settings/SettingsUI";
import { previewSiteLogo, saveSiteTheme } from "../../features/build/api";
import { buildKeys, useSiteTheme } from "../../features/build/hooks";
import { drawableLogoSvg } from "../../features/connectors/logoSvg";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import {
  LOGO_IDEAS,
  LOGO_MAX,
  LOGO_PLACEHOLDER,
  RADIUS_LABEL,
  SITE_DESIGN_SAVED,
  THEME_COLORS,
  THEME_UNAVAILABLE,
  applyOp,
  applyScope,
  cleanLogoDescription,
  logoCostLine,
  logoReady,
  readHex,
  refusalNote,
  svgFromDataUrl,
  themeChanges,
  withCurrent,
  type LogoPreview,
  type SiteThemeTokens,
  type ThemeColorKey,
  type ThemeNote,
} from "../../features/build/siteTheme";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Tab = "theme" | "logo";
type Picker = "display" | "body" | "radius" | null;

export default function SiteThemeScreen() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const params = useLocalSearchParams<{ appId?: string; runId?: string }>();
  const appId = typeof params.appId === "string" && params.appId.startsWith("site:") ? params.appId : null;
  const runId = typeof params.runId === "string" ? params.runId : null;
  const q = useSiteTheme(appId);
  const state = q.data ?? null;

  const [tab, setTab] = useState<Tab>("theme");
  const [draft, setDraft] = useState<SiteThemeTokens | null>(null);
  const [typed, setTyped] = useState<Partial<Record<ThemeColorKey, string>>>({});
  const [picker, setPicker] = useState<Picker>(null);
  const [description, setDescription] = useState("");
  const [logo, setLogo] = useState<LogoPreview | null>(null);
  const [freeNext, setFreeNext] = useState(false);
  const [making, setMaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<ThemeNote | null>(null);
  const inFlight = useRef(false);

  const seededFrom = useRef<SiteThemeTokens | null>(null);
  useEffect(() => {
    const next = state?.theme ?? null;
    const dirty = themeChanges(seededFrom.current, draft) !== null;
    seededFrom.current = next;
    if (!dirty) {
      setDraft(next);
      setTyped({});
    }
    setFreeNext(state?.logo_preview_free === true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const current = state?.theme ?? null;
  const changes = useMemo(() => themeChanges(current, draft), [current, draft]);
  const logoOn = state?.logo_ai === true;
  const logoToApply = logoOn ? logo : null;
  const op = applyOp(changes, logoToApply);
  const shown: Tab = logoOn ? tab : "theme";
  const busy = saving || making;

  function edit(patch: Partial<SiteThemeTokens>) {
    setNote(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  function typeColor(key: ThemeColorKey, value: string) {
    setTyped((t) => ({ ...t, [key]: value }));
    const hex = readHex(value);
    if (hex && draft) edit({ colors: { ...draft.colors, [key]: hex } });
  }

  async function makeLogo() {
    if (!appId || !logoReady(description) || inFlight.current) return;
    inFlight.current = true;
    setMaking(true);
    setNote(null);
    try {
      const colors = draft ? { primary: draft.colors.primary, accent: draft.colors.accent } : null;
      setLogo(await previewSiteLogo(appId, cleanLogoDescription(description), colors));
      setFreeNext(false);
    } catch (e) {
      setNote(refusalNote(e));
    } finally {
      inFlight.current = false;
      setMaking(false);
    }
  }

  async function apply() {
    if (!appId || !op || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setNote(null);
    try {
      const theme = await saveSiteTheme(appId, op);
      if (theme) {
        setDraft(theme);
        setTyped({});
        qc.setQueryData(buildKeys.theme(tenant, appId), state ? { ...state, theme, logo_preview_free: freeNext } : state);
      }
      if (op.logo) {
        setLogo(null);
        setDescription("");
      }
      setNote({ tone: "ok", text: SITE_DESIGN_SAVED });
      void qc.invalidateQueries({ queryKey: ["build-publish-status", tenant] });
      if (runId) void qc.invalidateQueries({ queryKey: buildKeys.refines(tenant, runId) });
    } catch (e) {
      setNote(refusalNote(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function reset() {
    setNote(null);
    if (shown === "logo") {
      setDescription("");
      setLogo(null);
      return;
    }
    setDraft(current);
    setTyped({});
  }

  const scope = applyScope(changes !== null, logoToApply !== null);
  const canReset = shown === "logo" ? !!description || !!logo : changes !== null;

  return (
    <Screen>
      <BackHeader title={logoOn ? "Theme and logo" : "Theme"} />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          {!appId ? (
            <BuildErrorState text="This site can't be found." onRetry={() => void q.refetch()} />
          ) : q.isLoading ? (
            <BuildSkeleton rows={5} label="Loading the site's look…" />
          ) : q.isError || !state ? (
            <BuildErrorState text={refusalNote(q.error).text} onRetry={() => void q.refetch()} />
          ) : (
            <>
              {logoOn ? (
                <Segmented
                  label="Theme or logo"
                  value={shown}
                  onChange={(t) => {
                    setNote(null);
                    setTab(t);
                  }}
                  options={[
                    { value: "theme", label: changes ? "Theme •" : "Theme" },
                    { value: "logo", label: logoToApply ? "Logo •" : "Logo" },
                  ]}
                />
              ) : null}

              {shown === "theme" && !current ? <Text style={styles.muted}>{THEME_UNAVAILABLE}</Text> : null}

              {shown === "theme" && current && draft ? (
                <>
                  <SectionLabel first={!logoOn}>Colours</SectionLabel>
                  <View style={styles.colors}>
                    {THEME_COLORS.map(({ key, label }) => (
                      <View key={key} style={styles.colorField}>
                        <View style={[styles.swatch, { backgroundColor: draft.colors[key] }]} />
                        <ZaviTextField
                          title={label}
                          containerStyle={styles.colorInput}
                          value={typed[key] ?? draft.colors[key]}
                          onChangeText={(v) => typeColor(key, v)}
                          onBlur={() => setTyped((t) => ({ ...t, [key]: undefined }))}
                          autoCapitalize="none"
                          autoCorrect={false}
                          maxLength={7}
                          maxLines={1}
                          editable={!busy}
                          accessibilityLabel={`${label} colour`}
                        />
                      </View>
                    ))}
                  </View>

                  <SectionLabel>Fonts and corners</SectionLabel>
                  <PickRow label="Headings" value={draft.fonts.display} disabled={busy} onPress={() => setPicker("display")} />
                  <PickRow label="Body" value={draft.fonts.body} disabled={busy} onPress={() => setPicker("body")} />
                  <PickRow label="Corners" value={RADIUS_LABEL[draft.radius] ?? draft.radius} disabled={busy} onPress={() => setPicker("radius")} />

                  <OptionSheet
                    open={picker === "display" || picker === "body"}
                    title={picker === "body" ? "Body font" : "Headings font"}
                    options={withCurrent(picker === "body" ? draft.fonts.body : draft.fonts.display, state.fonts).map((f) => ({ value: f, label: f }))}
                    value={picker === "body" ? draft.fonts.body : draft.fonts.display}
                    onPick={(f) => edit({ fonts: { ...draft.fonts, [picker === "body" ? "body" : "display"]: f } })}
                    onClose={() => setPicker(null)}
                  />
                  <OptionSheet
                    open={picker === "radius"}
                    title="Corners"
                    options={withCurrent(draft.radius, state.radii).map((r) => ({ value: r, label: RADIUS_LABEL[r] ?? r }))}
                    value={draft.radius}
                    onPick={(r) => edit({ radius: r })}
                    onClose={() => setPicker(null)}
                  />
                </>
              ) : null}

              {shown === "logo" ? (
                <>
                  {logo ? <LogoPreviewBox preview={logo} /> : null}
                  <View style={styles.labelRow}>
                    <Text style={styles.fieldLabel}>Describe the logo</Text>
                    <Text style={styles.count}>{`${description.length}/${LOGO_MAX}`}</Text>
                  </View>
                  <ZaviTextField
                    value={description}
                    onChangeText={(v) => {
                      setDescription(v);
                      setNote(null);
                    }}
                    minLines={3}
                    maxLines={5}
                    maxLength={LOGO_MAX}
                    placeholder={LOGO_PLACEHOLDER}
                    editable={!busy}
                    accessibilityLabel="Describe the logo"
                  />
                  <View style={styles.chips} accessibilityLabel="Logo ideas">
                    {LOGO_IDEAS.map((idea) => (
                      <Pressable
                        key={idea.label}
                        disabled={busy}
                        onPress={() => {
                          setDescription(idea.text);
                          setNote(null);
                        }}
                        accessibilityRole="button"
                        style={styles.chip}
                      >
                        <Text style={styles.chipText}>{idea.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.muted}>{logoCostLine(freeNext, changes !== null)}</Text>
                  <View style={styles.row}>
                    <CardButton
                      label={making ? "Designing…" : logo ? "Make another" : "Make logo"}
                      busy={making}
                      disabled={!logoReady(description) || saving}
                      variant="secondary"
                      onPress={() => void makeLogo()}
                    />
                  </View>
                </>
              ) : null}

              {current || logoOn ? (
                <>
                  {scope ? <Text style={styles.scope}>{scope}</Text> : null}
                  <View style={styles.row}>
                    <CardButton label={saving ? "Applying…" : "Apply"} busy={saving} disabled={!op || making} onPress={() => void apply()} />
                    <CardButton label="Reset" variant="secondary" disabled={busy || !canReset} onPress={reset} />
                  </View>
                </>
              ) : null}

              {note ? <NoteLine note={note} /> : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}

function PickRow({ label, value, disabled, onPress }: { label: string; value: string; disabled: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => [styles.pick, pressed && styles.pressed]}
    >
      <Text style={styles.pickLabel}>{label}</Text>
      <Text style={styles.pickValue} numberOfLines={1}>
        {value}
      </Text>
      <View style={styles.chevron}>
        <Icon name="chevron" size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
}

function LogoPreviewBox({ preview }: { preview: LogoPreview }) {
  const styles = useStyles(makeStyles);
  const xml = drawableLogoSvg(svgFromDataUrl(preview.src));
  return (
    <View style={styles.logoBox}>
      <View style={styles.logoTile}>
        {xml ? <SvgXml xml={xml} width={52} height={52} accessibilityLabel="Logo preview" /> : <Icon name="photo" size={24} />}
      </View>
      <View style={styles.flex}>
        <Text style={styles.logoLine}>Press Apply to put this logo on the site.</Text>
        <Text style={styles.muted}>{preview.free ? "This one was free." : "This one used AI credits."}</Text>
      </View>
    </View>
  );
}

function NoteLine({ note }: { note: ThemeNote }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const tint = note.tone === "ok" ? colors.green : note.tone === "busy" ? colors.amber : colors.red;
  return (
    <View style={styles.note} accessibilityRole={note.tone === "ok" ? undefined : "alert"} accessibilityLiveRegion="polite">
      <Icon name={note.tone === "ok" ? "check" : note.tone === "busy" ? "timer" : "close"} size={14} color={tint} />
      <Text style={[styles.noteText, { color: tint }]}>{note.text}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  muted: { marginTop: space.md, fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, includeFontPadding: false, color: colors.muted },
  colors: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  colorField: { width: "47%", flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  colorInput: { flex: 1 },
  swatch: { width: 28, height: 28, marginBottom: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line },
  pick: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.md,
    marginBottom: space.sm,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
  },
  pressed: { backgroundColor: colors.soft },
  pickLabel: { fontFamily: font.family.medium, fontSize: font.size.base, includeFontPadding: false, color: colors.ink },
  pickValue: { flex: 1, textAlign: "right", fontFamily: font.family.regular, fontSize: font.size.base, includeFontPadding: false, color: colors.muted },
  chevron: { transform: [{ rotate: "-90deg" }] },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: space.lg, marginBottom: space.sm },
  fieldLabel: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.muted },
  count: { fontFamily: font.family.regular, fontSize: font.size.xs, includeFontPadding: false, color: colors.muted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2, marginTop: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  chipText: { fontFamily: font.family.medium, fontSize: font.size.sm, includeFontPadding: false, color: colors.ink },
  row: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  scope: { marginTop: space.xl, fontFamily: font.family.regular, fontSize: font.size.sm, includeFontPadding: false, color: colors.muted },
  logoBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginTop: space.lg,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.soft,
  },
  logoTile: {
    width: 68,
    height: 68,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  logoLine: { fontFamily: font.family.medium, fontSize: font.size.sm, lineHeight: 17, includeFontPadding: false, color: colors.ink },
  note: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginTop: space.md, padding: space.md, borderRadius: radius.sm, backgroundColor: colors.soft },
  noteText: { flex: 1, fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, includeFontPadding: false },
});
