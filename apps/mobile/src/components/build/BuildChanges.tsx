import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ZaviTextField } from "../ZaviTextField";
import { CardButton } from "../reply/ui";
import { StatusSpinner } from "../channels/ChannelStates";
import { CreditWallNotice } from "../CreditWallNotice";
import { ErrorCard } from "../ErrorCard";
import { BuildRating } from "./BuildRating";
import { sendChange } from "../../features/build/api";
import { buildKeys } from "../../features/build/hooks";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { canRateRefine, type SavedRating } from "../../features/build/feedback";
import { track } from "../../lib/analytics";
import {
  CHANGE_MAX_CHARS,
  buildCreditWall,
  buildErrorMessage,
  isRefineBusy,
  refineRow,
  validateChange,
  type BuildRefine,
} from "../../features/build/logic";
import type { CreditWall } from "../../features/agents/creditWall";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function BuildChanges({
  runId,
  refines,
  refinesLoading,
  refinesFailed,
  ratings,
}: {
  runId: string;
  refines: BuildRefine[];
  refinesLoading: boolean;
  refinesFailed: boolean;
  ratings: Record<string, SavedRating>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wall, setWall] = useState<CreditWall | null>(null);
  const inFlight = useRef(false);

  const busy = isRefineBusy(refines);
  const check = validateChange(draft);
  const canSend = check.ok && !sending && !busy;

  async function onSend() {
    if (inFlight.current || !canSend) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    setWall(null);
    try {
      await sendChange(runId, draft);
      track("build_change_requested");
      setDraft("");
      void qc.invalidateQueries({ queryKey: buildKeys.refines(tenant, runId) });
      void qc.invalidateQueries({ queryKey: buildKeys.sessions(tenant) });
    } catch (e) {
      const w = buildCreditWall(e, "change");
      if (w) setWall(w);
      else setError(buildErrorMessage(e, "Couldn't start the change. Please try again."));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const hint = busy
    ? "Zavi is still working on the last change. You can send the next one when it lands."
    : draft.trim().length > 0 && !check.ok
      ? check.reason
      : null;

  return (
    <View>
      <ZaviTextField
        value={draft}
        onChangeText={(t) => {
          setDraft(t);
          setError(null);
        }}
        minLines={3}
        maxLines={6}
        maxLength={CHANGE_MAX_CHARS}
        placeholder="Describe an update to your app"
        editable={!sending}
        accessibilityLabel="Describe an update to your app"
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {wall ? (
        <View style={styles.wall}>
          <CreditWallNotice wall={wall} onDismiss={() => setWall(null)} />
        </View>
      ) : null}
      {error ? <ErrorCard message={error} /> : null}
      <View style={styles.send}>
        <CardButton
          label={sending ? "Sending" : "Send update"}
          busy={sending}
          disabled={!canSend}
          onPress={() => void onSend()}
        />
      </View>

      {refinesLoading ? (
        <Text style={styles.muted}>Loading changes…</Text>
      ) : refinesFailed ? (
        <Text style={styles.muted}>Couldn't load earlier changes.</Text>
      ) : refines.length === 0 ? (
        <Text style={styles.muted}>No changes yet.</Text>
      ) : (
        <View style={styles.feed}>
          {refines.map((r) => {
            const v = refineRow(r);
            return (
              <View key={v.id} style={styles.item} accessibilityLabel={`${v.message}. ${v.status}`}>
                <Text style={styles.itemMessage}>{v.message}</Text>
                <View style={styles.itemStatus}>
                  {v.tone === "busy" ? <StatusSpinner size={11} /> : null}
                  <Text
                    style={[
                      styles.itemStatusText,
                      v.tone === "ok" && { color: colors.green },
                      v.tone === "error" && { color: colors.red },
                    ]}
                  >
                    {v.status}
                  </Text>
                </View>
                {v.detail ? <Text style={styles.itemDetail}>{v.detail}</Text> : null}
                {canRateRefine(r) ? <BuildRating runId={r.id} label="change" saved={ratings[r.id] ?? null} /> : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  hint: {
    marginTop: space.xs,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  wall: { marginHorizontal: -space.md },
  send: { flexDirection: "row", marginTop: space.md },
  muted: {
    marginTop: space.lg,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    includeFontPadding: false,
    color: colors.muted,
  },
  feed: { marginTop: space.lg, gap: space.sm },
  item: {
    padding: space.md,
    gap: space.xs,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
  },
  itemMessage: { fontFamily: font.family.medium, fontSize: font.size.base, lineHeight: 19, includeFontPadding: false, color: colors.ink },
  itemStatus: { flexDirection: "row", alignItems: "center", gap: space.xs },
  itemStatusText: { fontFamily: font.family.semi, fontSize: font.size.sm, includeFontPadding: false, color: colors.muted },
  itemDetail: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 17, includeFontPadding: false, color: colors.muted },
});
