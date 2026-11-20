import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Screen } from "../../components/Screen";
import { BackHeader, ListGroup, Row, SectionLabel, settingsStyles } from "../../components/settings/SettingsUI";
import { StatusSpinner } from "../../components/channels/ChannelStates";
import { ChannelIcon } from "../../components/channels/ChannelGlyph";
import { BuildEmptyState, BuildErrorState, BuildSkeleton } from "../../components/build/BuildStates";
import { useBuildSessions } from "../../features/build/hooks";
import { sessionRows, type BuildSessionState } from "../../features/build/logic";
import { space } from "../../theme/tokens";
import { useTheme } from "../../theme/theme";

function StateBadge({ state }: { state: BuildSessionState }) {
  const { colors } = useTheme();
  if (state === "building" || state === "publishing") return <StatusSpinner size={18} />;
  const done = state === "ready" || state === "replaced";
  const tint = state === "ready" ? colors.switchOn : state === "replaced" ? colors.muted : colors.danger;
  return (
    <View style={[badge, { backgroundColor: tint + "26" }]}>
      <ChannelIcon name={done ? "check" : "close"} size={12} color={tint} />
    </View>
  );
}

const badge = { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" } as const;

export default function BuildList() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const q = useBuildSessions();
  const rows = useMemo(() => sessionRows(q.data, Date.now()), [q.data]);

  const { refetch } = q;
  const [pulling, setPulling] = useState(false);
  const onPull = async () => {
    setPulling(true);
    await refetch().catch(() => {});
    setPulling(false);
  };
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  return (
    <Screen>
      <BackHeader title="Build" />
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => void onPull()}
            tintColor={colors.muted}
            colors={[colors.ink]}
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
      >
        <ListGroup>
          <Row
            label="New build"
            sub="Describe an app and Zavi builds it."
            icon="plus"
            onPress={() => router.push("/build/new")}
          />
        </ListGroup>

        <SectionLabel>Your builds</SectionLabel>
        {q.isLoading ? (
          <BuildSkeleton label="Loading builds" />
        ) : q.isError ? (
          <BuildErrorState text="Couldn't load your builds." onRetry={() => void refetch()} />
        ) : rows.length === 0 ? (
          <BuildEmptyState text="No builds yet. Start one above." />
        ) : (
          <ListGroup>
            {rows.map((r) => (
              <Row
                key={r.id}
                label={r.title}
                sub={r.updated ? `${r.status} · ${r.updated}` : r.status}
                accessibilityLabel={`${r.title}, ${r.status}`}
                leading={<StateBadge state={r.state} />}
                chevron
                onPress={() => router.push({ pathname: "/build/[id]", params: { id: r.id } })}
              />
            ))}
          </ListGroup>
        )}
      </ScrollView>
    </Screen>
  );
}

