import { useState } from "react";
import { Clipboard, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { CardButton } from "../reply/ui";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const MCP_URL = "https://api.zaviagent.com/mcp";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

const TOOLS: { name: string; what: string }[] = [
  { name: "zavi_ask", what: "Ask the operator anything — it scopes the work or hands off" },
  { name: "zavi_list_agents", what: "List the agents your workspace can run" },
  { name: "zavi_run_agent", what: "Run one agent by slug" },
  { name: "zavi_get_run_status", what: "Poll a run for status + result" },
  { name: "zavi_recent_runs", what: "Recent runs, newest first" },
  { name: "zavi_read_brain", what: "Read your company-brain notes" },
  { name: "zavi_search", what: "Search notes + runs" },
  { name: "zavi_fetch", what: "Fetch one search result in full" },
];

const CLIENTS: { label: string; snippet: string; note: string }[] = [
  {
    label: "Claude Code",
    snippet: `claude mcp add --transport http zavi ${MCP_URL}`,
    note: "Then run /mcp and complete the browser login.",
  },
  {
    label: "claude.ai",
    snippet: MCP_URL,
    note: "Settings → Connectors → Add custom connector. Paste the URL, approve in the popup.",
  },
  {
    label: "ChatGPT",
    snippet: MCP_URL,
    note: "Settings → Connectors (Developer Mode, admin-enabled workspace). Paste the URL, complete OAuth.",
  },
];

export function McpConnectCard() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [toolsOpen, setToolsOpen] = useState(false);
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.title} accessibilityRole="header">
          Connect your AI client
        </Text>
        <Text style={styles.blurb}>
          Drive your agents from Claude Code, claude.ai or ChatGPT. Paste this URL, approve in the browser, and your
          client can ask Zavi questions and run your agents. There is no token to copy — the client handles that
          itself.
        </Text>
      </View>

      <View style={styles.urlBox}>
        <Text style={styles.url} selectable>
          {MCP_URL}
        </Text>
        <CopyButton value={MCP_URL} label="server URL" />
      </View>

      <View style={styles.clients}>
        {CLIENTS.map((c) => (
          <View key={c.label} style={styles.box}>
            <View style={styles.clientHead}>
              <Text style={styles.boxTitle}>{c.label}</Text>
              <CopyButton value={c.snippet} label={`${c.label} command`} />
            </View>
            {}
            <Text style={styles.snippet} selectable>
              {c.snippet}
            </Text>
            <Text style={styles.note}>{c.note}</Text>
          </View>
        ))}
      </View>

      {}
      <View style={styles.fold}>
        <View style={styles.foldClip}>
          <Pressable
            style={({ pressed }) => [styles.foldHead, pressed && styles.foldHeadPressed]}
            onPress={() => setToolsOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: toolsOpen }}
          >
            <Text style={[styles.boxTitle, styles.foldTitle]}>
              {`What your client can do once connected (${TOOLS.length} tools)`}
            </Text>
            <View style={toolsOpen ? undefined : styles.chevronClosed}>
              <Icon name="chevronDown" size={18} color={colors.muted} />
            </View>
          </Pressable>
          {toolsOpen ? (
            <View style={styles.foldBody}>
              {TOOLS.map((t) => (
                <View key={t.name} style={styles.tool}>
                  <Text style={styles.toolName} selectable>
                    {t.name}
                  </Text>
                  <Text style={styles.note}>{t.what}</Text>
                </View>
              ))}
              <Text style={[styles.note, styles.approval]}>
                Ad changes started from your AI client are never applied without your approval, even with Autopilot
                on, a spend cap set, or a custom agent doing the work. Posting and sending email follow your approval
                settings, as they do in Zavi. Runs from your AI client use your credits and can&apos;t make AI images,
                video or audio, or take or send payments.
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <CardButton
      label={copied ? "Copied" : "Copy"}
      variant="secondary"
      accessibilityLabel={`Copy ${label}`}
      onPress={() => {
        Clipboard.setString(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    />
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: 20 },
  head: { gap: 6 },
  title: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
  blurb: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  urlBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 14,
    paddingVertical: space.md,
    borderWidth: 1,
    borderColor: colors.wire.lineSoft,
    borderRadius: radius.md,
    backgroundColor: colors.wire.head,
  },
  url: { flex: 1, minWidth: 0, fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.ink },
  clients: { gap: space.md },
  box: {
    gap: space.sm,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 16,
    backgroundColor: colors.panel,
  },
  clientHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  boxTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
  snippet: { fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  note: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  fold: { borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, backgroundColor: colors.panel },
  foldClip: { borderRadius: 15, overflow: "hidden" },
  foldHead: { flexDirection: "row", alignItems: "center", gap: space.md, padding: 14 },
  foldHeadPressed: { backgroundColor: colors.soft },
  foldTitle: { flex: 1 },
  chevronClosed: { transform: [{ rotate: "-90deg" }] },
  foldBody: { gap: space.sm, paddingHorizontal: 14, paddingBottom: 14 },
  tool: { gap: 2 },
  toolName: { fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.ink },
  approval: { marginTop: space.xs },
});
