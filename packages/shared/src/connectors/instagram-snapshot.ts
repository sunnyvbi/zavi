export function instagramSnapshotMatchesConnection(
  snapshot: { connection_id?: string | null; created_at?: string | null },
  connection: { team_id?: string | null; connected_at?: string | null },
): boolean {
  return !!snapshot.connection_id && !!connection.team_id && snapshot.connection_id === connection.team_id;
}

export type InstagramAccountSnapshot = { captured_on: string; account_id?: string | null; username?: string | null; connection_id?: string | null; created_at?: string | null };
type PostSnapshot = { captured_on: string; account_id?: string | null };

export function filterInstagramSnapshots<A extends InstagramAccountSnapshot, P extends PostSnapshot>(
  allAccounts: A[], allPosts: P[], connection?: { team_id?: string | null; connected_at?: string | null } | null,
): { accounts: A[]; posts: P[] } {
  const last = allAccounts[allAccounts.length - 1];
  const verified = connection === undefined || !!(last && connection && instagramSnapshotMatchesConnection(last, connection));
  const accounts = verified && last ? allAccounts.filter((a) =>
    last.account_id ? a.account_id === last.account_id : !!last.username && a.username === last.username,
  ) : [];
  const days = new Set(accounts.map((a) => a.captured_on));
  const posts = allPosts.filter((p) => days.has(p.captured_on) &&
    (last?.account_id ? p.account_id === last.account_id : !p.account_id));
  return { accounts, posts };
}
