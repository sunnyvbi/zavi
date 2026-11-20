import { useEffect, useState } from "react";
import { Clipboard, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import {
  changeSharedPage,
  fetchSharedPages,
  type SharedPage,
} from "../../features/agents/replyApi";
import { space } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { Card, CardButton, ErrorLine, errorText, makeUi } from "./ui";

export function SharedPages({ runId }: { runId: string }) {
  const [pages, setPages] = useState<SharedPage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSharedPages(runId)
      .then((d) => {
        if (!cancelled) setPages(d.pages ?? []);
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (!pages || pages.length === 0) return null;
  return (
    <View>
      {pages.map((p) => (
        <SharedPageCard key={p.id} initial={p} />
      ))}
    </View>
  );
}

function SharedPageCard({ initial }: { initial: SharedPage }) {
  const ui = useStyles(makeUi);
  const [page, setPage] = useState(initial);
  const [busy, setBusy] = useState<null | "publish" | "revoke">(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function copy(url: string) {
    Clipboard.setString(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function act(action: "publish" | "revoke") {
    setBusy(action);
    setError(null);
    try {
      const res = await changeSharedPage(page.id, action);
      if (!res.page) throw new Error("");
      setPage(res.page);
      if (action === "publish" && res.page.public_url) copy(res.page.public_url);
    } catch (e) {
      setError(errorText(e, action === "publish" ? "Could not make it public." : "Could not revoke the link."));
    } finally {
      setBusy(null);
    }
  }

  const expires = page.expires_at
    ? new Date(page.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  return (
    <Card style={styles.card}>
      <View>
        <Text style={ui.title} numberOfLines={2}>
          {page.title}
        </Text>
        <Text style={ui.small}>Page · {page.visibility === "public" ? "Public" : "Private"}</Text>
      </View>
      <View style={ui.row}>
        {}
        {page.visibility === "public" && page.public_url ? (
          <CardButton
            label="Open"
            variant="secondary"
            onPress={() => void WebBrowser.openBrowserAsync(page.public_url as string).catch(() => {})}
          />
        ) : null}
        {page.visibility === "private" ? (
          <CardButton
            label={busy === "publish" ? "Making public" : "Make public"}
            busy={busy === "publish"}
            disabled={busy !== null}
            onPress={() => void act("publish")}
          />
        ) : (
          <>
            <CardButton
              label={copied ? "Link copied" : "Copy public link"}
              disabled={!page.public_url}
              onPress={() => page.public_url && copy(page.public_url)}
            />
            <CardButton
              label={busy === "revoke" ? "Revoking" : "Revoke"}
              variant="plain"
              busy={busy === "revoke"}
              disabled={busy !== null}
              onPress={() => void act("revoke")}
            />
          </>
        )}
      </View>
      <Text style={ui.small}>
        {page.visibility === "private"
          ? "Only your workspace can see this page."
          : `Anyone with the link can open it${expires ? ` until ${expires}` : ""}.`}
      </Text>
      <ErrorLine message={error} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
});
