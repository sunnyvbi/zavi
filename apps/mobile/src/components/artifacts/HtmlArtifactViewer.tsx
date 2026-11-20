import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { SkeletonBlock } from "../Skeleton";
import { markThumbSeen, wasThumbSeen } from "./thumbSeen";
import { fetchArtifactPreviewUrl } from "../../features/artifacts/api";
import type { Artifact } from "../../features/artifacts/types";
import { harden, previewNavDecision } from "../../features/agents/previews";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const PAINT_MS = 800;

const MAX_HTML_CHARS = 3_000_000;

export function isHtmlArtifact(a: Pick<Artifact, "mime" | "filename">): boolean {
  return a.mime.toLowerCase().includes("html") || /\.html?$/i.test(a.filename);
}

export function PageSkeleton({ compact = false }: { compact?: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.skeleton, compact && styles.skeletonCompact]} accessible accessibilityLabel="Loading page" accessibilityState={{ busy: true }}>
      <SkeletonBlock width="34%" height={10} />
      <SkeletonBlock width="86%" height={compact ? 18 : 26} radius={8} />
      <SkeletonBlock width="64%" height={compact ? 18 : 26} radius={8} />
      <SkeletonBlock width="92%" height={12} />
      <SkeletonBlock width="78%" height={12} />
      <SkeletonBlock width="100%" height={compact ? 54 : 96} radius={12} style={styles.skeletonGap} />
      <SkeletonBlock width="96%" height={12} />
      <SkeletonBlock width="90%" height={12} />
      {compact ? null : (
        <>
          <SkeletonBlock width="94%" height={12} />
          <SkeletonBlock width="60%" height={12} />
        </>
      )}
    </View>
  );
}

const htmlCache = new Map<string, string>();
const htmlInflight = new Map<string, Promise<string>>();

export function peekArtifactHtml(id: string): string | null {
  return htmlCache.get(id) ?? null;
}

export function loadArtifactHtml(id: string): Promise<string> {
  const hit = htmlCache.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = htmlInflight.get(id);
  if (running) return running;
  const job = fetchArtifactPreviewUrl(id)
    .then(async ({ signed_url }) => {
      const text = await (await fetch(signed_url)).text();
      if (text.length > MAX_HTML_CHARS) throw new Error("too large");
      htmlCache.set(id, text);
      return text;
    })
    .finally(() => htmlInflight.delete(id));
  htmlInflight.set(id, job);
  return job;
}

export function useArtifactHtml(artifact: Artifact | null) {
  const [html, setHtml] = useState<string | null>(() => (artifact ? peekArtifactHtml(artifact.id) : null));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHtml(artifact ? peekArtifactHtml(artifact.id) : null);
    setError(null);
    if (!artifact) return;
    let alive = true;
    loadArtifactHtml(artifact.id)
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error && e.message === "too large" ? "This page is too large to show here." : "Could not load this page.");
      });
    return () => {
      alive = false;
    };
  }, [artifact]);

  return { html, error };
}

export const SAFE_WEBVIEW = {
  originWhitelist: ["*"] as string[],
  javaScriptEnabled: false,
  javaScriptCanOpenWindowsAutomatically: false,
  setSupportMultipleWindows: false,
  domStorageEnabled: false,
  incognito: true,
  cacheEnabled: false,
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowsLinkPreview: false,
  mediaPlaybackRequiresUserAction: true,
};

