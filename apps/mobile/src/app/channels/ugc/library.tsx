import { useRef } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { KeyboardAvoider } from "../../../components/KeyboardAvoider";
import { StateLine, UgcScreen } from "../../../components/channels/UgcParts";
import { LibraryCard } from "../../../components/channels/UgcLibraryParts";
import { useCanWrite, useLibrary } from "../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";

const LEDE =
  "Every approved creator video, the dates its ad rights run between, the tracking tag to use, and a download. When Meta Ads is connected you can also drop one into your ad account as a paused draft ad.";

export default function LibraryRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Library />;
}

function Library() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ asset?: string; open?: string }>();
  const focus = typeof params.asset === "string" ? params.asset : "";
  const openPanel = params.open === "meta" || params.open === "youtube" ? params.open : undefined;
  const library = useLibrary();
  const canWrite = useCanWrite();
  const scroll = useRef<ScrollView>(null);
  const scrolled = useRef(false);
  const assets = library.data;

  return (
    <UgcScreen title="Library">
      <KeyboardAvoider style={styles.body}>
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={library.isRefetching}
              onRefresh={() => void library.refetch()}
              tintColor={colors.muted}
              colors={[colors.ink]}
              progressBackgroundColor={colors.surfaceRaised}
            />
          }
        >
          <Text style={styles.lede}>{LEDE}</Text>
          {!assets ? (
            <StateLine loading={library.isLoading} error={library.isError} onRetry={() => void library.refetch()} />
          ) : assets.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No approved videos yet</Text>
              <Text style={styles.emptyBody}>When you approve a creator's video, it lands here with its rights dates and a download.</Text>
            </View>
          ) : (
            assets.map((a) => (
              <LibraryCard
                key={a.id}
                asset={a}
                canWrite={canWrite}
                initialPanel={a.id === focus ? openPanel : undefined}
                onLayout={
                  a.id === focus
                    ? (e) => {
                        if (scrolled.current) return;
                        scrolled.current = true;
                        scroll.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - space.md), animated: true });
                      }
                    : undefined
                }
              />
            ))
          )}
        </ScrollView>
      </KeyboardAvoider>
    </UgcScreen>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { flex: 1 },
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    lede: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    empty: { gap: 6, paddingTop: space.lg, alignItems: "center" },
    emptyTitle: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink, textAlign: "center" },
    emptyBody: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary, textAlign: "center" },
  });
