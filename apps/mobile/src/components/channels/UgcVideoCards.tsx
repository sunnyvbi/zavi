import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { CREATOR_VIDEO_CHANNEL_SPECS, isCreatorVideoChannel } from "@zavi/shared";
import { CardFooter, Chip } from "./UgcParts";
import { readyVideoCards, UGC_SLUG, type VideoCard, type VideoSpec } from "../../features/channels/ugc";
import { libraryDownloadUrl, useLibrary } from "../../features/channels/ugcHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export type ReadyVideoCard = VideoCard & { push?: VideoSpec["push"] };

export function useReadyVideoCards(slug: string): ReadyVideoCard[] {
  const relevant = slug === UGC_SLUG || isCreatorVideoChannel(slug);
  const library = useLibrary(relevant);
  if (!relevant) return [];
  const spec = isCreatorVideoChannel(slug) ? CREATOR_VIDEO_CHANNEL_SPECS[slug] : null;
  return readyVideoCards(library.data ?? [], slug, spec).map((c) => ({ ...c, push: c.webOnly ? (spec?.push ?? null) : null }));
}

export function VideoCardView({ card: c, dismiss }: { card: ReadyVideoCard; dismiss?: { label: string; onPress: () => void } }) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    let url: string;
    try {
      url = await libraryDownloadUrl(c.assetId);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Download failed. Try again.");
      setBusy(false);
      return;
    }
    setBusy(false);
    void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => setError("Download failed. Try again.")));
  }

  const toLibrary = (open: "meta" | "youtube") => router.push({ pathname: "/channels/ugc/library", params: { asset: c.assetId, open } });
  const primary =
    c.push === "meta"
      ? { label: "Use in Meta Ads", onPress: () => toLibrary("meta") }
      : c.push === "youtube"
        ? { label: "Use in YouTube Ads", onPress: () => toLibrary("youtube") }
        : null;

  return (
    <View style={styles.card}>
      <Chip label={c.kind} />
      <Text style={styles.title}>{c.title}</Text>
      <Text style={styles.sub}>{c.lead}</Text>
      <Text style={styles.sub}>Ad rights: {c.rights}.</Text>
      <CardFooter
        primary={primary ?? { label: "Download the video", onPress: () => void download() }}
        secondary={primary ? [{ label: "Download the video", onPress: () => void download() }] : []}
        dismiss={dismiss}
        askAbout={c.title}
        disabled={busy}
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { alignItems: "flex-start", gap: 6, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    title: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    error: { fontFamily: font.family.regular, fontSize: 12, color: colors.status.redDot },
  });