export function HtmlArtifactPreview({ artifact, fallback }: { artifact: Artifact; fallback: ReactNode }) {
  const styles = useStyles(makeStyles);
  const { html, error } = useArtifactHtml(artifact);
  const [rendered, setRendered] = useState(false);
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    setRendered(false);
    loaded.current = false;
    return () => {
      if (paintTimer.current) clearTimeout(paintTimer.current);
    };
  }, [artifact.id]);

  if (error) return <>{fallback}</>;
  if (html === null) {
    return (
      <View style={styles.frame}>
        <PageSkeleton compact />
      </View>
    );
  }
  return (
    <View style={styles.frame} pointerEvents="none">
      <WebView
        {...SAFE_WEBVIEW}
        source={{ html: harden(html) }}
        dataDetectorTypes={Platform.OS === "ios" ? "none" : undefined}
        scrollEnabled={false}
        onShouldStartLoadWithRequest={(req) => previewNavDecision(req.url, { loaded: loaded.current }) === "allow"}
        onLoad={() => {
          loaded.current = true;
          paintTimer.current = setTimeout(() => {
            markThumbSeen(artifact.id);
            setRendered(true);
          }, PAINT_MS);
        }}
        style={styles.webview}
      />
      {!rendered ? (
        <View style={styles.skeletonLayer}>
          <PageSkeleton compact />
        </View>
      ) : null}
    </View>
  );
}

export function HtmlArtifactViewer({ artifact, onClose }: { artifact: Artifact | null; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { html, error: loadError } = useArtifactHtml(artifact);
  const [renderFailed, setRenderFailed] = useState(false);
  const error = loadError ?? (renderFailed ? "Could not show this page." : null);
  const [rendered, setRendered] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    setRendered(false);
    setRenderFailed(false);
    loaded.current = false;
  }, [artifact]);

  const loading = !error && (html === null || !rendered);

  return (
    <Modal visible={!!artifact} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.safe, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.bar}>
          <Text style={styles.title} numberOfLines={1}>
            {artifact?.title ?? ""}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>
        <View style={styles.stage}>
          {html !== null && !error ? (
            <WebView
              {...SAFE_WEBVIEW}
              source={{ html: harden(html) }}
              dataDetectorTypes={Platform.OS === "ios" ? "none" : undefined}
              nestedScrollEnabled
              onShouldStartLoadWithRequest={(req) => previewNavDecision(req.url, { loaded: loaded.current }) === "allow"}
              onLoad={() => {
                if (loaded.current) return;
                loaded.current = true;
                setRendered(true);
              }}
              onError={() => setRenderFailed(true)}
              accessibilityLabel={`Preview of ${artifact?.title ?? "page"}`}
              style={styles.webview}
            />
          ) : null}
          {loading ? (
            <View style={styles.skeletonLayer}>
              <PageSkeleton />
            </View>
          ) : null}
          {error ? (
            <View style={styles.loading} accessibilityRole="alert">
              <Text style={styles.loadingText}>{error}</Text>
              {artifact ? (
                <Pressable
                  style={styles.browser}
                  onPress={() => void fetchArtifactPreviewUrl(artifact.id).then(({ signed_url }) => WebBrowser.openBrowserAsync(signed_url)).catch(() => {})}
                  accessibilityRole="button"
                >
                  <Text style={styles.browserText}>Open in browser</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    bar: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
    title: { flex: 1, minWidth: 0, includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.lg, color: colors.ink },
    close: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.soft, alignItems: "center", justifyContent: "center" },
    pressed: { opacity: 0.7 },
    stage: { flex: 1, backgroundColor: colors.bg },
    webview: { flex: 1, backgroundColor: colors.bg },
    frame: { overflow: "hidden", aspectRatio: 1.25, backgroundColor: colors.bg },
    loading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", gap: space.md, backgroundColor: colors.bg },
    loadingText: { fontFamily: font.family.regular, fontSize: font.size.base, color: colors.muted },
    skeletonLayer: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg },
    skeleton: { gap: space.md, padding: space.lg },
    skeletonCompact: { gap: space.sm, padding: space.md },
    skeletonGap: { marginVertical: space.sm },
    browser: { minHeight: 40, paddingHorizontal: 16, justifyContent: "center", borderRadius: 20, borderWidth: 1, borderColor: colors.line },
    browserText: { fontFamily: font.family.semi, fontSize: font.size.base, color: colors.ink },
  });
