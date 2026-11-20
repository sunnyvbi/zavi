import { useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Icon } from "../Icon";
import { OptionSheet } from "../OptionSheet";
import { FocusRing } from "../ZaviTextField";
import { ErrorText, Note, ReadOnlyNote, ToneChip, UgcButton } from "./UgcParts";
import type { LibraryAsset } from "../../features/channels/ugc";
import { libraryDownloadUrl } from "../../features/channels/ugcHooks";
import {
  META_CHECKING,
  META_NO_AD_SETS,
  META_STILL_DOWNLOAD,
  YOUTUBE_CHECKING,
  YOUTUBE_INTRO,
  adNumbersView,
  adSetLabel,
  adSetOptions,
  libraryHeading,
  metaChip,
  metaCreatedLine,
  metaIntro,
  rightsChip,
  rightsLine,
  trackingLine,
  metaCreateError,
  writeError,
  youtubeSaveLabel,
  youtubeSavedLine,
  type Tone,
} from "../../features/channels/ugcLibrary";
import {
  useCreateMetaAd,
  useMetaAdOpenBody,
  useMetaAdPending,
  useMetaEligibility,
  useSaveYoutubeVideo,
  useYoutubeEligibility,
} from "../../features/channels/ugcLibraryHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Panel = "meta" | "youtube";

export function LibraryCard({
  asset: a,
  canWrite,
  initialPanel,
  onLayout,
}: {
  asset: LibraryAsset;
  canWrite: boolean;
  initialPanel?: Panel;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const styles = useStyles(makeStyles);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [metaOpen, setMetaOpen] = useState(initialPanel === "meta");
  const [youtubeOpen, setYoutubeOpen] = useState(initialPanel === "youtube");
  const rights = rightsChip(a);
  const meta = metaChip(a);
  const tag = trackingLine(a);

  async function download() {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    let url: string;
    try {
      url = await libraryDownloadUrl(a.id);
    } catch (e) {
      setDownloadError(e instanceof Error && e.message ? e.message : "Download failed. Try again.");
      setDownloading(false);
      return;
    }
    setDownloading(false);
    void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => setDownloadError("Download failed. Try again.")));
  }

  return (
    <View style={styles.card} onLayout={onLayout}>
      <Text style={styles.heading}>{libraryHeading(a)}</Text>
      <View style={styles.chips}>
        <ToneChip label={rights.label} tone={rights.tone} />
        {meta ? <ToneChip label={meta.label} tone={meta.tone} /> : null}
      </View>
      <Text style={styles.sub}>{rightsLine(a)}</Text>
      {tag ? (
        <Text style={styles.sub} selectable>
          {tag}
        </Text>
      ) : null}
      <AdNumbers asset={a} />
      {a.two_clocks_warning ? <Note tone="warn">{a.two_clocks_warning}</Note> : null}
      <View style={styles.buttons}>
        <UgcButton label="Download" busyLabel="Preparing…" busy={downloading} variant="secondary" onPress={() => void download()} />
        <UgcButton label={metaOpen ? "Hide Meta options" : "Use in Meta Ads"} variant="secondary" onPress={() => setMetaOpen((v) => !v)} />
        <UgcButton label={youtubeOpen ? "Hide YouTube options" : "Use in YouTube Ads"} variant="secondary" onPress={() => setYoutubeOpen((v) => !v)} />
      </View>
      <ErrorText>{downloadError}</ErrorText>
      {metaOpen ? <MetaPanel asset={a} canWrite={canWrite} /> : null}
      {youtubeOpen ? <YoutubePanel asset={a} canWrite={canWrite} /> : null}
    </View>
  );
}

