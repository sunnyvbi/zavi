import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { HtmlPreviewModel } from "../../features/agents/replyCards";
import { harden, previewNavDecision } from "../../features/agents/previews";
import { ackHtmlPreviewDisplayed, fetchHtmlPreview } from "../../features/agents/replyApi";
import { radius, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { Card, CardButton, ErrorLine, makeUi } from "./ui";

const BLOCKED_SUFFIX = " The build remains blocked until a preview is displayed.";

export function HtmlPreviewCard({
  model,
  onQuickReply,
  onPrefill,
}: {
  model: HtmlPreviewModel;
  onQuickReply?: (text: string) => Promise<boolean>;
  onPrefill?: (text: string, placeholderHint?: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const [html, setHtml] = useState<string | null>(model.html);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    setReady(false);
    setError(null);
    if (model.html !== null) {
      setHtml(model.html);
      return;
    }
    setHtml(null);
    if (!model.previewId) {
      setError("Preview artifact is missing.");
      return;
    }
    fetchHtmlPreview(model.previewId)
      .then((h) => {
        if (!cancelled) setHtml(h);
      })
      .catch((e) => {
        if (cancelled) return;
        const m = e instanceof Error && e.message === "Preview artifact is not ready." ? e.message : null;
        setError(m ?? "Preview artifact is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [model.html, model.previewId]);

  async function onLoad() {
    if (loaded.current) return;
    loaded.current = true;
    if (!model.previewId) {
      setReady(true);
      return;
    }
    try {
      await ackHtmlPreviewDisplayed(model.previewId);
      setReady(true);
    } catch {
      setError("Preview display could not be verified.");
    }
  }

  async function build() {
    if (!onQuickReply || sending) return;
    setSending(true);
    setSendError(null);
    const ok = await onQuickReply("build it");
    setSending(false);
    if (!ok) setSendError("Couldn't send that. Try again or type it.");
  }

  return (
    <Card>
      <View style={styles.head}>
        <Text style={ui.title}>{model.title}</Text>
        {model.summary ? <Text style={ui.small}>{model.summary}</Text> : null}
      </View>
      <View style={styles.frame}>
        {error ? (
          <View style={styles.placeholder}>
            <Text style={styles.errorText}>{error + BLOCKED_SUFFIX}</Text>
          </View>
        ) : html === null ? (
          <View style={styles.placeholder}>
            <View style={styles.skeleton} />
          </View>
        ) : (
          <WebView
            source={{ html: harden(html) }}
            originWhitelist={["*"]}
            javaScriptEnabled={false}
            javaScriptCanOpenWindowsAutomatically={false}
            setSupportMultipleWindows={false}
            domStorageEnabled={false}
            incognito
            cacheEnabled={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            allowsLinkPreview={false}
            dataDetectorTypes={Platform.OS === "ios" ? "none" : undefined}
            mediaPlaybackRequiresUserAction
            nestedScrollEnabled
            onShouldStartLoadWithRequest={(req) => {
              return previewNavDecision(req.url, { loaded: loaded.current }) === "allow";
            }}
            onLoad={() => void onLoad()}
            onError={() => setError("Preview artifact is unavailable.")}
            accessibilityLabel={`UI preview: ${model.title}`}
            style={styles.webview}
          />
        )}
      </View>
      <Text style={ui.small}>Static mock of one screen. The buttons and links inside it are inert.</Text>
      <View style={ui.row}>
        {onQuickReply ? (
          <CardButton label="Looks good, build it" onPress={() => void build()} disabled={!ready} busy={sending} />
        ) : null}
        {onPrefill ? (
          <CardButton
            label="Change…"
            variant="secondary"
            onPress={() => onPrefill("", "Describe what to change…")}
          />
        ) : null}
      </View>
      <ErrorLine message={sendError} />
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { gap: 2 },
  frame: {
    height: 360,
    overflow: "hidden",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg,
  },
  webview: { flex: 1, backgroundColor: colors.bg },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  skeleton: { width: 96, height: 16, borderRadius: 4, backgroundColor: colors.soft },
  errorText: { color: colors.red, textAlign: "center" },
});
