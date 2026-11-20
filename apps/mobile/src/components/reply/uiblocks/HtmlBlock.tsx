import { useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { htmlRendersBlank, type HtmlBlock as HtmlBlockModel } from "@zavi/shared";
import { harden, previewNavDecision } from "../../../features/agents/previews";
import { font, radius, type Colors } from "../../../theme/tokens";
import { useStyles } from "../../../theme/theme";
import { Card } from "../ui";

const FRAME_HEIGHT = 300;

const FIT_HEAD =
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<style>` +
  `html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;background:#fff!important}` +
  `body{display:flex!important;align-items:center!important;justify-content:center!important}` +
  `body>*{width:100%!important;max-width:100%!important;box-sizing:border-box!important}` +
  `svg[viewBox]{width:100%!important;height:auto!important;max-height:100%!important}` +
  `img,canvas{max-width:100%!important;height:auto!important}` +
  `</style>`;

function fitSource(rawHtml: string): string {
  const html = harden(rawHtml);
  return html.replace(/(<meta http-equiv="Content-Security-Policy"[^>]*>)/, `$1${FIT_HEAD}`);
}

export function HtmlBlock({ block }: { block: HtmlBlockModel }) {
  const styles = useStyles(makeStyles);
  const loaded = useRef(false);
  const [tripped, setTripped] = useState(false);
  const blank = block.scripts !== true && htmlRendersBlank(block.html);

  return (
    <Card style={styles.flatCard}>
      <Text style={styles.title}>{block.title}</Text>
      {blank ? (
        <View style={styles.messageBox}>
          <Text style={styles.message}>
            This visual needed a script to draw itself. Ask for it as a chart instead.
          </Text>
        </View>
      ) : tripped ? (
        <View style={[styles.messageBox, styles.errorBox]}>
          <Text style={[styles.message, styles.errorText]}>This visual tried to navigate away and was stopped.</Text>
        </View>
      ) : (
        <View style={styles.frame}>
          <WebView
            source={{ html: fitSource(block.html) }}
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
              const decision = previewNavDecision(req.url, { loaded: loaded.current });
              if (decision === "block") setTripped(true);
              return decision === "allow";
            }}
            onLoad={() => {
              if (loaded.current) setTripped(true);
              loaded.current = true;
            }}
            onError={() => setTripped(true)}
            accessibilityLabel={`Visual: ${block.title}`}
            style={styles.webview}
          />
        </View>
      )}
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  title: { fontSize: 16, lineHeight: 22, fontFamily: font.family.semi, color: colors.ink },
  flatCard: { padding: 0, borderWidth: 0, backgroundColor: "transparent" },
  frame: {
    height: FRAME_HEIGHT,
    overflow: "hidden",
    borderRadius: radius.sm,
    backgroundColor: "#ffffff",
  },
  webview: { flex: 1, backgroundColor: "#ffffff" },
  messageBox: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.soft,
    padding: 10,
  },
  errorBox: {
    borderColor: colors.errorBorder,
    backgroundColor: colors.errorBg,
  },
  message: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.regular,
    color: colors.textSecondary,
  },
  errorText: { color: colors.red },
});
