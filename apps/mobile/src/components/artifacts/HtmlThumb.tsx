import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { SAFE_WEBVIEW, loadArtifactHtml, peekArtifactHtml, PageSkeleton } from "./HtmlArtifactViewer";
import { harden, previewNavDecision } from "../../features/agents/previews";
import type { Artifact } from "../../features/artifacts/types";
import { markThumbSeen, wasThumbSeen } from "./thumbSeen";
import { useStyles } from "../../theme/theme";
import type { Colors } from "../../theme/tokens";

const PAGE_WIDTH = 390;

const PAINT_MS = 800;

export function HtmlThumb({ artifact, fallback, instant = false }: { artifact: Artifact; fallback: ReactNode; instant?: boolean }) {
  const styles = useStyles(makeStyles);
  const [html, setHtml] = useState<string | null>(() => peekArtifactHtml(artifact.id));
  const [failed, setFailed] = useState(false);
  const [drawn, setDrawn] = useState(() => instant && wasThumbSeen(artifact.id));
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const loaded = useRef(false);

  useEffect(() => {
    let alive = true;
    setHtml(peekArtifactHtml(artifact.id));
    setFailed(false);
    setDrawn(instant && wasThumbSeen(artifact.id));
    loaded.current = false;
    loadArtifactHtml(artifact.id)
      .then((t) => {
        if (alive) setHtml(t);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (paintTimer.current) clearTimeout(paintTimer.current);
    };
  }, [artifact.id]);

  if (failed) return <>{fallback}</>;

  const scale = box.w > 0 ? box.w / PAGE_WIDTH : 0;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {html !== null && scale > 0 ? (
        <View style={[styles.page, { width: PAGE_WIDTH, height: box.h / scale, transform: [{ scale }] }]}>
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
                setDrawn(true);
              }, PAINT_MS);
            }}
            onError={() => setFailed(true)}
            style={styles.web}
          />
        </View>
      ) : null}
      {drawn ? null : (
        <View style={styles.skeleton}>
          <PageSkeleton compact />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { position: "absolute", top: 0, left: 0, transformOrigin: "top left", backgroundColor: colors.bg, overflow: "hidden" },
    web: { flex: 1, backgroundColor: colors.bg },
    skeleton: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg, overflow: "hidden" },
  });
