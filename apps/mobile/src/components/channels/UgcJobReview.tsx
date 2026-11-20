import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { FocusRing } from "../ZaviTextField";
import type { Revealable } from "../useKeyboardReveal";
import { ErrorText, ReadOnlyNote, StateLine, UgcButton } from "./UgcParts";
import {
  NO_SCORES,
  REVIEW_AXES,
  REVIEW_NOTE_MAX,
  reviewReady,
  reviewSub,
  reviewThanks,
  reviewedLine,
  starLabel,
  type ReviewScores,
} from "../../features/channels/ugcJob";
import { useJobReview, usePostReview } from "../../features/channels/ugcJobHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const STAR = "M12 2.5l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.52l-5.88 3.09 1.12-6.55L2.48 9.42l6.58-.96L12 2.5z";

export function ReviewBox({ orderId, first, canWrite, reveal }: { orderId: string; first: string; canWrite: boolean; reveal: (t: Revealable | null) => void }) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const q = useJobReview(orderId, true);
  const post = usePostReview(orderId);
  const [scores, setScores] = useState<ReviewScores>(NO_SCORES);
  const [note, setNote] = useState("");
  const [posted, setPosted] = useState<ReviewScores | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<TextInput>(null);
  const lock = useRef(false);
  const ready = reviewReady(scores);

  function submit() {
    if (!ready || post.isPending || lock.current) return;
    lock.current = true;
    setError(null);
    const sent = scores;
    post.mutate(
      { scores: sent, note },
      {
        onSuccess: () => setPosted(sent),
        onError: (e) => setError(e instanceof Error && e.message ? e.message : "Couldn't post the review. Try again."),
        onSettled: () => {
          lock.current = false;
        },
      },
    );
  }

  let content;
  if (posted) {
    content = <Text style={styles.done}>{reviewThanks(posted, first)}</Text>;
  } else if (q.data === undefined) {
    content = <StateLine loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} />;
  } else if (q.data !== null) {
    content = <Text style={styles.done}>{reviewedLine(first)}</Text>;
  } else if (!canWrite) {
    content = <ReadOnlyNote />;
  } else {
    content = (
      <>
        {REVIEW_AXES.map((axis) => (
          <View key={axis.id} style={styles.axis}>
            <Text style={styles.axisLabel}>{axis.label}</Text>
            <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel={axis.label}>
              {[1, 2, 3, 4, 5].map((k) => {
                const on = k <= scores[axis.id];
                return (
                  <Pressable
                    key={k}
                    style={({ pressed }) => [styles.star, pressed && styles.pressed]}
                    onPress={() => setScores((s) => ({ ...s, [axis.id]: k }))}
                    hitSlop={2}
                    accessibilityRole="radio"
                    accessibilityLabel={starLabel(axis.label, k)}
                    accessibilityState={{ checked: scores[axis.id] === k }}
                  >
                    <Svg width={26} height={26} viewBox="0 0 24 24">
                      <Path d={STAR} fill={on ? colors.status.amberDot : "none"} stroke={on ? colors.status.amberDot : colors.muted} strokeWidth={1.5} strokeLinejoin="round" />
                    </Svg>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
        <Text style={styles.noteLabel}>
          Note <Text style={styles.optional}>optional</Text>
        </Text>
        <FocusRing radius={radius.sm}>
          {(focus) => (
            <TextInput
              ref={noteRef}
              style={styles.input}
              value={note}
              onChangeText={setNote}
              onFocus={() => {
                focus.onFocus();
                reveal(noteRef.current);
              }}
              onBlur={focus.onBlur}
              multiline
              maxLength={REVIEW_NOTE_MAX}
              placeholder={`What was it like working with ${first}?`}
              placeholderTextColor={colors.muted}
              keyboardAppearance={keyboardAppearance}
              selectionColor={textSelectionColor}
              cursorColor={colors.ink}
              selectionHandleColor={colors.ink}
              accessibilityLabel="Note, optional"
            />
          )}
        </FocusRing>
        <ErrorText>{error}</ErrorText>
        <View style={styles.footer}>
          {!ready ? <Text style={styles.hint}>Rate all three to post</Text> : null}
          <UgcButton label="Post review" busy={post.isPending} busyLabel="Posting" disabled={!ready} onPress={submit} />
        </View>
      </>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Review {first}</Text>
      <Text style={styles.sub}>{reviewSub(first)}</Text>
      {content}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    title: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    done: {
      padding: space.sm,
      borderRadius: radius.sm,
      overflow: "hidden",
      backgroundColor: colors.status.greenBg,
      fontFamily: font.family.medium,
      fontSize: 14,
      lineHeight: 20,
      color: colors.status.greenText,
    },
    axis: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
    axisLabel: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    stars: { flexDirection: "row", gap: 2 },
    star: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    pressed: { opacity: 0.7 },
    noteLabel: { marginTop: 4, fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    optional: { fontFamily: font.family.regular, fontSize: 13, color: colors.muted },
    input: {
      minHeight: 64,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      fontFamily: font.family.medium,
      fontSize: 15,
      lineHeight: 20,
      color: colors.ink,
      textAlignVertical: "top",
    },
    footer: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.md },
    hint: { flexShrink: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  });
