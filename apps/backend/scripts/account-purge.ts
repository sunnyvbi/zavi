
import { selfAccountClient } from "@/services/tenant-client";
import { StoragePendingError, purgeAccountDeletion, recordPurgeFailure } from "@/services/account/purge-account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function projectRef(): string {
  try {
    return new URL(process.env.SUPABASE_URL ?? "").hostname.split(".")[0] || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

async function main(): Promise<number> {
  const id = arg("deletion-id");
  const dryRun = flag("dry-run");
  const execute = flag("execute");
  if (!id || !UUID_RE.test(id) || dryRun === execute) {
    console.error("usage: account-purge --deletion-id <uuid> (--dry-run | --execute)");
    return 2;
  }

  const mode = execute ? "execute" : "dry_run";
  console.log(`account-purge: project ${projectRef()}, deletion ${id}, mode ${mode}`);

  const sb = selfAccountClient(
    "one-off account deletion purge of one account_deletions row (docs/runbooks/account-purge-one-off.md)",
  );
  try {
    const result = await purgeAccountDeletion(sb, id, mode);
    console.log(JSON.stringify(result, null, 2));
    console.log(`account-purge: ${result.status}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`account-purge: FAILED: ${message}`);
    if (!execute) {
      console.error("Dry run: nothing was changed.");
      return 1;
    }
    const filesOnly = err instanceof StoragePendingError;
    if (!(await recordPurgeFailure(sb, id, message, new Date(), { purged: filesOnly }))) {
      console.error("Could not write the failure to account_deletions.purge_last_error; keep this output.");
    }
    if (filesOnly) {
      console.error(
        "The database purge COMMITTED (the request is purged); some files could not be removed yet. " +
          "Run --execute again, or let the daily worker finish them (storage_purged_at stays empty until then).",
      );
      return 1;
    }
    const { data, error } = await sb.from("account_deletions").select("purged_at").eq("id", id).maybeSingle<{ purged_at: string | null }>();
    if (error) {
      console.error(`Could not read the request back (${error.message}): check account_deletions.purged_at by hand.`);
    } else if (data?.purged_at) {
      console.error(`The request IS purged (purged_at ${data.purged_at}); only the report failed.`);
      return 0;
    } else {
      console.error(
        "purged_at is still empty and no file was removed. Agent-run batches finished before the failure stay " +
          "removed (they were due); running --execute again continues from there.",
      );
    }
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`account-purge: crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
