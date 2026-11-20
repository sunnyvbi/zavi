import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { BottomSheetScrollViewMethods } from "@gorhom/bottom-sheet";
import { Image } from "expo-image";
import type { Connection } from "../../features/connectors/health";
import type { Personalization } from "../../features/personalization/usePersonalization";
import type { GrowthPlanDetail } from "../../features/growth/plan";
import {
  BRAND_VOICE_MAX,
  VOICE_CLAMP_CHARS,
  VOICE_DISMISS_ERROR,
  connectorLabel,
  foundLabel,
  hostOf,
  kitCaption,
  kitSwatches,
  noDescriptionLine,
  ruleToNeverSay,
  sourcesLine,
  suggestionsLabel,
  tonePills,
  voiceInUse,
  type BrandKit,
} from "../../features/growth/knowledge";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { AppBottomSheet } from "../AppBottomSheet";
import { useBrandVoiceDraft, useDismissVoiceDraft, useSaveBrandVoice } from "../../features/growth/hooks";
import { useAiConsent } from "../../features/consent/useAiConsent";
import { BrandVoiceEditor } from "./BrandVoiceEditor";
import { ActionButton, AlertLine, Bars, ErrorLine, FactRow, SubLabel, TextLink } from "./StoryKit";

export type DataRows = {
  sources: Connection[] | null;
  suggested: string[];
  gaConnected: boolean;
  anyMeasured: boolean;
  loading: boolean;
};

