import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { sourcesFootnote } from "../../features/agents/replyCards";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";

export function SourcesFootnote({ sources }: { sources: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const { summary, warning, detail } = sourcesFootnote(sources);
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        disabled={!detail}
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !detail }}
        style={styles.head}
      >
        {detail ? (
          <View style={open ? styles.chevronOpen : styles.chevronShut}>
            <Icon name="chevron" size={14} color={colors.muted} />
          </View>
        ) : null}
        <Text style={styles.text}>
          <Text style={styles.label}>Sources.</Text> {summary}
        </Text>
      </Pressable>
      {warning ? <Text style={styles.warning}>{warning}</Text> : null}
      {open && detail ? (
        <View style={styles.detail}>
          <Markdown body={detail} />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: space.md, gap: 4 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  chevronShut: { marginTop: 2, transform: [{ rotate: "-90deg" }] },
  chevronOpen: { marginTop: 2 },
  text: { flex: 1, fontSize: 12.5, lineHeight: 18, fontFamily: font.family.regular, color: colors.muted },
  label: { fontFamily: font.family.medium, color: colors.ink },
  warning: { fontSize: 12.5, lineHeight: 18, fontFamily: font.family.medium, color: colors.amber },
  detail: { paddingLeft: space.lg },
});
