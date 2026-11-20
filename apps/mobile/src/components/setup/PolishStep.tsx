import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ZaviTextField } from "../ZaviTextField";
import { Icon } from "../Icon";
import { UnderlinedText } from "../UnderlinedText";
import { PrimaryButton, SecondaryButton } from "../settings/SettingsUI";
import { showDialog } from "../DialogHost";
import { apiJson } from "../../lib/api";
import { useSetup } from "../../features/setup/SetupProvider";
import { suggestCompetitors } from "../../features/setup/api";
import { IMPORT_POLL_MS, namesOf, summarizeReads } from "../../features/setup/imports";
import {
  addCompetitor,
  displayedFacts,
  EMPTY_FORM,
  FIELD_LABEL,
  formFromFacts,
  leftToFile,
  mergeFileFacts,
  withSuggested,
  type CompanyForm,
  type FileOffer,
  type FileTag,
  type Fillable,
} from "../../features/setup/polish";
import * as copy from "../../features/setup/copy";
import { saveCompanyFacts } from "../../features/settings/api";
import { BASE_TONES, usePersonalization, useSavePersonalization, type BaseTone } from "../../features/personalization/usePersonalization";
import {
  COLOUR_FIELDS,
  TONE_LABEL,
  colourPlaceholder,
  coloursChanged,
  invalidColour,
  isHex,
  kitBody,
  toColourDraft,
  type ColourDraft,
} from "../../features/growth/knowledge";
import { useBrandKit } from "../../features/growth/hooks";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { Chip, FieldLabel, FooterRow, Hint, SectionTitle, SetupFrame } from "./SetupUI";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Facts = Array<{ key: string; value_text: string | null }>;
const readFacts = async (): Promise<Facts> =>
  (await apiJson<{ facts?: Facts }>("/api/connectors/company-facts", { timeoutMs: 20_000 })).facts ?? [];

const GAVE_UP = 3;
const COMPETITOR_TRIES = 3;
type Read = "loading" | "ok" | "failed";

