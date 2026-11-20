import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { ZaviTextField } from "../ZaviTextField";
import { CardButton } from "../reply/ui";
import { rateBuild } from "../../features/build/api";
import { track } from "../../lib/analytics";
import {
  BUILD_REASON_OPTIONS,
  RATING_REASON_PLACEHOLDER,
  RATING_SAVE_FAILED,
  REASON_MAX,
  thanksLine,
  toggleReason,
  type BuildRatingValue,
  type BuildReasonId,
  type SavedRating,
} from "../../features/build/feedback";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function BuildRating({
  runId,
  label,
  saved,
}: {
  runId: string;
  label: "build" | "change";
  saved: SavedRating | null;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [rating, setRating] = useState<BuildRatingValue | null>(null);
  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState<BuildReasonId[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const last = useRef<SavedRating>({ rating: null, comment: null, reasons: [] });
  const touched = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (touched.current || !saved?.rating) return;
    last.current = saved;
    setRating(saved.rating);
  }, [saved]);

  async function rate(next: BuildRatingValue) {
    if (inFlight.current) return;
    if (next === rating) {
      if (next === -1 && !asking) {
        setThanks(null);
        setError(null);
        setPicked(last.current.reasons);
        setNote(last.current.comment ?? "");
        setAsking(true);
      }
      return;
    }
    inFlight.current = true;
    touched.current = true;
    const before = rating;
    setRating(next);
    setError(null);
    setThanks(null);
    setAsking(next === -1);
    setPicked([]);
    if (next === 1) setNote("");
    setBusy(true);
    const comment = next === -1 ? note.trim().slice(0, REASON_MAX) || null : null;
    try {
      await rateBuild(runId, next, comment, []);
      track("build_rated", { rating: next });
      last.current = { rating: next, comment, reasons: [] };
    } catch {
      setRating(before);
      setAsking(false);
      setError(RATING_SAVE_FAILED);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function send() {
    const text = note.trim().slice(0, REASON_MAX);
    if ((!text && picked.length === 0) || inFlight.current) return;
    inFlight.current = true;
    const reasons = picked;
    setBusy(true);
    setError(null);
    try {
      const { carryover } = await rateBuild(runId, -1, text || null, reasons);
      track("build_rated", { rating: -1 });
      last.current = { rating: -1, comment: text || null, reasons };
      setAsking(false);
      setThanks(thanksLine(reasons, carryover));
    } catch {
      setError(RATING_SAVE_FAILED);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const what = label === "build" ? "this build" : "this change";
  return (
    <View>
      <View style={styles.row}>
        <Pressable
          onPress={() => void rate(1)}
          disabled={busy}
          hitSlop={8}
          style={[styles.thumb, rating === 1 && styles.thumbOn]}
          accessibilityRole="button"
          accessibilityLabel={`Good ${label}`}
          accessibilityState={{ selected: rating === 1, disabled: busy }}
        >
          <Icon name="thumb" size={18} color={rating === 1 ? colors.ink : colors.muted} />
        </Pressable>
        <Pressable
          onPress={() => void rate(-1)}
          disabled={busy}
          hitSlop={8}
          style={[styles.thumb, rating === -1 && styles.thumbOn]}
          accessibilityRole="button"
          accessibilityLabel={`Bad ${label}`}
          accessibilityState={{ selected: rating === -1, disabled: busy }}
        >
          <View style={styles.flipped}>
            <Icon name="thumb" size={18} color={rating === -1 ? colors.ink : colors.muted} />
          </View>
        </Pressable>
        {thanks && !asking ? (
          <Text style={styles.thanks} accessibilityLiveRegion="polite">
            {thanks}
          </Text>
        ) : null}
      </View>

      {asking ? (
        <View style={styles.form}>
          <View style={styles.chips} accessibilityLabel="What was off (pick any)">
            {BUILD_REASON_OPTIONS.map((o) => {
              const on = picked.includes(o.id);
              return (
                <Pressable
                  key={o.id}
                  onPress={() => setPicked((cur) => toggleReason(cur, o.id))}
                  disabled={busy}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: busy }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <ZaviTextField
            value={note}
            onChangeText={setNote}
            maxLines={3}
            maxLength={REASON_MAX}
            placeholder={RATING_REASON_PLACEHOLDER}
            editable={!busy}
            accessibilityLabel={`What was off with ${what}?`}
          />
          <View style={styles.actions}>
            <CardButton
              label="Send"
              busy={busy}
              disabled={!note.trim() && picked.length === 0}
              onPress={() => void send()}
            />
            <CardButton label="Skip" variant="plain" onPress={() => setAsking(false)} />
          </View>
        </View>
      ) : null}

      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  thumb: { width: 32, height: 32, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  thumbOn: { backgroundColor: colors.soft },
  flipped: { transform: [{ rotate: "180deg" }] },
  thanks: {
    flexShrink: 1,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    includeFontPadding: false,
    color: colors.muted,
  },
  form: { marginTop: space.sm, gap: space.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: font.family.medium, fontSize: font.size.sm, includeFontPadding: false, color: colors.muted },
  chipTextOn: { color: colors.onInk },
  actions: { flexDirection: "row", gap: space.sm },
  error: {
    marginTop: space.xs,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    includeFontPadding: false,
    color: colors.red,
  },
});