function AdNumbers({ asset }: { asset: LibraryAsset }) {
  const styles = useStyles(makeStyles);
  const view = adNumbersView(asset.ad_performance);
  if (!view) return null;
  if (view.kind === "abstain") {
    return (
      <View style={styles.box}>
        <Text style={styles.boxTitle}>{view.title}</Text>
        <Text style={styles.sub}>{view.body}</Text>
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <Text style={styles.boxTitle}>{view.title}</Text>
      <View style={styles.grid}>
        {view.cells.map((c) => (
          <View key={c.label} style={styles.cell}>
            <Text style={styles.cellLabel}>{c.label}</Text>
            <Text style={styles.cellValue}>{c.value}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.sub}>{view.foot}</Text>
    </View>
  );
}

function PanelError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.panelGap}>
      <Note tone="bad" title="Couldn't load this">
        {error instanceof Error && error.message ? error.message : "Try again in a moment."}
      </Note>
      <View style={styles.buttons}>
        <UgcButton label="Try again" variant="secondary" onPress={onRetry} />
      </View>
    </View>
  );
}

function MetaPanel({ asset: a, canWrite }: { asset: LibraryAsset; canWrite: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const elig = useMetaEligibility(a.id, true);
  const create = useCreateMetaAd(a.id);
  const pending = useMetaAdPending(a.id);
  const resend = useMetaAdOpenBody(a.id);
  const [pickedId, setAdSetId] = useState("");
  const [typed, setMessage] = useState("");
  const adSetId = resend?.ad_set_id ?? pickedId;
  const message = resend ? (resend.message ?? "") : typed;
  const [picking, setPicking] = useState(false);
  const submitting = useRef(false);

  const created = metaCreatedLine(create.data, a);
  if (created) return <Note tone="ok">{created}</Note>;

  if (!elig.data) {
    if (elig.isError) return <PanelError error={elig.error} onRetry={() => void elig.refetch()} />;
    return <Text style={styles.sub}>{META_CHECKING}</Text>;
  }
  const e = elig.data;
  if (!e.eligible) {
    return (
      <Note>
        <Text style={styles.noteInk}>{e.reason}</Text>
        <Text style={styles.sub}>{META_STILL_DOWNLOAD}</Text>
      </Note>
    );
  }

  const sets = e.ad_sets ?? [];
  const picked = sets.find((s) => s.id === adSetId) ?? null;
  const busy = create.isPending || pending;
  const locked = busy || resend !== null;

  function submit() {
    if (!adSetId || busy || submitting.current) return;
    submitting.current = true;
    create.mutate(
      { adSetId, message },
      {
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.sub}>{metaIntro(e)}</Text>
      {!canWrite ? (
        <ReadOnlyNote />
      ) : (
        <>
          <Text style={styles.label}>Ad set</Text>
          {sets.length === 0 ? (
            <Text style={styles.sub}>{META_NO_AD_SETS}</Text>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.select, pressed && styles.pressed]}
              onPress={() => setPicking(true)}
              disabled={locked}
              accessibilityRole="button"
              accessibilityLabel={`Ad set, ${picked ? adSetLabel(picked) : "none picked"}`}
              accessibilityState={{ disabled: locked }}
            >
              <Text style={[styles.selectText, !picked && styles.placeholder]} numberOfLines={1}>
                {picked ? adSetLabel(picked) : "Pick an ad set"}
              </Text>
              <Icon name="chevronDown" size={18} color={colors.muted} />
            </Pressable>
          )}
          <Text style={styles.label}>Primary text (optional)</Text>
          <FocusRing radius={radius.sm}>
            {(focus) => (
              <TextInput
                style={[styles.input, styles.inputMulti]}
                value={message}
                onChangeText={setMessage}
                multiline
                maxLength={2000}
                editable={!locked}
                textAlignVertical="top"
                placeholderTextColor={colors.muted}
                keyboardAppearance={keyboardAppearance}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                onFocus={focus.onFocus}
                onBlur={focus.onBlur}
                accessibilityLabel="Primary text (optional)"
              />
            )}
          </FocusRing>
          <View style={styles.buttons}>
            <UgcButton label="Create paused ad" busyLabel="Uploading to Meta…" busy={busy} disabled={!adSetId} onPress={submit} />
          </View>
          <ErrorText>{create.isError ? metaCreateError(create.error) : null}</ErrorText>
          {resend && !busy ? <Text style={styles.sub}>Trying again sends the same ad set and text as the first try, so Zavi never makes a second ad.</Text> : null}
          <OptionSheet
            open={picking}
            title="Ad set"
            options={adSetOptions(sets)}
            value={adSetId}
            onPick={setAdSetId}
            onClose={() => setPicking(false)}
          />
        </>
      )}
    </View>
  );
}

