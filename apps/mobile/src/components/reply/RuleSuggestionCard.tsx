import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiJson } from "../../lib/api";
import { space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { Card, CardButton, ErrorLine, errorText, makeUi } from "./ui";

export type RuleSuggestionModel = { rule_id: string; text: string };

export function RuleSuggestionCard({ model }: { model: RuleSuggestionModel }) {
  const styles = useStyles(makeStyles);
  const [phase, setPhase] = useState<"pending" | "busy" | "saved" | "dismissed" | "gone">("pending");
  const [error, setError] = useState<string | null>(null);

  const act = async (verb: "activate" | "dismiss") => {
    setPhase("busy");
    setError(null);
    try {
      const r = await apiJson<{ status?: string }>(`/api/rules/${model.rule_id}/${verb}`, { method: "POST" });
      setPhase(r.status === "not_pending" ? "gone" : verb === "activate" ? "saved" : "dismissed");
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
      setPhase("pending");
    }
  };

  if (phase === "saved" || phase === "dismissed" || phase === "gone") {
    return (
      <Card>
        <Text style={styles.muted}>
          {phase === "saved"
            ? "Saved as a rule. Your agents follow it from their next run."
            : phase === "dismissed"
              ? "Okay, not a rule."
              : "This suggestion was already handled."}
        </Text>
      </Card>
    );
  }
  return (
    <Card>
      <Text style={styles.label}>Keep this as a rule?</Text>
      <Text style={styles.quote}>“{model.text}”</Text>
      <View style={styles.row}>
        <CardButton label="Save rule" onPress={() => void act("activate")} busy={phase === "busy"} />
        <CardButton label="Not a rule" variant="plain" onPress={() => void act("dismiss")} disabled={phase === "busy"} />
      </View>
      <ErrorLine message={error} />
    </Card>
  );
}

const makeStyles = (colors: Colors) => {
  const ui = makeUi(colors);
  return StyleSheet.create({
    label: ui.muted,
    quote: { ...ui.body, marginTop: space.xs },
    muted: ui.muted,
    row: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  });
};
