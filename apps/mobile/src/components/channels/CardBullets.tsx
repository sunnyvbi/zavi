import { StyleSheet, Text, View } from "react-native";
import type { CardCopy } from "../../features/channels/cardCopy";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

function Bullets({ title, lines, more = 0, quiet, clamp }: { title?: string; lines: string[]; more?: number; quiet?: boolean; clamp?: boolean }) {
  const styles = useStyles(makeStyles);
  if (!lines.length) return null;
  return (
    <View style={styles.block}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {lines.map((l, i) => (
        <View key={i} style={styles.row}>
          <Text style={[styles.dot, quiet && styles.quiet]}>{"•"}</Text>
          <Text style={[styles.text, quiet && styles.quiet]} numberOfLines={clamp ? 2 : undefined}>
            {l}
          </Text>
        </View>
      ))}
      {more > 0 ? <Text style={styles.more}>{`and ${more} more`}</Text> : null}
    </View>
  );
}

const COMPACT_WHY = 1;
const COMPACT_STEPS = 2;

export function CardBullets({ copy, executable, compact }: { copy: CardCopy; executable: boolean; compact?: boolean }) {
  const why = compact ? copy.why.slice(0, COMPACT_WHY) : copy.why;
  const steps = compact ? copy.steps.slice(0, COMPACT_STEPS) : copy.steps;
  const more = copy.moreSteps + (copy.steps.length - steps.length);
  return (
    <>
      <Bullets lines={why} quiet clamp={compact} />
      <Bullets title={executable ? "What Zavi will do" : "How to do this"} lines={steps} more={more} clamp={compact} />
      {compact ? null : <Bullets title="What you get" lines={copy.gain} />}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    block: { gap: 4, marginTop: space.xs },
    title: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    row: { flexDirection: "row", gap: space.sm },
    dot: { width: 10, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    text: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    quiet: { color: colors.textSecondary },
    more: { fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
  });
