import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  agentName,
  type DispatchProposal,
  type EnvelopeOutline,
} from "../../features/agents/replyCards";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { Card, makeUi } from "./ui";

export function EnvelopeCard({ outline }: { outline: EnvelopeOutline }) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <Card style={styles.envelope}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.head}
      >
        <Text style={[ui.title, styles.flex]} numberOfLines={open ? undefined : 2}>
          {outline.title}
        </Text>
        <View style={open ? styles.chevronOpen : null}>
          <Icon name="chevron" size={18} color={colors.muted} />
        </View>
      </Pressable>
      {open && outline.markdown ? <Markdown body={outline.markdown} /> : null}
    </Card>
  );
}

export function ProposalCards({ proposals }: { proposals: DispatchProposal[] }) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  return (
    <View style={styles.proposals}>
      {proposals.map((p, i) => (
        <Card key={`${p.agent_slug}-${i}`} style={styles.proposal}>
          <Text style={styles.kicker}>
            DISPATCH PROPOSAL · <Text style={styles.agent}>{agentName(p.agent_slug)}</Text>
          </Text>
          <Text style={ui.body}>
            <Text style={styles.bold}>Brief: </Text>
            {p.brief}
          </Text>
          <Text style={ui.small}>
            <Text style={styles.bold}>Why: </Text>
            {p.why}
          </Text>
        </Card>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  envelope: { gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  flex: { flex: 1 },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  proposals: { marginTop: space.sm },
  proposal: { marginTop: space.sm, padding: 14, gap: 6, borderRadius: radius.md },
  kicker: { fontSize: 10.5, letterSpacing: 1.2, fontFamily: font.family.medium, color: colors.muted },
  agent: { fontSize: font.size.md, letterSpacing: 0, fontFamily: font.family.semi, color: colors.ink },
  bold: { fontFamily: font.family.semi },
});
