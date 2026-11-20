import { View } from "react-native";
import { Card, H3, Muted, StatTile, TileGrid } from "./kit";
import { RedditNumbers } from "../channels/RedditPanel";
import { hasData, redditOff, scanBlocked, scanState } from "../../features/channels/reddit";
import { useRedditDashboard, useRefreshReddit } from "../../features/channels/redditHooks";

export function RedditDetail({ q }: { q: ReturnType<typeof useRedditDashboard> }) {
  const refresh = useRefreshReddit();
  const data = q.data;
  if (q.isLoading) {
    return (
      <Card>
        <Muted>Loading…</Muted>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <H3>No Reddit numbers yet</H3>
        <Muted>Open the Reddit channel and run a scan; the numbers land here.</Muted>
      </Card>
    );
  }
  if (redditOff(data)) return null;
  if (!hasData(data)) {
    return (
      <Card>
        <Muted>No Reddit scan yet. Open the Reddit channel and run a scan; the numbers land here.</Muted>
      </Card>
    );
  }
  const today = data.insights?.today ?? {};
  const state = scanState(data);
  const blocked = state ? scanBlocked(state) : null;
  const threshold = data.insights?.threshold ?? 50;
  return (
    <View>
      <Card>
        <TileGrid>
          <StatTile label="Posts read today" value={(today.posts_scanned ?? 0).toLocaleString("en-US")} />
          <StatTile label="Subreddits covered" value={(today.communities_scanned ?? 0).toLocaleString("en-US")} />
          <StatTile
            label="Worth replying to"
            value={(today.posts_relevant ?? 0).toLocaleString("en-US")}
            sub={`Posts scoring ${threshold}+ out of 100 for relevance to your business`}
          />
        </TileGrid>
        {blocked ? <Muted>{blocked}</Muted> : null}
      </Card>
      <RedditNumbers payload={data} loading={false} defaultTable="subreddits" onChanged={refresh} />
    </View>
  );
}
