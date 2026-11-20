import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useCompanyFacts } from "../../features/settings/api";
import { useConnections } from "../../features/connectors/useConnections";
import { useComposioToolkits } from "../../features/connectors/composioApps";
import { useSetup } from "../../features/setup/SetupProvider";
import { connectedNames } from "../../features/setup/connectors";
import { namesOf, summarizeReads } from "../../features/setup/imports";
import { cookingView } from "../../features/setup/state";
import * as copy from "../../features/setup/copy";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

const COOK_FROM = "#ffc93d";
const COOK_TO = "#7fb6f5";

export function SetupKnowsCard() {
  const styles = useStyles(makeStyles);
  const setup = useSetup();
  const facts = useCompanyFacts();
  const connections = useConnections();
  const toolkits = useComposioToolkits();

  const state = setup.state?.enabled === true ? setup.state : null;
  if (!state) return null;

  const files = setup.imports.files ?? null;
  const reads = summarizeReads(files);
  const cook = cookingView(state);
  const name = facts.data?.company_name.trim();
  const site = facts.isPending ? null : facts.isError ? copy.PREVIEW_UNAVAILABLE : facts.data?.domain.trim() || copy.PREVIEW_NO_SITE;
  const filesLine = files === null ? null : reads.reading.length ? copy.step1Reading(namesOf(reads.reading)) : copy.stripFiles(reads.done.length);
  const apps = connectedNames(connections.data?.rows ?? [], toolkits.data?.toolkits ?? []);
  const appsLine = connections.isPending ? null : connections.isError ? copy.PREVIEW_UNAVAILABLE : apps.length ? apps.join(", ") : copy.PREVIEW_NONE_YET;

  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <Text style={styles.heading}>{name ? copy.previewHeading(name) : copy.PREVIEW_HEADING}</Text>
      <KnowsRow label={copy.KNOWS_WEBSITE} value={site} />
      <KnowsRow label={copy.KNOWS_FILES} value={filesLine} />
      <KnowsRow label={copy.KNOWS_APPS} value={appsLine} />
      <View style={styles.cookRow}>
        <Text style={styles.cookLabel}>{cook.ready ? copy.COOKED_LABEL : copy.COOKING_LABEL}</Text>
        <Text style={styles.pct}>{cook.pct}%</Text>
      </View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityLabel="Growth strategy progress"
        accessibilityValue={{ min: 0, max: 100, now: cook.pct }}
      >
        <Svg width={`${cook.pct}%`} height="100%">
          <Defs>
            <LinearGradient id="cook" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={COOK_FROM} />
              <Stop offset="1" stopColor={COOK_TO} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" rx={3} fill="url(#cook)" />
        </Svg>
      </View>
    </View>
  );
}

function KnowsRow({ label, value }: { label: string; value: string | null }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, value === null && styles.loading]} numberOfLines={1}>
        {value ?? copy.PREVIEW_LOADING}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      marginTop: space.lg,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.lg,
      backgroundColor: colors.soft,
      padding: radius.lg,
    },
    heading: { marginBottom: space.sm, fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    row: { flexDirection: "row", gap: space.sm, marginTop: 3 },
    label: { width: 56, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    value: { flex: 1, minWidth: 0, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.ink },
    loading: { color: colors.textSecondary },
    cookRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md },
    cookLabel: { flex: 1, fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    pct: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
    track: { marginTop: 10, height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.line },
  });
