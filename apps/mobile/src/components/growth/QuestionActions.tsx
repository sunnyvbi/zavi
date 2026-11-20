import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAnswerQuestion } from "../../features/growth/hooks";
import { ANSWER_ERROR, answerButtons, type Answer, type Answered, type WaitingQuestion } from "../../features/growth/needs";
import { serverMessage } from "../../features/growth/goalForm";
import { space } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { ActionButton, ErrorLine } from "./StoryKit";

export function QuestionActions({ question, onAnswered }: { question: WaitingQuestion; onAnswered: (id: string, a: Answered) => void }) {
  const styles = useStyles(makeStyles);
  const send = useAnswerQuestion();
  const [which, setWhich] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const busy = send.isPending;

  const answer = async (a: Answer) => {
    if (sending.current) return;
    sending.current = true;
    setWhich(a);
    setError(null);
    try {
      onAnswered(question.id, await send.mutateAsync({ id: question.id, answer: a }));
    } catch (e) {
      setError(serverMessage(e as { code?: string; message?: string }, ANSWER_ERROR));
    } finally {
      sending.current = false;
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {answerButtons(question).map((b) => (
          <ActionButton
            key={b.answer}
            label={b.label}
            variant={b.primary ? "primary" : "secondary"}
            busy={busy && which === b.answer}
            busyLabel="Sending…"
            disabled={busy}
            grow
            onPress={() => void answer(b.answer)}
          />
        ))}
      </View>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    wrap: { marginTop: space.sm, gap: space.sm },
    row: { flexDirection: "row", gap: space.md },
  });