export function PolishStep({
  header,
  onFinish,
  onSkip,
  onDirtyChange,
  skipBody,
}: {
  header: ReactNode;
  onFinish: (problems: string[]) => Promise<void>;
  onSkip: () => Promise<void> | void;
  onDirtyChange: (dirty: boolean) => void;
  skipBody: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const setup = useSetup();
  const reads = summarizeReads(setup.imports.files);
  const personalization = usePersonalization();
  const savePersonalization = useSavePersonalization();
  const kit = useBrandKit();

  const [before, setBefore] = useState<CompanyForm>(EMPTY_FORM);
  const [form, setForm] = useState<CompanyForm>(EMPTY_FORM);
  const [factsRead, setFactsRead] = useState<Read>("loading");
  const [compDraft, setCompDraft] = useState("");
  const [tone, setTone] = useState<BaseTone | null>(null);
  const [colours, setColours] = useState<ColourDraft | null>(null);
  const [coloursBefore, setColoursBefore] = useState<ColourDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [tags, setTags] = useState<Partial<Record<Fillable, FileTag>>>({});
  const [offers, setOffers] = useState<Partial<Record<Fillable, FileOffer>>>({});

  useEffect(() => {
    let alive = true;
    readFacts()
      .then((facts) => {
        if (!alive) return;
        const f = formFromFacts(facts);
        setBefore(f);
        setForm(f);
        setFactsRead("ok");
      })
      .catch(() => alive && setFactsRead("failed"));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (personalization.data && tone === null) setTone(personalization.data.base_tone);
  }, [personalization.data, tone]);
  useEffect(() => {
    if (kit.data && colours === null) {
      setColours(toColourDraft(kit.data));
      setColoursBefore(toColourDraft(kit.data));
    }
  }, [kit.data, colours]);

  const importsLoaded = setup.imports.files !== null;
  const importsGaveUp = !importsLoaded && setup.imports.failures >= GAVE_UP;
  const prefillSettled =
    factsRead !== "loading" && !kit.isPending && !personalization.isPending && (importsLoaded || importsGaveUp);
  const prefillFailed = factsRead === "failed" || kit.isError || personalization.isError;

  const live = useRef({ form, before, touched, factsRead });
  live.current = { form, before, touched, factsRead };
  const [seenDone, setSeenDone] = useState<ReadonlySet<string>>(() => new Set());
  const [factsFailures, setFactsFailures] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const factsBusy = useRef(false);
  const unseen = factsRead !== "loading" ? reads.done.filter((f) => !seenDone.has(f.id)) : [];
  const factsGaveUp = unseen.length > 0 && factsFailures >= GAVE_UP;
  const awaitingFileFacts = unseen.length > 0 && !factsGaveUp;
  const unseenKey = unseen.map((f) => f.id).join(",");
  useEffect(() => {
    if (!unseen.length || factsBusy.current || factsGaveUp) return;
    const fresh = unseen;
    factsBusy.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        const next = formFromFacts(await readFacts());
        const cur = live.current;
        const merged = mergeFileFacts({
          next,
          form: cur.form,
          before: cur.before,
          touched: cur.touched,
          file: namesOf(fresh),
          firstReadFailed: cur.factsRead === "failed",
        });
        setForm((f) => {
          const out: CompanyForm = { ...f };
          for (const k of Object.keys(merged.tags) as Fillable[]) {
            if (!live.current.touched.has(k)) (out as Record<string, unknown>)[k] = merged.form[k];
          }
          if (cur.factsRead === "failed" && !live.current.touched.has("domain")) out.domain = merged.form.domain;
          return out;
        });
        setBefore(merged.before);
        setTags((t) => ({ ...t, ...merged.tags }));
        setOffers((o) => ({ ...o, ...merged.offers }));
        setFactsRead("ok");
        setFactsFailures(0);
        setSeenDone((seen) => new Set([...seen, ...fresh.map((f) => f.id)]));
      } catch {
        setFactsFailures((n) => n + 1);
        timer = setTimeout(() => setRetryTick((n) => n + 1), IMPORT_POLL_MS);
      } finally {
        factsBusy.current = false;
      }
    })();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseenKey, retryTick]);

  const [compSearch, setCompSearch] = useState<"idle" | "loading" | "found" | "none">("idle");
  const compAsked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (factsRead !== "ok" || compAsked.current) return;
    compAsked.current = true;
    if (before.competitors.length > 0) return;
    setCompSearch("loading");
    void (async () => {
      let names: string[] = [];
      for (let i = 0; i < COMPETITOR_TRIES; i++) {
        const out = await suggestCompetitors();
        if (!out.ok) break;
        names = out.names;
        if (!out.pending) break;
      }
      if (!mounted.current) return;
      if (!names.length) {
        setCompSearch("none");
        return;
      }
      setForm((f) => ({ ...f, competitors: withSuggested(f.competitors, names) }));
      setBefore((b) => (b.competitors.length ? b : { ...b, competitors: names }));
      setCompSearch("found");
    })();
  }, [factsRead, before.competitors.length]);

  const edit = (k: keyof CompanyForm, next: CompanyForm) => {
    setForm(next);
    if (!touched.has(k)) setTouched((t) => new Set(t).add(k));
    if (k in tags) setTags((t) => { const o = { ...t }; delete o[k as Fillable]; return o; });
  };
  const applyGuess = (k: Fillable) => {
    const tag = tags[k];
    if (tag) edit(k, { ...form, [k]: tag.guess } as CompanyForm);
  };
  const applyFileValue = (k: Fillable) => {
    const offer = offers[k];
    if (!offer) return;
    setForm({ ...form, [k]: offer.value } as CompanyForm);
    setOffers((o) => { const n = { ...o }; delete n[k]; return n; });
  };
  const keepMine = (k: Fillable) => setOffers((o) => { const n = { ...o }; delete n[k]; return n; });
  const addComp = () => {
    const v = compDraft.trim();
    if (v) edit("competitors", { ...form, competitors: addCompetitor(form.competitors, v) });
    setCompDraft("");
  };

  const dirty =
    touched.size > 0 ||
    compDraft.trim() !== "" ||
    (tone !== null && tone !== (personalization.data?.base_tone ?? null)) ||
    (colours !== null && coloursBefore !== null && coloursChanged(colours, coloursBefore));
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const readingName = reads.reading.length ? namesOf(reads.reading) : null;

  const finish = async () => {
    setError(null);
    const badColour = colours ? invalidColour(colours) : null;
    if (badColour) {
      setError(badColour);
      return;
    }
    setBusy(true);
    const problems: string[] = [];
    try {
      await setup.sequence(async (same) => {
        const fileUnknown = !!readingName || factsGaveUp || importsGaveUp;
        const skip = new Set<string>(leftToFile({ fileUnknown, touched, tagged: new Set(Object.keys(tags)) }));
        for (const fact of displayedFacts(form, before).filter((f) => !skip.has(f.key))) {
          if (!same()) return;
          const label = FIELD_LABEL[fact.key];
          try {
            const out = await saveCompanyFacts({ [fact.key]: fact.value });
            if ((out?.rejected ?? []).some((r) => r.dropped.length > 0)) problems.push(`some ${label}`);
          } catch {
            problems.push(label);
          }
        }
        void qc.invalidateQueries({ queryKey: ["company-facts", tenant] });
        if (!same()) return;
        if (tone) {
          await savePersonalization.mutateAsync({ base_tone: tone }).catch(() => problems.push("tone"));
        }
        if (colours && same()) {
          await apiJson<unknown>("/api/workspace/brand-kit", { method: "PUT", body: JSON.stringify(kitBody(colours)) })
            .then(() => qc.invalidateQueries({ queryKey: ["brand-kit", tenant] }))
            .catch(() => problems.push("colours"));
        }
        if (same()) await onFinish(problems);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    const ok = await showDialog({
      title: copy.SKIP3_TITLE,
      message: skipBody,
      confirmLabel: copy.SKIP_YES,
      cancelLabel: copy.SKIP_NO,
    });
    if (ok) await onSkip();
  };

  const note = (k: Fillable) => {
    const offer = offers[k];
    if (offer) {
      const value = Array.isArray(offer.value) ? (offer.value.length ? offer.value.join(", ") : "none") : offer.value;
      return (
        <View style={styles.offer}>
          <Text style={styles.offerText}>{copy.fileSays(offer.file, value)}</Text>
          <View style={styles.offerRow}>
            <SecondaryButton label={k === "competitors" ? copy.USE_FILE_LIST : copy.USE_FILE_LINE} onPress={() => { Keyboard.dismiss(); applyFileValue(k); }} style={styles.half} />
            <SecondaryButton label={copy.KEEP_MINE} onPress={() => { Keyboard.dismiss(); keepMine(k); }} style={styles.half} />
          </View>
        </View>
      );
    }
    const tag = tags[k];
    if (tag) {
      return (
        <View style={styles.tagRow}>
          <View style={styles.tag}>
            <Text style={styles.tagText} numberOfLines={1}>
              {copy.fromFile(tag.file)}
            </Text>
          </View>
          <Pressable onPress={() => { Keyboard.dismiss(); applyGuess(k); }} accessibilityRole="button" hitSlop={6}>
            <UnderlinedText style={styles.link}>{copy.USE_WEBSITE_GUESS}</UnderlinedText>
          </Pressable>
        </View>
      );
    }
    return null;
  };

  const fromFiles = reads.facts > 0 || (setup.state?.enabled === true && setup.state.docs.facts > 0);
  const intro = readingName ? copy.polishIntroReading(readingName) : copy.polishIntro(fromFiles, before.domain.trim() !== "");
  const competitorHint =
    compSearch === "found" && form.competitors.length > 0 && !touched.has("competitors")
      ? copy.COMPETITORS_FOUND
      : compSearch === "none" && form.competitors.length === 0
        ? copy.NO_COMPETITORS_FOUND
        : null;
  const tones = useMemo(() => BASE_TONES.map((t) => ({ t, label: TONE_LABEL[t] })), []);

  const footer = (
    <FooterRow>
      <SecondaryButton label={copy.SKIP_STEP} onPress={() => { Keyboard.dismiss(); void skip(); }} disabled={busy} style={styles.half} />
      <PrimaryButton
        label={copy.FINISH_LABEL}
        onPress={() => { Keyboard.dismiss(); void finish(); }}
        disabled={!prefillSettled || awaitingFileFacts}
        busy={busy}
        busyLabel={copy.SAVING_LABEL}
        style={styles.half}
      />
    </FooterRow>
  );

  return (
    <SetupFrame header={header} footer={footer}>
      <Text style={styles.intro}>{intro}</Text>

      <SectionTitle>{copy.COMPANY_DETAILS}</SectionTitle>
      <View style={styles.fields}>
        <View>
          <ZaviTextField
            title="Company name"
            placeholder={copy.COMPANY_NAME_HINT}
            value={form.company_name}
            onChangeText={(v) => edit("company_name", { ...form, company_name: v })}
            autoCapitalize="words"
            multiline={false}
          />
          {note("company_name")}
        </View>
        <ZaviTextField
          title="Website"
          placeholder={copy.WEBSITE_HINT}
          value={form.domain}
          onChangeText={(v) => edit("domain", { ...form, domain: v })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          multiline={false}
        />
        <View>
          <ZaviTextField
            title="What you do, in one line"
            placeholder={copy.WHAT_YOU_DO_HINT}
            value={form.what_we_sell}
            onChangeText={(v) => edit("what_we_sell", { ...form, what_we_sell: v })}
          />
          {note("what_we_sell")}
        </View>
        <View>
          <FieldLabel>Competitors to track</FieldLabel>
          {form.competitors.length > 0 ? (
            <View style={styles.chips}>
              {form.competitors.map((c) => (
                <View key={c} style={styles.comp}>
                  <Text style={styles.compText}>{c}</Text>
                  <Pressable
                    onPress={() => { Keyboard.dismiss(); edit("competitors", { ...form, competitors: form.competitors.filter((x) => x !== c) }); }}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${c}`}
                    hitSlop={8}
                  >
                    <Icon name="close" size={14} color={colors.ink} strokeWidth={2} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          <ZaviTextField
            value={compDraft}
            onChangeText={setCompDraft}
            placeholder={copy.ADD_COMPETITOR}
            accessibilityLabel={copy.ADD_COMPETITOR}
            returnKeyType="done"
            multiline={false}
            onSubmitEditing={addComp}
            onBlur={() => {
              if (compDraft.trim()) addComp();
            }}
            containerStyle={styles.compInput}
          />
          {compSearch === "loading" ? (
            <View style={styles.finding} accessibilityLiveRegion="polite">
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.meta}>{copy.FINDING_COMPETITORS}</Text>
            </View>
          ) : null}
          {note("competitors") ?? (competitorHint ? <Hint>{competitorHint}</Hint> : null)}
        </View>
      </View>

      <View style={styles.sectionGap}>
        <SectionTitle>{copy.BRAND}</SectionTitle>
      </View>
      <View style={styles.fields}>
        <View>
          <FieldLabel>{copy.TONE_LABEL_Q}</FieldLabel>
          <View style={styles.chips}>
            {tones.map(({ t, label }) => (
              <Chip key={t} label={label} on={tone === t} onPress={() => { Keyboard.dismiss(); setTone(t); }} />
            ))}
          </View>
        </View>
        {colours ? (
          <View>
            <FieldLabel>{copy.COLOURS_LABEL}</FieldLabel>
            <View style={styles.colours}>
              {COLOUR_FIELDS.map(([key, label]) => (
                <View key={key} style={styles.colour}>
                  {}
                  <View style={[styles.swatch, isHex(colours[key]) && { backgroundColor: colours[key] }]} />
                  {}
                  <View style={styles.flex}>
                    <ZaviTextField
                      value={colours[key].replace(/^#/, "")}
                      onChangeText={(v) => {
                        const digits = v.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
                        setColours({ ...colours, [key]: digits ? `#${digits}` : "" });
                      }}
                      placeholder={colourPlaceholder(key).replace(/^#/, "")}
                      accessibilityLabel={`${label} colour`}
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxLength={6}
                      multiline={false}
                      style={styles.hexInput}
                    />
                    <View style={styles.hexPrefix} pointerEvents="none">
                      <Text style={styles.hexPrefixText}>#</Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </View>

      {importsGaveUp || factsGaveUp ? <Text style={styles.status}>{copy.FILE_DETAILS_FAILED}</Text> : null}
      {prefillSettled && prefillFailed ? <Text style={styles.status}>{copy.PREFILL_FAILED}</Text> : null}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    </SetupFrame>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    half: { flex: 1, marginTop: 0, minHeight: 48, borderRadius: radius.md },
    intro: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.textSecondary, marginBottom: space.lg },
    fields: { gap: space.lg, marginTop: space.md },
    sectionGap: { marginTop: space.xl },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    comp: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
      paddingHorizontal: space.md,
      paddingVertical: 7,
    },
    compText: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 18, color: colors.ink },
    compInput: { marginTop: space.sm },
    finding: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.sm },
    meta: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    colours: { gap: space.sm },
    colour: { flexDirection: "row", alignItems: "center", gap: space.md },
    hexInput: { paddingLeft: 26 },
    hexPrefix: { position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center" },
    hexPrefixText: { fontFamily: font.family.medium, fontSize: 15, includeFontPadding: false, color: colors.ink },
    swatch: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.soft },
    offer: { marginTop: space.sm, borderRadius: radius.md, backgroundColor: colors.soft, padding: space.md, gap: space.sm },
    offerText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.ink },
    offerRow: { flexDirection: "row", gap: space.sm },
    tagRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, marginTop: 6 },
    tag: { borderRadius: radius.pill, backgroundColor: colors.status.greenBg, paddingHorizontal: 10, paddingVertical: 3, maxWidth: 200 },
    tagText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, color: colors.status.greenText },
    link: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    status: { marginTop: space.lg, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    error: { marginTop: space.md, fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.red },
  });
