import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useDecideMove } from "../../features/growth/hooks";
import { MOVE_ERROR, SHIP_RED_CONFIRM, type MoveAction } from "../../features/growth/moves";
import { track } from "../../lib/analytics";
import { space } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { ConfirmDialog } from "../ConfirmDialog";
import { ActionButton, ErrorLine } from "./StoryKit";

export function MoveActions({ decisionId }: { decisionId: string }) {
  const styles = useStyles(makeStyles);
  const decide = useDecideMove();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [which, setWhich] = useState<MoveAction | null>(null);
  const busy = decide.isPending;

  const send = async (action: MoveAction, shipAnyway = false) => {
    if (decide.isPending) return;
    setWhich(action);
    setError(null);
    try {
      const result = await decide.mutateAsync({ id: decisionId, action, shipAnyway });
      if (result === "needs_confirm") setAsking(true);
      else track("growth_move_decided", { decision: action });
    } catch {
      setError(MOVE_ERROR[action]);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <ActionButton
          label="Approve"
          busy={busy && which === "approve"}
          busyLabel="Approving…"
          disabled={busy}
          grow
          onPress={() => void send("approve")}
        />
        <ActionButton label="Not now" variant="secondary" disabled={busy} grow onPress={() => void send("reject")} />
      </View>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <ConfirmDialog
        visible={asking}
        icon="alertCircle"
        title="Open the PR anyway?"
        message={SHIP_RED_CONFIRM}
        cancelLabel="Cancel"
        confirmLabel="Open the PR"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void send("approve", true);
        }}
      />
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    wrap: { marginTop: space.sm, gap: space.sm },
    row: { flexDirection: "row", gap: space.md },
  });