export function KnowledgeSheet({
  open,
  onClose,
  canEdit,
  facts,
  factsState,
  workspaceName,
  detail,
  data,
  voice,
  voiceState,
  kit,
  startEditingVoice,
  onRetryFacts,
  onOpenConnectors,
  onOpenUrl,
}: {
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
  facts: { company_name: string; what_we_sell: string; domain: string; competitors: string[] } | null;
  factsState: "loading" | "ready" | "failed";
  workspaceName: string | null;
  detail: GrowthPlanDetail;
  data: DataRows;
  voice: Personalization | null;
  voiceState: "loading" | "ready" | "failed";
  kit: BrandKit | null;
  startEditingVoice: boolean;
  onRetryFacts: () => void;
  onOpenConnectors: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const [voiceY, setVoiceY] = useState<number | null>(null);
  useEffect(() => {
    if (open && startEditingVoice && voiceY !== null) scrollRef.current?.scrollTo({ y: voiceY, animated: true });
  }, [open, startEditingVoice, voiceY]);
  return (
    <AppBottomSheet open={open} onClose={onClose} title="What Zavi knows about you" scrollRef={scrollRef}>
      <Text style={styles.intro}>I plan from this. Fix anything that is wrong.</Text>
      <CompanyRows
        canEdit={canEdit}
        facts={facts}
        state={factsState}
        workspaceName={workspaceName}
        detail={detail}
        onRetry={onRetryFacts}
        onOpenUrl={onOpenUrl}
      />
      <YourData data={data} onOpenConnectors={onOpenConnectors} />
      <View onLayout={(e) => setVoiceY(e.nativeEvent.layout.y)}>
        <BrandVoice voice={voice} state={voiceState} kit={kit} canEdit={canEdit} startEditing={startEditingVoice} onDone={onClose} />
      </View>
    </AppBottomSheet>
  );
}

function CompanyRows({
  canEdit,
  facts,
  state,
  workspaceName,
  detail,
  onRetry,
  onOpenUrl,
}: {
  canEdit: boolean;
  facts: { company_name: string; what_we_sell: string; domain: string; competitors: string[] } | null;
  state: "loading" | "ready" | "failed";
  workspaceName: string | null;
  detail: GrowthPlanDetail;
  onRetry: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const [foundOpen, setFoundOpen] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  if (state === "loading") {
    return (
      <FactRow label="Company">
        <Bars label="Loading your company" />
      </FactRow>
    );
  }
  if (state === "failed" || !facts) {
    return (
      <FactRow label="Company">
        <AlertLine right={<TextLink label="Retry" onPress={onRetry} />}>Company details could not be loaded.</AlertLine>
      </FactRow>
    );
  }
  const name = facts.company_name.trim() || workspaceName?.trim() || "Your company";
  const sell = facts.what_we_sell.trim();
  const host = facts.domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const found = detail.company_facts ?? [];
  const summary = detail.summary?.trim();
  const hasFound = found.length > 0 || !!summary;
  const initial = (name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  return (
    <>
      <FactRow label="Company">
        <View style={styles.company}>
          {host && !logoFailed ? (
            <Image
              source={{ uri: `https://${host}/favicon.ico` }}
              style={styles.logo}
              contentFit="contain"
              onError={() => setLogoFailed(true)}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View style={styles.logoTile}>
              <Text style={styles.logoLetter}>{initial}</Text>
            </View>
          )}
          <Text style={styles.companyText}>
            <Text style={styles.companyName}>{name}</Text>
            {sell ? <Text>{` ${sell}`}</Text> : <Text style={styles.mutedInline}>{` ${noDescriptionLine(canEdit)}`}</Text>}
          </Text>
        </View>
        {hasFound ? (
          <TextLink label={foundLabel(foundOpen, found.length)} onPress={() => setFoundOpen((v) => !v)} expanded={foundOpen} />
        ) : null}
        {foundOpen ? (
          <View style={styles.found}>
            {summary ? (
              <>
                <SubLabel>Where you are</SubLabel>
                <Text style={styles.body}>{summary}</Text>
              </>
            ) : null}
            {found.length > 0 ? (
              <>
                <SubLabel>What Zavi found</SubLabel>
                {found.map((f, i) => (
                  <View key={i} style={styles.foundRow}>
                    <Text style={styles.body}>{f.fact}</Text>
                    {f.source_url ? <TextLink label={hostOf(f.source_url) || "Source"} onPress={() => onOpenUrl(f.source_url)} /> : null}
                  </View>
                ))}
              </>
            ) : null}
          </View>
        ) : null}
      </FactRow>
      <FactRow label="Rivals">
        {facts.competitors.length === 0 ? (
          <Text style={styles.muted}>None yet. I will not guess them.</Text>
        ) : (
          <View style={styles.pills}>
            {facts.competitors.map((c) => (
              <View key={c} style={styles.pill}>
                <Text style={styles.pillText}>{c}</Text>
              </View>
            ))}
          </View>
        )}
      </FactRow>
    </>
  );
}

function YourData({ data, onOpenConnectors }: { data: DataRows; onOpenConnectors: () => void }) {
  const styles = useStyles(makeStyles);
  const [showList, setShowList] = useState(false);
  if (data.loading) {
    return (
      <FactRow label="Your data">
        <Bars label="Loading your data" />
      </FactRow>
    );
  }
  const sources = data.sources;
  const broken = (sources ?? []).filter((c) => c.health === "reconnect");
  const stale = (sources ?? []).filter((c) => c.health === "stale");
  const shown = (sources ?? []).filter((c) => showList || c.health === "reconnect" || c.health === "stale");
  return (
    <FactRow label="Your data" action={<TextLink label="Add" onPress={onOpenConnectors} accessibilityLabel="Add a connector" />}>
      {sources === null ? (
        <AlertLine>Your connections could not be loaded.</AlertLine>
      ) : (
        <>
          <Text style={styles.meta}>{sourcesLine(sources.length - broken.length, broken.length, stale.length)}</Text>
          {data.suggested.length > 0 ? (
            <>
              <SubLabel>{suggestionsLabel(data.gaConnected, data.anyMeasured)}</SubLabel>
              <View style={styles.tiles}>
                {data.suggested.map((slug) => (
                  <View key={slug} style={[styles.tile, slug === "google_analytics" && styles.tileLead]}>
                    <Text style={styles.tileText} numberOfLines={1}>
                      {connectorLabel(slug)}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {sources.length > 0 ? (
            <>
              <TextLink label={showList ? "Hide list" : "Show list"} onPress={() => setShowList((v) => !v)} expanded={showList} />
              {shown.length > 0 ? (
                <View style={styles.pills}>
                  {shown.map((c) => (
                    <View key={c.slug} style={styles.pill}>
                      <Text style={styles.pillText}>
                        {c.label}
                        {c.health === "reconnect" ? (
                          <Text style={styles.warnInline}> · needs reconnecting</Text>
                        ) : c.health === "stale" ? (
                          <Text style={styles.warnInline}> · not syncing</Text>
                        ) : null}
                      </Text>
                      <View style={[styles.statusDot, c.health === "stale" || c.health === "reconnect" ? styles.statusDotWarn : null]} />
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
          {data.gaConnected && data.suggested.length === 0 ? (
            <Text style={styles.muted}>Everything Zavi suggests for a company like yours is connected.</Text>
          ) : null}
        </>
      )}
    </FactRow>
  );
}

function BrandVoice({
  voice,
  state,
  kit,
  canEdit,
  startEditing,
  onDone,
}: {
  voice: Personalization | null;
  state: "loading" | "ready" | "failed";
  kit: BrandKit | null;
  canEdit: boolean;
  startEditing: boolean;
  onDone: () => void;
}) {
  const styles = useStyles(makeStyles);
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<{ seed?: string; direct?: boolean } | null>(startEditing ? { direct: true } : null);
  const text = voice?.brand_voice ?? "";
  const consent = useAiConsent();
  const wantsDraft = consent.agreed && canEdit && state === "ready" && voice !== null && !text.trim();
  const draftQ = useBrandVoiceDraft(wantsDraft);
  const draft = wantsDraft ? draftQ.data ?? null : null;
  const useDraft = useSaveBrandVoice();
  const dismiss = useDismissVoiceDraft();
  const [draftError, setDraftError] = useState<string | null>(null);
  if (state === "loading") {
    return (
      <FactRow label="Brand voice">
        <Bars label="Loading brand voice" />
      </FactRow>
    );
  }
  if (state === "failed" || !voice) {
    return (
      <FactRow label="Brand voice">
        <AlertLine>Brand voice could not be loaded.</AlertLine>
      </FactRow>
    );
  }
  const long = text.length > VOICE_CLAMP_CHARS;
  const tone = tonePills(voice);
  const never = ruleToNeverSay(voice.response_rules ?? "");
  const swatches = kitSwatches(kit);
  const inUse = voiceInUse(voice);
  if (editing) {
    return (
      <FactRow label="Brand voice">
        <BrandVoiceEditor
          voice={voice}
          kit={kit}
          seedVoice={editing.seed}
          onClose={() => setEditing(null)}
          onSaved={editing.direct ? onDone : () => setEditing(null)}
          requireVoice={editing.direct}
        />
      </FactRow>
    );
  }
  const saveDraft = async () => {
    if (!draft || useDraft.isPending) return;
    setDraftError(null);
    try {
      await useDraft.mutateAsync({ patch: { brand_voice: draft.value.slice(0, BRAND_VOICE_MAX) } });
    } catch (e) {
      setDraftError((e as Error).message);
    }
  };
  const dismissDraft = async () => {
    if (dismiss.isPending) return;
    setDraftError(null);
    try {
      await dismiss.mutateAsync();
    } catch {
      setDraftError(VOICE_DISMISS_ERROR);
    }
  };
  return (
    <FactRow label="Brand voice" action={canEdit ? <TextLink label="Edit" accessibilityLabel="Edit brand voice" onPress={() => setEditing({})} /> : undefined}>
      <SubLabel>How we sound</SubLabel>
      {text.trim() ? (
        <>
          <Text style={styles.body} numberOfLines={long && !all ? 2 : undefined}>
            {text}
          </Text>
          {long ? <TextLink label={all ? "Show less" : "Show all"} onPress={() => setAll((v) => !v)} expanded={all} /> : null}
        </>
      ) : draft ? (
        <View style={styles.draft}>
          <Text style={styles.meta}>{`Zavi drafted this from ${draft.from}:`}</Text>
          <Text style={styles.body}>{draft.value}</Text>
          <View style={styles.draftActions}>
            <ActionButton label="Use this" busy={useDraft.isPending} busyLabel="Saving…" onPress={() => void saveDraft()} />
            <TextLink label="Edit first" onPress={() => setEditing({ seed: draft.value })} />
            <TextLink label="Dismiss" onPress={() => void dismissDraft()} disabled={dismiss.isPending} />
          </View>
        </View>
      ) : (
        <>
          <Text style={styles.muted}>Not set yet. Describe how your company talks, and every agent writes that way.</Text>
          {wantsDraft && draftQ.isFetching ? <Text style={styles.meta}>Zavi is reading your site to suggest one…</Text> : null}
        </>
      )}
      {draftError ? <ErrorLine>{draftError}</ErrorLine> : null}
      {kit && swatches.length > 0 ? (
        <>
          <SubLabel>Colours</SubLabel>
          <View style={styles.swatches}>
            {swatches.map((s) => (
              <View key={s.label} style={styles.swatchItem} accessible accessibilityLabel={`${s.label} colour ${s.hex}`}>
                {}
                <View style={[styles.swatch, { backgroundColor: s.hex }]} />
                <Text style={styles.hex}>{s.hex}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.meta}>{kitCaption(kit)}</Text>
        </>
      ) : null}
      {tone.length > 0 ? (
        <>
          <SubLabel>Tone</SubLabel>
          <View style={styles.pills}>
            {tone.map((t) => (
              <View key={t} style={styles.pill}>
                <Text style={styles.pillText}>{t}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
      {never.length > 0 ? (
        <>
          <SubLabel>Never say</SubLabel>
          <View style={styles.pills}>
            {never.map((w) => (
              <View key={w} style={styles.pill}>
                <Text style={[styles.pillText, styles.struck]}>{w}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
      {inUse ? <Text style={styles.meta}>{inUse}</Text> : null}
    </FactRow>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    intro: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.textSecondary, marginBottom: space.sm },
    company: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    logo: { width: 32, height: 32, borderRadius: 8 },
    logoTile: { width: 32, height: 32, borderRadius: 8, backgroundColor: colors.blueFill, alignItems: "center", justifyContent: "center" },
    logoLetter: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.onAccent },
    companyText: { flex: 1, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.textSecondary, paddingTop: 6 },
    companyName: { fontFamily: font.family.semi, color: colors.ink },
    mutedInline: { color: colors.muted },
    found: { gap: space.sm },
    foundRow: { gap: 2 },
    body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.textSecondary },
    muted: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.muted },
    meta: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.line,
      paddingHorizontal: 10,
      paddingVertical: 6,
      maxWidth: "100%",
    },
    pillText: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 17, includeFontPadding: false, color: colors.ink, flexShrink: 1 },
    struck: { textDecorationLine: "line-through", color: colors.muted },
    warnInline: { color: colors.status.amberText },
    statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.status.greenDot },
    statusDotWarn: { backgroundColor: colors.status.amberDot },
    tiles: { gap: space.sm },
    tile: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.md, paddingVertical: 10 },
    tileLead: { borderColor: colors.muted, backgroundColor: colors.soft },
    tileText: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    draft: { borderRadius: radius.md, borderWidth: 1, borderStyle: "dashed", borderColor: colors.line, padding: space.md, gap: space.sm },
    draftActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md },
    swatches: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
    swatchItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    swatch: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: colors.line },
    hex: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted },
  });
