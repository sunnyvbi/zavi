import { StyleSheet, View, type DimensionValue } from "react-native";
import { SkeletonBlock } from "./Skeleton";
import { radius, space } from "../theme/tokens";

const LINE_HEIGHT = 24;
const BAR_HEIGHT = 12;

function TextLine({ width, height = BAR_HEIGHT }: { width: DimensionValue; height?: number }) {
  return (
    <View style={styles.line}>
      <SkeletonBlock width={width} height={height} radius={height / 2} />
    </View>
  );
}

function UserBubble({ width, lines = 1 }: { width: DimensionValue; lines?: number }) {
  return (
    <View style={styles.userRow}>
      <SkeletonBlock width={width} height={LINE_HEIGHT * lines + 20} radius={radius.lg + 3} />
    </View>
  );
}

function Paragraph({ lines }: { lines: DimensionValue[] }) {
  return (
    <View style={styles.paragraph}>
      {lines.map((width, i) => (
        <TextLine key={i} width={width} />
      ))}
    </View>
  );
}

function Heading({ width }: { width: DimensionValue }) {
  return (
    <View style={styles.heading}>
      <TextLine width={width} height={16} />
    </View>
  );
}

function Bullets({ widths }: { widths: DimensionValue[] }) {
  return (
    <>
      {widths.map((width, i) => (
        <View key={i} style={styles.bulletRow}>
          <View style={styles.dot}>
            <SkeletonBlock width={BAR_HEIGHT} height={BAR_HEIGHT} radius={BAR_HEIGHT / 2} />
          </View>
          <View style={styles.bulletText}>
            <TextLine width={width} />
          </View>
        </View>
      ))}
    </>
  );
}

export function ChatSkeleton({ paddingTop }: { paddingTop: number }) {
  return (
    <View style={[styles.list, { paddingTop }]}>
      <UserBubble width="58%" />
      <View style={styles.assistant}>
        <Paragraph lines={["100%", "96%", "78%"]} />
        <Heading width="48%" />
        <Bullets widths={["88%", "72%", "80%"]} />
        <Paragraph lines={["100%", "58%"]} />
      </View>
      <UserBubble width="72%" lines={2} />
      <View style={styles.assistant}>
        <Paragraph lines={["100%", "92%", "100%", "64%"]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, justifyContent: "flex-end", overflow: "hidden", paddingHorizontal: space.lg, paddingVertical: space.md },
  userRow: { width: "100%", marginVertical: space.sm, flexDirection: "row", justifyContent: "flex-end" },
  assistant: { width: "100%", marginTop: space.md, marginBottom: space.lg },
  line: { height: LINE_HEIGHT, justifyContent: "center" },
  paragraph: { marginTop: space.md },
  heading: { marginTop: space.lg },
  bulletRow: { flexDirection: "row", marginTop: space.sm },
  dot: { width: 24, height: LINE_HEIGHT, justifyContent: "center" },
  bulletText: { flex: 1 },
});
