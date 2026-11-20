import { StyleSheet, View } from "react-native";
import { streamDraftPreview } from "../features/agents/streamDraftPreview";
import { space, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";
import { Markdown } from "./Markdown";

export function StreamDraftBubble({ text }: { text: string }) {
  const styles = useStyles(makeStyles);
  const body = streamDraftPreview(text);

  if (!body) return null;

  return (
    <View style={styles.assistant} accessibilityRole="text">
      <Markdown body={body} />
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    assistant: {
      width: "100%",
      marginTop: space.md,
      marginBottom: space.lg,
    },
  });
