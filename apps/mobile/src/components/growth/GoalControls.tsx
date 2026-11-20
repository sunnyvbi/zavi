import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  ACCEPT_ERROR,
  ACCEPT_GONE,
  DELETE_CONFIRM,
  DELETE_ERROR,
  REORDER_ERROR,
  reorderWrites,
  serverMessage,
} from "../../features/growth/goalForm";
import { useAcceptGoal, useDeleteGoal, useReorderGoals } from "../../features/growth/hooks";
import type { GrowthGoal } from "../../features/growth/plan";
import { track } from "../../lib/analytics";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { ConfirmDialog } from "../ConfirmDialog";
import { Icon } from "../Icon";
import { ActionButton, ErrorLine, Eyebrow } from "./StoryKit";

type Failure = { status?: number; code?: string; message?: string };

export function useGoalWrites(goals: GrowthGoal[]) {
  const reorder = useReorderGoals();
  const del = useDeleteGoal();
  const accept = useAcceptGoal();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<GrowthGoal | null>(null);
  const busy = reorder.isPending || del.isPending || accept.isPending;

  const move = async (index: number, by: -1 | 1) => {
    if (busy) return;
    const writes = reorderWrites(goals, index, by);
    if (!writes || writes.length === 0) return;
    setError(null);
    try {
      await reorder.mutateAsync(writes);
    } catch {
      setError(REORDER_ERROR);
    }
  };
  const remove = async () => {
    const goal = deleting;
    setDeleting(null);
    if (!goal || busy) return;
    setError(null);
    try {
      await del.mutateAsync(goal.id);
    } catch (e) {
      setError(serverMessage(e as Failure, DELETE_ERROR));
    }
  };
  const take = async (goal: GrowthGoal) => {
    if (busy) return;
    setError(null);
    try {
      await accept.mutateAsync(goal.id);
      track("growth_goal_accepted");
    } catch (e) {
      setError((e as Failure).status === 404 ? ACCEPT_GONE : ACCEPT_ERROR);
    }
  };
  return { busy, error, deleting, setDeleting, move, remove, take, accepting: accept.isPending };
}

export function GoalRowControls({
  goal,
  index,
  count,
  noNumber,
  busy,
  onMove,
  onEdit,
  onDelete,
}: {
  goal: GrowthGoal;
  index: number;
  count: number;
  noNumber: boolean;
  busy: boolean;
  onMove: (index: number, by: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const reorderable = count > 1;
  return (
    <View style={styles.row}>
      {reorderable ? (
        <>
          <IconButton label={`Move ${goal.objective} up`} disabled={index === 0 || busy} onPress={() => onMove(index, -1)}>
            <View style={{ transform: [{ rotate: "180deg" }] }}>
              <Icon name="chevron" size={20} color={colors.ink} />
            </View>
          </IconButton>
          <IconButton label={`Move ${goal.objective} down`} disabled={index === count - 1 || busy} onPress={() => onMove(index, 1)}>
            <Icon name="chevron" size={20} color={colors.ink} />
          </IconButton>
        </>
      ) : null}
      <Pressable
        onPress={onEdit}
        disabled={busy}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed, busy && styles.off]}
        accessibilityRole="button"
        accessibilityLabel={`${noNumber ? "Enter today's number for" : "Edit"} ${goal.objective}`}
      >
        {!noNumber ? <Icon name="pencil" size={14} color={colors.ink} /> : null}
        <Text style={styles.pillText}>{noNumber ? "Enter today's number" : "Edit"}</Text>
      </Pressable>
      <View style={styles.spacer} />
      <IconButton label={`Delete ${goal.objective}`} disabled={busy} onPress={onDelete}>
        <Icon name="trash" size={16} color={colors.muted} />
      </IconButton>
    </View>
  );
}

function IconButton({ label, disabled, onPress, children }: { label: string; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [styles.icon, pressed && !disabled && styles.pressed, disabled && styles.off]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
    >
      {children}
    </Pressable>
  );
}

export function AddGoalRow({
  suggestions,
  busy,
  onCreate,
}: {
  suggestions: string[];
  busy: boolean;
  onCreate: (objective?: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.addRow}>
      <Pressable
        onPress={busy ? undefined : () => onCreate()}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed, busy && styles.off]}
        accessibilityRole="button"
        accessibilityLabel="Add a goal"
      >
        <Icon name="plus" size={14} color={colors.ink} />
        <Text style={styles.pillText}>Add a goal</Text>
      </Pressable>
      {suggestions.map((s) => (
        <Pressable
          key={s}
          onPress={busy ? undefined : () => onCreate(s)}
          style={({ pressed }) => [styles.chip, pressed && styles.pressed, busy && styles.off]}
          accessibilityRole="button"
          accessibilityLabel={s}
        >
          <Icon name="plus" size={12} color={colors.textSecondary} />
          <Text style={styles.chipText}>{s}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SuggestedGoalCard({ goal, busy, accepting, onAccept }: { goal: GrowthGoal; busy: boolean; accepting: boolean; onAccept: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.suggested}>
      <Eyebrow>Suggested next goal</Eyebrow>
      <Text style={styles.suggestedText}>{goal.objective}</Text>
      <ActionButton label="Make it a goal" busy={accepting} busyLabel="Adding…" disabled={busy && !accepting} onPress={onAccept} />
    </View>
  );
}

export function GoalWriteDialogs({ writes }: { writes: ReturnType<typeof useGoalWrites> }) {
  const styles = useStyles(makeStyles);
  return (
    <>
      {writes.error ? (
        <View style={styles.error}>
          <ErrorLine>{writes.error}</ErrorLine>
        </View>
      ) : null}
      <ConfirmDialog
        visible={writes.deleting !== null}
        icon="trash"
        title="Delete this goal?"
        message={DELETE_CONFIRM.replace("Delete this goal? ", "")}
        cancelLabel="Cancel"
        confirmLabel="Delete"
        destructive
        onCancel={() => writes.setDeleting(null)}
        onConfirm={() => void writes.remove()}
      />
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.sm },
    spacer: { flex: 1 },
    icon: { width: 40, height: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
    pill: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.line,
      paddingHorizontal: 14,
    },
    pillText: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 17, includeFontPadding: false, color: colors.ink },
    pressed: { opacity: 0.7 },
    off: { opacity: 0.4 },
    addRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
    chip: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.line,
      paddingHorizontal: 12,
    },
    chipText: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 17, includeFontPadding: false, color: colors.textSecondary },
    suggested: { marginTop: space.lg, borderRadius: radius.md, borderWidth: 1, borderStyle: "dashed", borderColor: colors.line, padding: space.md, gap: space.sm },
    suggestedText: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.ink },
    error: { marginTop: space.sm },
  });
