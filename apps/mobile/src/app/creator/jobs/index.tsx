import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  CreatorScreen,
  Empty,
  ErrorNote,
  Loading,
} from "../../../components/creator/CreatorChrome";
import { useCreatorJobs } from "../../../features/creator/hooks";
import {
  CreatorApiError,
  day,
  jobTitle,
  money,
  statusWords,
  type CreatorJob,
} from "../../../features/creator/api";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles } from "../../../theme/theme";

function JobRow({ job }: { job: CreatorJob }) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/creator/jobs/${job.id}`)}
      style={styles.row}
    >
      <View style={styles.rowHead}>
        <Text style={styles.rowTitle}>{jobTitle(job)}</Text>
        <Text style={styles.rowStatus}>{statusWords(job.status)}</Text>
      </View>
      <Text style={styles.rowMeta}>
        You receive {money(job.amount_cents)}
        {job.due_at ? `, due ${day(job.due_at)}` : ""}
      </Text>
      {job.deadline ? <Text style={styles.rowDeadline}>{job.deadline.line}</Text> : null}
    </Pressable>
  );
}

export default function CreatorJobsScreen() {
  const styles = useStyles(makeStyles);
  const [scope, setScope] = useState<"active" | "all">("active");
  const { data, isPending, error } = useCreatorJobs(scope);

  return (
    <CreatorScreen title="Jobs">
      <View style={styles.chips}>
        {(["active", "all"] as const).map((s) => (
          <Pressable
            key={s}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === s }}
            onPress={() => setScope(s)}
            style={[styles.chip, scope === s ? styles.chipOn : null]}
          >
            <Text style={[styles.chipText, scope === s ? styles.chipTextOn : null]}>
              {s === "active" ? "Running" : "Everything"}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <ErrorNote
          message={error instanceof CreatorApiError ? error.message : "Your jobs did not load."}
        />
      ) : isPending || !data ? (
        <Loading what="your jobs" />
      ) : data.jobs.length === 0 ? (
        <Empty>
          {scope === "active"
            ? "No jobs running. Anything waiting on you is in your Inbox."
            : "No jobs yet."}
        </Empty>
      ) : (
        <>
          {data.jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
          <Text style={styles.hint}>{data.order}.</Text>
        </>
      )}
    </CreatorScreen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  chips: { flexDirection: "row", gap: space.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm - 2,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: font.size.md, color: colors.muted, fontWeight: "700" },
  chipTextOn: { color: colors.onInk },
  row: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.xs,
    backgroundColor: colors.panel,
  },
  rowHead: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
  rowTitle: { fontSize: font.size.base, fontWeight: "700", color: colors.ink, flexShrink: 1 },
  rowStatus: { fontSize: font.size.sm, color: colors.muted },
  rowMeta: { fontSize: font.size.md, color: colors.muted },
  rowDeadline: { fontSize: font.size.sm, lineHeight: 17, color: colors.muted },
  hint: { fontSize: font.size.sm, color: colors.muted },
});
