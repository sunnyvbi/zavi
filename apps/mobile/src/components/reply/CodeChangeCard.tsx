import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CodeChangeModel } from "../../features/agents/replyCards";
import { Icon } from "../Icon";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Card, CardButton, makeUi } from "./ui";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

function actionStyle(action: string, colors: Colors): { label: string; bg: string; fg: string } {
  const st = colors.status;
  if (action === "create") return { label: "NEW", bg: st.greenBg, fg: st.greenText };
  if (action === "modify") return { label: "CHANGED", bg: st.amberBg, fg: st.amberText };
  if (action === "delete") return { label: "DELETED", bg: st.redBg, fg: st.redText };
  return { label: action.toUpperCase(), bg: colors.soft, fg: colors.muted };
}

function riskLabel(risk: string): string {
  const r = risk.toLowerCase();
  return r.includes("risk") ? risk : `${risk.charAt(0).toUpperCase()}${risk.slice(1)} risk`;
}

export function CodeChangeCard({
  model,
  actionable,
  busy,
  onQuickReply,
  onPrefill,
}: {
  model: CodeChangeModel;
  actionable: boolean;
  busy?: boolean;
  onQuickReply?: (text: string) => Promise<boolean>;
  onPrefill?: (text: string, hint?: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const n = model.files.length;
  const showActions = actionable && !sent;

  return (
    <Card>
      <View style={styles.meta}>
        {model.risk ? (
          <View style={[styles.risk, /high/i.test(model.risk) && styles.riskHigh]}>
            <Text style={[styles.riskText, /high/i.test(model.risk) && styles.riskHighText]}>{riskLabel(model.risk)}</Text>
          </View>
        ) : null}
        <Text style={ui.small}>Code change{actionable ? " · waiting for you" : ""}</Text>
      </View>
      <Text style={ui.title}>{model.title}</Text>
      {model.points.length > 0 ? (
        <View style={styles.points}>
          {model.points.map((p, i) => (
            <View key={i} style={styles.point}>
              <Icon name="check" size={14} color={colors.muted} />
              <Text style={[ui.body, styles.pointText]}>{p}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.toggle}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={open ? undefined : styles.chevronClosed}>
          <Icon name="chevronDown" size={14} color={colors.muted} />
        </View>
        <Text style={ui.small}>
          {open
            ? "Hide the code"
            : `Show the code (${n} file${n === 1 ? "" : "s"}${model.lines > 0 ? `, ${model.lines} lines` : ""}, for whoever reads code)`}
        </Text>
      </Pressable>

      {open ? (
        <View style={styles.files}>
          {model.files.map((f) => {
            const a = actionStyle(f.action, colors);
            return (
              <View key={f.path} style={styles.file}>
                <View style={styles.fileHead}>
                  <View style={[styles.action, { backgroundColor: a.bg }]}>
                    <Text style={[styles.actionText, { color: a.fg }]}>{a.label}</Text>
                  </View>
                  <Text style={styles.path} numberOfLines={2}>
                    {f.path}
                  </Text>
                </View>
                {f.diff ? (
                  <ScrollView horizontal style={styles.diff} showsHorizontalScrollIndicator={false}>
                    <View>
                      {f.diff.split("\n").map((ln, i) => {
                        const add = ln.startsWith("+") && !ln.startsWith("+++");
                        const del = ln.startsWith("-") && !ln.startsWith("---");
                        const hdr = ln.startsWith("@@") || ln.startsWith("+++") || ln.startsWith("---");
                        return (
                          <Text
                            key={i}
                            style={[styles.line, add && styles.add, del && styles.del, hdr && styles.hdr]}
                          >
                            {ln || " "}
                          </Text>
                        );
                      })}
                    </View>
                  </ScrollView>
                ) : (
                  <Text style={ui.small}>{f.action === "delete" ? "File removed." : "No preview for this file."}</Text>
                )}
              </View>
            );
          })}
          <Text style={ui.small}>Swipe a long line sideways to read it.</Text>
        </View>
      ) : null}

      {showActions ? (
        <>
          <Text style={ui.muted}>
            Say yes and Zavi opens it for review. Nothing goes live until it is merged on the web.
          </Text>
          <View style={ui.row}>
            <CardButton
              label="Yes, open it"
              disabled={busy || !onQuickReply}
              onPress={() => {
                void onQuickReply?.("yes").then((ok) => ok && setSent(true));
              }}
            />
            <CardButton
              label="Change something"
              variant="secondary"
              onPress={() => onPrefill?.("", "Say what to change…")}
            />
          </View>
        </>
      ) : null}
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  meta: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  risk: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.status.greenBg },
  riskText: { fontSize: font.size.xs, fontFamily: font.family.semi, color: colors.status.greenText },
  riskHigh: { backgroundColor: colors.status.redBg },
  riskHighText: { color: colors.status.redText },
  points: { gap: 6 },
  point: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  pointText: { flex: 1, marginTop: -2 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 6 },
  chevronClosed: { transform: [{ rotate: "-90deg" }] },
  files: { gap: space.md },
  file: { gap: 6 },
  fileHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  action: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  actionText: { fontSize: 10, fontFamily: font.family.semi },
  path: { flex: 1, fontFamily: mono, fontSize: font.size.sm, color: colors.ink },
  diff: { borderRadius: radius.sm, backgroundColor: colors.soft, paddingVertical: 6 },
  line: { fontFamily: mono, fontSize: 11.5, lineHeight: 17, paddingHorizontal: 8, color: colors.ink },
  add: { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
  del: { backgroundColor: colors.status.redBg, color: colors.status.redText },
  hdr: { color: colors.muted },
});
