import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  Card,
  CreatorScreen,
  DeadlineNote,
  ErrorNote,
  KeyValue,
  Loading,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from "../../../components/creator/CreatorChrome";
import {
  useCreatorJob,
  useRequestExtension,
  useSendJobMessage,
  useSubmitWork,
} from "../../../features/creator/hooks";
import {
  pickDeliverables,
  uploadDeliverable,
  type PickedDeliverable,
} from "../../../features/creator/upload";
import {
  day,
  jobTitle,
  money,
  statusWords,
  type CreatorJob,
  type CreatorSubmissionFile,
} from "../../../features/creator/api";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";
import { friendlyError } from "../../../components/ErrorCard";
import { FocusRing } from "../../../components/ZaviTextField";

function errorText(e: unknown, fallback: string): string {
  return friendlyError(e, fallback);
}

function AgreedPanel({ job }: { job: CreatorJob }) {
  const styles = useStyles(makeStyles);
  const snapshot = job.brief ?? job.package;
  if (!snapshot) return null;
  const rows = Object.entries(snapshot).filter(
    ([, v]) => v !== null && v !== undefined && typeof v !== "object",
  );
  if (rows.length === 0) return null;
  return (
    <Card>
      <Text style={styles.h2}>What was agreed</Text>
      <Text style={styles.hint}>
        This is the version the business saved when the job started. It does not change under you.
      </Text>
      {rows.map(([k, v]) => (
        <KeyValue key={k} label={k.replace(/_/g, " ")} value={String(v)} />
      ))}
    </Card>
  );
}

