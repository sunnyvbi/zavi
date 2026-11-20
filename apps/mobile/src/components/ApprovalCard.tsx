import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar } from "./Avatar";
import { UnderlinedText } from "./UnderlinedText";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import {
  useApproveDecision,
  useRejectDecision,
  type Decision,
} from "../features/approvals/hooks";
import { ErrorCard } from "./ErrorCard";

const HIGH_RISK = ["budget", "spend", "pr.merge", "payment", "delete"];

export function isHighRisk(decisionClass: string): boolean {
  const c = (decisionClass || "").toLowerCase();
  return HIGH_RISK.some((k) => c.includes(k));
}

function summarize(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["summary", "title", "description", "text", "message"]) {
      const v = b[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "Review the details before deciding.";
}

function prettyClass(decisionClass: string): string {
  return decisionClass || "decision";
}

function agentName(slug: string | null): string {
  if (!slug) return "Agent";
  if (slug === "operator") return "Operator";
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function ApprovalCard({
  decision,
  variant,
}: {
  decision: Decision;
  variant: "inline" | "list";
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const approve = useApproveDecision();
  const reject = useRejectDecision();
  const [confirming, setConfirming] = useState(false);

  const highRisk = isHighRisk(decision.decision_class);
  const slug = decision.agent_slug;
  const busy = approve.isPending || reject.isPending;

  function onApprove() {
    if (busy) return;
    if (highRisk && !confirming) {
      setConfirming(true);
      return;
    }
    approve.mutate(decision);
  }

  function onReject() {
    if (busy) return;
    setConfirming(false);
    reject.mutate(decision);
  }

  function onRefine() {
    if (!slug) return;
    router.push({ pathname: "/chat", params: { prefill: "Refine: " } });
  }

  function onContext() {
    if (!slug) return;
    router.push("/chat");
  }

  const body = (
    <View style={styles.card}>
      <View style={styles.head}>
        {variant === "list" && slug ? (
          <Avatar slug={slug} name={agentName(slug)} size={32} />
        ) : null}
        <View style={styles.headMain}>
          <Text style={styles.kicker}>APPROVAL NEEDED</Text>
          <Text style={styles.title} numberOfLines={1}>
            {agentName(slug)} · {prettyClass(decision.decision_class)}
          </Text>
        </View>
        {highRisk ? (
          <View style={styles.moneyTag}>
            <Text style={styles.moneyTagText}>$$$</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.summary} numberOfLines={variant === "inline" ? 3 : 4}>
        {summarize(decision.body)}
      </Text>

      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, busy && styles.btnDisabled]}
          onPress={onReject}
          disabled={busy}
        >
          <Text style={styles.btnText}>{reject.isPending ? "…" : "Reject"}</Text>
        </Pressable>
        <Pressable style={[styles.btn, busy && styles.btnDisabled]} onPress={onRefine} disabled={busy}>
          <Text style={styles.btnText}>Refine</Text>
        </Pressable>
        {highRisk ? (
          <Pressable
            style={[styles.btn, styles.btnReview, busy && styles.btnDisabled]}
            onPress={onApprove}
            disabled={busy}
          >
            {approve.isPending ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={[styles.btnText, styles.btnTextOnAccent]}>
                {confirming ? "Confirm" : "Review"}
              </Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
            onPress={onApprove}
            disabled={busy}
          >
            {approve.isPending ? (
              <ActivityIndicator size="small" color={colors.onInk} />
            ) : (
              <Text style={[styles.btnText, styles.btnTextOnInk]}>Approve</Text>
            )}
          </Pressable>
        )}
      </View>

      {variant === "list" && slug ? (
        <Pressable onPress={onContext} hitSlop={8} style={styles.contextLink}>
          <UnderlinedText style={styles.contextText}>View context ›</UnderlinedText>
        </Pressable>
      ) : null}

      {(approve.isError || reject.isError) && !busy ? (
        <ErrorCard message="Couldn't save that decision. Try again." />
      ) : null}
    </View>
  );

  return body;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.approvalBorder,
    backgroundColor: colors.approvalBg,
    borderRadius: 14,
    padding: 11,
  },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  headMain: { flex: 1, minWidth: 0 },
  kicker: {
    fontSize: 10,
    fontWeight: "800",
    color: colors.amber,
    letterSpacing: 0.5,
  },
  title: { marginTop: 2, fontSize: font.size.md, fontWeight: "800", color: colors.ink },
  moneyTag: {
    paddingHorizontal: 6,
    height: 18,
    borderRadius: radius.pill,
    backgroundColor: colors.amberFill,
    alignItems: "center",
    justifyContent: "center",
  },
  moneyTagText: { fontSize: 9, fontWeight: "800", color: colors.onAccent },
  summary: { marginTop: 8, fontSize: font.size.sm, color: colors.ink, lineHeight: 18 },
  actions: {
    flexDirection: "row",
    gap: 6,
    marginTop: 10,
  },
  btn: {
    flex: 1,
    height: 32,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
    alignItems: "center",
    justifyContent: "center",
  },
  btnDisabled: { opacity: 0.5 },
  btnPrimary: { backgroundColor: colors.ink, borderColor: colors.ink },
  btnReview: { backgroundColor: colors.amberFill, borderColor: colors.amberFill },
  btnText: { fontSize: 11, fontWeight: "800", color: colors.ink },
  btnTextOnInk: { color: colors.onInk },
  btnTextOnAccent: { color: colors.onAccent },
  contextLink: { marginTop: 8, alignSelf: "flex-start" },
  contextText: { fontFamily: font.family.semi, includeFontPadding: false, fontSize: 12, color: colors.ink },
});
