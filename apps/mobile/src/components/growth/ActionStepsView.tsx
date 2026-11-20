import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { actionSteps, type DoStep } from "../../features/growth/actionSteps";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { TextLink } from "./StoryKit";

function Step({ step }: { step: DoStep }) {
  const styles = useStyles(makeStyles);
  if ("text" in step) return <Text style={styles.text}>{step.text}</Text>;
  return (
    <View style={styles.pathRow}>
      {step.prefix ? <Text style={styles.text}>{step.prefix}</Text> : null}
      {step.path.map((seg, i) => (
        <View key={i} style={styles.pathPart}>
          {i > 0 ? <Text style={styles.sep}>›</Text> : null}
          <Text style={styles.seg}>{seg}</Text>
        </View>
      ))}
    </View>
  );
}

function Box({ label, children }: { label: string; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.box}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <View style={styles.boxBody}>{children}</View>
    </View>
  );
}

export function ActionStepsView({ text }: { text: string | null | undefined }) {
  const styles = useStyles(makeStyles);
  const [whyOpen, setWhyOpen] = useState(false);
  const steps = actionSteps(text);
  if (steps.kind === "plain") {
    if (steps.lines.length === 0) return null;
    return (
      <View style={styles.plain}>
        {steps.lines.map((line, i) => (
          <Text key={i} style={styles.text}>
            {line}
          </Text>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.wrap}>
      <Box label="Do">
        {steps.do.map((s, i) => (
          <Step key={i} step={s} />
        ))}
        {}
        {steps.notes.map((s, i) => (
          <Text key={`n${i}`} style={[styles.text, styles.note]}>
            {`Note: ${s}`}
          </Text>
        ))}
      </Box>
      {steps.check.length > 0 ? (
        <Box label="Check">
          {steps.check.map((s, i) => (
            <Text key={i} style={styles.text}>
              {s}
            </Text>
          ))}
        </Box>
      ) : null}
      {steps.dont.length > 0 ? (
        <Box label="Don't">
          {steps.dont.map((s, i) => (
            <Text key={i} style={styles.text}>
              {s}
            </Text>
          ))}
        </Box>
      ) : null}
      {steps.why.length > 0 ? (
        <View style={styles.whyWrap}>
          <TextLink label="Why this matters" expanded={whyOpen} onPress={() => setWhyOpen((v) => !v)} />
          {whyOpen
            ? steps.why.map((s, i) => (
                <Text key={i} style={[styles.text, styles.muted]}>
                  {s}
                </Text>
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.sm },
    plain: { gap: 4 },
    box: { gap: 6, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    boxBody: { gap: 6 },
    label: { fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.6, color: colors.muted },
    text: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    note: { fontFamily: font.family.medium },
    muted: { color: colors.muted },
    pathRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
    pathPart: { flexDirection: "row", alignItems: "center", gap: 4 },
    sep: { color: colors.muted, fontSize: 13 },
    seg: { overflow: "hidden", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.soft, fontFamily: font.family.medium, fontSize: 12, color: colors.ink },
    whyWrap: { gap: 4, alignItems: "flex-start" },
  });