function SubmitPanel({ job }: { job: CreatorJob }) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const submit = useSubmitWork();
  const [picked, setPicked] = useState<PickedDeliverable[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = job.status === "revision_requested";

  const pick = async () => {
    setError(null);
    const skipped: string[] = [];
    try {
      const files = await pickDeliverables((m) => skipped.push(m));
      if (files.length > 0) setPicked(files);
      if (skipped.length > 0) setError(skipped.join(" "));
    } catch (e) {
      setError(errorText(e, "Could not open your camera roll."));
    }
  };

  const send = async () => {
    if (picked.length === 0) {
      setError("Pick a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const uploaded: CreatorSubmissionFile[] = [];
      for (let i = 0; i < picked.length; i++) {
        setStatus(`Uploading ${i + 1} of ${picked.length}`);
        uploaded.push(
          await uploadDeliverable(job.id, picked[i], (fraction) =>
            setStatus(`Uploading ${i + 1} of ${picked.length}, ${Math.round(fraction * 100)}%`),
          ),
        );
      }
      setStatus("Sending to the business");
      await submit.mutateAsync({ orderId: job.id, files: uploaded, note: note.trim() });
      setPicked([]);
      setNote("");
    } catch (e) {
      setError(errorText(e, "That upload did not finish. Try again."));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  return (
    <Card>
      <Text style={styles.h2}>{revision ? "Send your new version" : "Send your draft"}</Text>
      {revision ? (
        <Text style={styles.hint}>
          The business asked for changes. Read the messages below, then send the new version here.
        </Text>
      ) : null}
      <SecondaryButton
        label={picked.length === 0 ? "Choose from your camera roll" : `Change the ${picked.length === 1 ? "file" : "files"}`}
        disabled={busy}
        onPress={() => void pick()}
      />
      {picked.map((p) => (
        <Text key={p.uri} style={styles.hint}>
          {p.name}
        </Text>
      ))}
      <FocusRing radius={radius.sm}>
        {(focus) => (
          <TextInput
            keyboardAppearance={keyboardAppearance}
            multiline
            value={note}
            onChangeText={setNote}
            placeholder="Anything the business should know. Optional."
            placeholderTextColor={colors.muted}
            selectionColor={textSelectionColor}
            cursorColor={colors.ink}
            selectionHandleColor={colors.ink}
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
            style={styles.input}
          />
        )}
      </FocusRing>
      <ErrorNote message={error} />
      <PrimaryButton
        label={busy ? (status ?? "Sending") : revision ? "Send new version" : "Send draft"}
        disabled={busy || picked.length === 0}
        onPress={() => void send()}
      />
    </Card>
  );
}

function ExtensionPanel({ job }: { job: CreatorJob }) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const request = useRequestExtension();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (job.extension_state === "requested") {
    return (
      <Card>
        <Text style={styles.hint}>
          You asked to move the date to {day(job.extension_requested_due_at)}. The new date only
          counts if the business agrees.
        </Text>
      </Card>
    );
  }
  if (job.extension_state === "declined") {
    return (
      <Card>
        <Text style={styles.hint}>
          The business kept the original date of {day(job.due_at)}.
        </Text>
      </Card>
    );
  }
  if (job.extension_state === "approved") return null;

  if (!open) {
    return <SecondaryButton label="Ask for more time" onPress={() => setOpen(true)} />;
  }

  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? `${date.trim()}T12:00:00.000Z` : null;

  return (
    <Card>
      <Text style={styles.h2}>Ask for more time</Text>
      <Text style={styles.hint}>
        You can ask once. The business decides, and the date only moves if they say yes.
      </Text>
      <FocusRing radius={radius.sm}>
        {(focus) => (
          <TextInput
            keyboardAppearance={keyboardAppearance}
            value={date}
            onChangeText={setDate}
            placeholder="New date, as 2026-10-01"
            placeholderTextColor={colors.muted}
            selectionColor={textSelectionColor}
            cursorColor={colors.ink}
            selectionHandleColor={colors.ink}
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
            style={styles.inputOneLine}
          />
        )}
      </FocusRing>
      <FocusRing radius={radius.sm}>
        {(focus) => (
          <TextInput
            keyboardAppearance={keyboardAppearance}
            multiline
            value={note}
            onChangeText={setNote}
            placeholder="Why, in a line."
            placeholderTextColor={colors.muted}
            selectionColor={textSelectionColor}
            cursorColor={colors.ink}
            selectionHandleColor={colors.ink}
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
            style={styles.input}
          />
        )}
      </FocusRing>
      <ErrorNote message={error} />
      <PrimaryButton
        label={request.isPending ? "Sending" : "Send the ask"}
        disabled={request.isPending}
        onPress={() => {
          if (!iso) {
            setError("Write the new date as 2026-10-01.");
            return;
          }
          setError(null);
          request.mutate(
            { orderId: job.id, requestedDueAt: iso, note: note.trim() },
            {
              onSuccess: () => setOpen(false),
              onError: (e) => setError(errorText(e, "That did not send. Try again.")),
            },
          );
        }}
      />
      <SecondaryButton label="Back" onPress={() => setOpen(false)} />
    </Card>
  );
}

function ThreadPanel({ job }: { job: CreatorJob }) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const send = useSendJobMessage();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const messages = job.thread ?? [];

  return (
    <Card>
      <Text style={styles.h2}>Messages</Text>
      {messages.length === 0 ? (
        <Text style={styles.hint}>
          Nothing yet. Sort out product, timing and anything else here.
        </Text>
      ) : (
        messages.map((m) => (
          <View
            key={m.id}
            style={[styles.bubble, m.sender_kind === "creator" ? styles.bubbleMine : null]}
          >
            <Text style={[styles.bubbleText, m.sender_kind === "creator" ? styles.bubbleTextMine : null]}>
              {m.body}
            </Text>
          </View>
        ))
      )}
      {job.has_thread ? (
        <>
          <FocusRing radius={radius.sm}>
            {(focus) => (
              <TextInput
                keyboardAppearance={keyboardAppearance}
                multiline
                value={body}
                onChangeText={setBody}
                placeholder="Write a message"
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                onFocus={focus.onFocus}
                onBlur={focus.onBlur}
                style={styles.input}
              />
            )}
          </FocusRing>
          <ErrorNote message={error} />
          <SecondaryButton
            label={send.isPending ? "Sending" : "Send"}
            disabled={send.isPending || !body.trim()}
            onPress={() => {
              setError(null);
              send.mutate(
                { orderId: job.id, body: body.trim() },
                {
                  onSuccess: () => setBody(""),
                  onError: (e) => setError(errorText(e, "That message did not send.")),
                },
              );
            }}
          />
        </>
      ) : null}
    </Card>
  );
}

export default function CreatorJobScreen() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const params = useLocalSearchParams<{ orderId?: string }>();
  const orderId = typeof params.orderId === "string" ? params.orderId : "";
  const { data: job, isPending, error } = useCreatorJob(orderId);

  if (error) {
    return (
      <CreatorScreen title="Job" back>
        <ErrorNote
          message={friendlyError(error, "That job did not load.")}
        />
        <SecondaryButton label="Back to your jobs" onPress={() => router.replace("/creator/jobs")} />
      </CreatorScreen>
    );
  }
  if (isPending || !job) {
    return (
      <CreatorScreen title="Job" back>
        <Loading what="this job" />
      </CreatorScreen>
    );
  }

  const canSend = job.status === "in_progress" || job.status === "revision_requested";
  const canAskForTime = job.status === "in_progress";

  return (
    <CreatorScreen title="Job" back>
      <Text style={styles.h1}>{jobTitle(job)}</Text>
      <Text style={styles.sub}>
        {statusWords(job.status)}, you receive {money(job.amount_cents)}
        {job.part_paid ? " (part payment after Zavi stepped in)" : ""}
      </Text>

      <DeadlineNote deadline={job.deadline} />
      <AgreedPanel job={job} />

      {job.submissions.length > 0 ? (
        <Card>
          <SectionTitle>What you have sent</SectionTitle>
          {job.submissions.map((s) => (
            <KeyValue
              key={s.id}
              label={`Version ${s.version}${s.note ? `: ${s.note}` : ""}`}
              value={day(s.created_at)}
            />
          ))}
        </Card>
      ) : null}

      {canSend ? <SubmitPanel job={job} /> : null}
      {canAskForTime ? <ExtensionPanel job={job} /> : null}
      <ThreadPanel job={job} />
    </CreatorScreen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  h1: { fontSize: font.size.title, fontWeight: "700", color: colors.ink },
  h2: { fontSize: font.size.base, fontWeight: "700", color: colors.ink },
  sub: { fontSize: font.size.md, color: colors.muted },
  hint: { fontSize: font.size.sm, lineHeight: 18, color: colors.muted },
  input: {
    fontFamily: font.family.medium,
    padding: space.md,
    fontSize: 15,
    color: colors.ink,
    minHeight: 64,
    textAlignVertical: "top",
  },
  inputOneLine: {
    fontFamily: font.family.medium,
    padding: space.md,
    fontSize: 15,
    color: colors.ink,
  },
  bubble: {
    backgroundColor: colors.soft,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  bubbleMine: { backgroundColor: colors.ink },
  bubbleText: { fontSize: font.size.md, lineHeight: 19, color: colors.ink },
  bubbleTextMine: { color: colors.onInk },
});