function YoutubePanel({ asset: a, canWrite }: { asset: LibraryAsset; canWrite: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const elig = useYoutubeEligibility(a.id, true);
  const save = useSaveYoutubeVideo(a.id);
  const [paste, setPaste] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const saving = useRef(false);
  const stored = savedId ?? a.youtube?.video_id ?? null;
  const savedLine = youtubeSavedLine(stored);

  function submit() {
    if (!paste.trim() || save.isPending || saving.current) return;
    saving.current = true;
    save.mutate(paste, {
      onSuccess: (r) => {
        if (r?.youtube_video_id) {
          setSavedId(r.youtube_video_id);
          setPaste("");
        }
      },
      onSettled: () => {
        saving.current = false;
      },
    });
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.sub}>{YOUTUBE_INTRO}</Text>
      {canWrite ? (
        <>
          <Text style={styles.label}>YouTube video link or id</Text>
          <FocusRing radius={radius.sm}>
            {(focus) => (
              <TextInput
                style={styles.input}
                value={paste}
                onChangeText={setPaste}
                placeholder="https://www.youtube.com/watch?v=…"
                maxLength={500}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!save.isPending}
                placeholderTextColor={colors.muted}
                keyboardAppearance={keyboardAppearance}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                onFocus={focus.onFocus}
                onBlur={focus.onBlur}
                accessibilityLabel="YouTube video link or id"
              />
            )}
          </FocusRing>
          <View style={styles.buttons}>
            <UgcButton label={youtubeSaveLabel(stored)} busyLabel="Saving…" busy={save.isPending} disabled={!paste.trim()} variant="secondary" onPress={submit} />
          </View>
        </>
      ) : (
        <ReadOnlyNote />
      )}
      {savedLine ? (
        <Text style={styles.sub} selectable>
          {savedLine}
        </Text>
      ) : null}
      <ErrorText>{save.isError ? writeError(save.error, "Could not save the video id") : null}</ErrorText>
      {elig.data ? (
        !elig.data.eligible ? (
          <View style={styles.reason}>
            <Text style={styles.noteInk}>{elig.data.reason}</Text>
          </View>
        ) : null
      ) : elig.isError ? (
        <PanelError error={elig.error} onRetry={() => void elig.refetch()} />
      ) : (
        <Text style={styles.sub}>{YOUTUBE_CHECKING}</Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    heading: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    sub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    noteInk: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.ink },
    box: { gap: 6, padding: space.md, borderRadius: radius.sm, backgroundColor: colors.soft },
    boxTitle: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.ink },
    grid: { flexDirection: "row", flexWrap: "wrap", rowGap: space.sm },
    cell: { width: "50%", gap: 2, paddingRight: space.sm },
    cellLabel: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, letterSpacing: 0.4, textTransform: "uppercase", color: colors.muted },
    cellValue: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.ink },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    panel: { gap: space.sm, padding: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.soft },
    panelGap: { gap: space.sm },
    reason: { padding: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
    label: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    select: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.sm,
      paddingHorizontal: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
      backgroundColor: colors.bg,
    },
    selectText: { flex: 1, fontFamily: font.family.regular, fontSize: 14, color: colors.ink },
    placeholder: { color: colors.muted },
    pressed: { opacity: 0.7 },
    input: {
      minHeight: 44,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      fontFamily: font.family.medium,
      fontSize: 15,
      color: colors.ink,
    },
    inputMulti: { minHeight: 84 },
  });
