import { useState } from "react";
import { Clipboard, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "./Icon";
import { apiJson } from "../lib/api";
import { space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

type Rating = 1 | -1 | null;

export function MessageActions({ body, runId }: { body: string; runId: string | null }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [rating, setRating] = useState<Rating>(null);
  const [copied, setCopied] = useState(false);

  function onCopy() {
    Clipboard.setString(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function onRate(next: 1 | -1) {
    if (!runId) return;
    const previous = rating;
    const value: Rating = rating === next ? null : next;
    setRating(value);
    void apiJson("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ target_type: "agent_run", target_id: runId, rating: value }),
    }).catch(() => setRating(previous));
  }

  return (
    <View style={styles.row}>
      <Pressable onPress={onCopy} hitSlop={8} style={styles.btn} accessibilityLabel="Copy reply">
        <Icon name={copied ? "check" : "copy"} size={19} color={colors.muted} />
      </Pressable>
      {runId ? (
        <>
          <Pressable
            onPress={() => onRate(1)}
            hitSlop={8}
            style={[styles.btn, rating === 1 && styles.btnOn]}
            accessibilityLabel="Good reply"
          >
            <Icon name="thumb" size={19} color={rating === 1 ? colors.ink : colors.muted} />
          </Pressable>
          <Pressable
            onPress={() => onRate(-1)}
            hitSlop={8}
            style={[styles.btn, rating === -1 && styles.btnOn]}
            accessibilityLabel="Bad reply"
          >
            <View style={styles.flipped}>
              <Icon name="thumb" size={19} color={rating === -1 ? colors.ink : colors.muted} />
            </View>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: space.sm },
  btn: { width: 26, height: 29, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  btnOn: { backgroundColor: colors.soft },
  flipped: { transform: [{ rotate: "180deg" }] },
});
