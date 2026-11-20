import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  agentName,
  emptyAnswer,
  missingRequired,
  seedAnswers,
  toStructuredAnswers,
  toggleOption,
  type ClarifyAnswer,
  type ClarifyModel,
} from "../../features/agents/replyCards";
import { fetchClarifySubmitted, submitClarify } from "../../features/agents/replyApi";
import { FocusRing } from "../ZaviTextField";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Card, CardButton, ErrorLine, errorText, makeUi } from "./ui";

export function ClarifyCard({
  slug,
  model,
  onRunStarted,
  busy = false,
  claimRun,
  releaseRun,
}: {
  slug: string;
  model: ClarifyModel;
  onRunStarted?: (runId: string) => void;
  busy?: boolean;
  claimRun?: () => boolean;
  releaseRun?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>(() => seedAnswers(model));
  const [step, setStep] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchClarifySubmitted(model.request_id)
      .then((done) => {
        if (!cancelled && done) setSubmitted(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [model.request_id]);

  const questions = model.questions;
  const total = questions.length;
  const idx = Math.min(step, total - 1);
  const q = questions[idx];
  const a = answers[q.id] ?? emptyAnswer();
  const isLast = idx === total - 1;
  const selected = useMemo(() => new Set(a.optionIds), [a.optionIds]);

  const setAnswer = (id: string, next: ClarifyAnswer) => setAnswers((prev) => ({ ...prev, [id]: next }));
  const goTo = (i: number) => {
    setError(null);
    setStep(Math.max(0, Math.min(i, total - 1)));
  };

  async function submitWith(snapshot: Record<string, ClarifyAnswer>) {
    if (busy) {
      setError("Zavi is still working. Send your answers when it finishes.");
      return;
    }
    const missing = missingRequired(model, snapshot);
    if (missing.length > 0) {
      goTo(questions.findIndex((x) => x.id === missing[0].id));
      setError(`Please answer: ${missing.map((x) => x.header).join(", ")}.`);
      return;
    }
    if (claimRun && !claimRun()) return;
    setError(null);
    setSending(true);
    try {
      const res = await submitClarify(slug, model.request_id, toStructuredAnswers(model, snapshot));
      setSubmitted(true);
      if (res?.run_id) onRunStarted?.(res.run_id);
    } catch (e) {
      setError(errorText(e, "Couldn't send your answers. Please try again."));
    } finally {
      setSending(false);
      releaseRun?.();
    }
  }

  if (submitted) {
    return (
      <Card>
        <Text style={ui.muted}>Answers sent. {agentName(slug)} is continuing.</Text>
      </Card>
    );
  }

  const showOther = q.type === "text" || q.allow_other;

  return (
    <Card>
      <View style={styles.head}>
        <Text style={styles.header} numberOfLines={1}>
          {q.header}
        </Text>
        <Text style={ui.small}>
          {idx + 1} of {total}
        </Text>
      </View>

      <View>
        <Text style={styles.question}>
          {q.text}
          {q.required ? <Text style={styles.required}> *</Text> : null}
        </Text>
        {q.why ? <Text style={[ui.small, styles.why]}>{q.why}</Text> : null}
      </View>

      {q.type !== "text" && q.options.length > 0 ? (
        <View style={styles.options} accessibilityRole={q.type === "single" ? "radiogroup" : undefined}>
          {q.options.map((opt) => {
            const on = selected.has(opt.id);
            const suggested = !!opt.provenance && (opt.prefill || opt.recommended);
            return (
              <Pressable
                key={opt.id}
                onPress={() => setAnswer(q.id, toggleOption(q, a, opt.id))}
                accessibilityRole={q.type === "single" ? "radio" : "checkbox"}
                accessibilityState={{ checked: on }}
                style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && styles.optionPressed]}
              >
                <View
                  style={[
                    styles.mark,
                    q.type === "single" ? styles.markRound : styles.markSquare,
                    on && styles.markOn,
                  ]}
                >
                  {on ? <Text style={styles.markTick}>✓</Text> : null}
                </View>
                <View style={styles.optionText}>
                  <Text style={styles.optionLabel}>
                    {opt.label}
                    {opt.recommended && opt.provenance ? (
                      <Text style={styles.recommended}>  recommended</Text>
                    ) : null}
                  </Text>
                  {opt.description ? <Text style={ui.small}>{opt.description}</Text> : null}
                  {suggested ? (
                    <Text style={[ui.small, styles.provenance]} numberOfLines={2}>
                      Suggested from {opt.provenance?.source_label || "saved context"}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {showOther ? (
        <View style={styles.otherWrap}>
          {q.type !== "text" ? <Text style={styles.otherLabel}>Other</Text> : null}
          <FocusRing radius={radius.md}>
            {(focus) => (
              <TextInput
                keyboardAppearance={keyboardAppearance}
                value={a.otherText}
                onChangeText={(t) => setAnswer(q.id, { ...a, otherText: t, skipped: false })}
                placeholder={q.type === "text" ? "Type your answer" : "Something else"}
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                maxLength={q.max_length ?? 2000}
                multiline
                style={[styles.input, q.type === "text" && styles.inputTall]}
                onFocus={() => focus.onFocus()}
                onBlur={() => focus.onBlur()}
              />
            )}
          </FocusRing>
        </View>
      ) : null}

      <ErrorLine message={error} />

      <View style={styles.footer}>
        {idx > 0 ? <CardButton label="Back" variant="secondary" onPress={() => goTo(idx - 1)} /> : null}
        {q.allow_skip && !q.required ? (
          <CardButton
            label="Skip"
            variant="plain"
            disabled={sending}
            onPress={() => {
              const next = { ...answers, [q.id]: { optionIds: [], otherText: "", skipped: true } };
              setAnswers(next);
              if (!isLast) goTo(idx + 1);
              else void submitWith(next);
            }}
          />
        ) : null}
        <View style={styles.spacer} />
        {isLast ? (
          <CardButton
            label={sending ? "Sending" : (model.submit_label ?? "Send answers")}
            busy={sending}
            onPress={() => void submitWith(answers)}
          />
        ) : (
          <CardButton label="Next" onPress={() => goTo(idx + 1)} />
        )}
      </View>
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  header: {
    flexShrink: 1,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.soft,
    overflow: "hidden",
    fontSize: font.size.xs,
    fontFamily: font.family.medium,
    color: colors.textSecondary,
  },
  question: { fontSize: 16, lineHeight: 23, fontFamily: font.family.medium, color: colors.ink },
  required: { color: colors.red },
  why: { marginTop: 4 },
  options: { gap: space.sm },
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  optionOn: { borderColor: colors.ink, backgroundColor: colors.soft },
  optionPressed: { backgroundColor: colors.soft },
  mark: {
    width: 18,
    height: 18,
    marginTop: 1,
    borderWidth: 1,
    borderColor: colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  markRound: { borderRadius: 9 },
  markSquare: { borderRadius: 4 },
  markOn: { borderColor: colors.ink, backgroundColor: colors.ink },
  markTick: { fontSize: 11, lineHeight: 13, color: colors.onInk },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontSize: font.size.base, lineHeight: 20, fontFamily: font.family.medium, color: colors.ink },
  recommended: { fontSize: font.size.xs, fontFamily: font.family.semi, color: colors.green },
  provenance: { fontStyle: "italic" },
  otherWrap: { gap: 6 },
  otherLabel: { fontSize: 14, fontFamily: font.family.medium, color: colors.muted },
  input: {
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 20,
    fontFamily: font.family.medium,
    color: colors.ink,
    textAlignVertical: "top",
  },
  inputTall: { minHeight: 80 },
  footer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  spacer: { flex: 1 },
});
