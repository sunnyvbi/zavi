import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { PageSkeleton } from "./HtmlArtifactViewer";
import { fetchArtifactPreviewUrl } from "../../features/artifacts/api";
import type { Artifact } from "../../features/artifacts/types";
import { markThumbSeen, wasThumbSeen } from "./thumbSeen";
import { useStyles } from "../../theme/theme";
import type { Colors } from "../../theme/tokens";

const URL_TTL_MS = 5 * 60 * 1000;
const urls = new Map<string, { url: string; at: number }>();
const inflight = new Map<string, Promise<string>>();

function peekUrl(id: string): string | null {
  const hit = urls.get(id);
  return hit && Date.now() - hit.at < URL_TTL_MS ? hit.url : null;
}

const PAINT_MS = 800;

function signedUrl(id: string): Promise<string> {
  const hit = urls.get(id);
  if (hit && Date.now() - hit.at < URL_TTL_MS) return Promise.resolve(hit.url);
  const running = inflight.get(id);
  if (running) return running;
  const job = fetchArtifactPreviewUrl(id)
    .then(({ signed_url }) => {
      urls.set(id, { url: signed_url, at: Date.now() });
      return signed_url;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

export function isPdfArtifact(a: Pick<Artifact, "mime" | "filename">): boolean {
  return a.mime.toLowerCase() === "application/pdf" || /\.pdf$/i.test(a.filename);
}

export function pdfThumbAvailable(): boolean {
  return Platform.OS === "ios";
}

export function PdfThumb({ artifact, fallback, instant = false }: { artifact: Artifact; fallback: ReactNode; instant?: boolean }) {
  const styles = useStyles(makeStyles);
  const [url, setUrl] = useState<string | null>(() => peekUrl(artifact.id));
  const [drawn, setDrawn] = useState(() => instant && wasThumbSeen(artifact.id));
  const [failed, setFailed] = useState(false);
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (paintTimer.current) clearTimeout(paintTimer.current);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setUrl(peekUrl(artifact.id));
    setDrawn(instant && wasThumbSeen(artifact.id));
    setFailed(false);
    signedUrl(artifact.id)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [artifact.id]);

  if (failed) return <>{fallback}</>;
  if (!url) {
    return (
      <View style={styles.cover}>
        <PageSkeleton compact />
      </View>
    );
  }
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <WebView
        source={{ uri: url }}
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(req) => req.url === url || req.url === "about:blank"}
        javaScriptEnabled={false}
        domStorageEnabled={false}
        incognito
        cacheEnabled={false}
        sharedCookiesEnabled={false}
        allowsLinkPreview={false}
        scrollEnabled={false}
        bounces={false}
        onLoad={() => {
          paintTimer.current = setTimeout(() => {
            markThumbSeen(artifact.id);
            setDrawn(true);
          }, PAINT_MS);
        }}
        onError={() => setFailed(true)}
        style={styles.web}
      />
      {drawn ? null : (
        <View style={styles.cover}>
          <PageSkeleton compact />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    web: { flex: 1, backgroundColor: colors.bg },
    cover: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg, overflow: "hidden" },
  });
