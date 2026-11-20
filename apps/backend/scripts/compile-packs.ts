#!/usr/bin/env tsx

import "dotenv/config";
import { compileAllPacks, listPackFiles, readPackFile, hashPack } from "../src/services/packs/registry";

async function main(): Promise<void> {
  const dry = process.env.PRAXIS_PACKS_DRY === "1";

  if (dry) {
    const files = await listPackFiles();
    console.log(`compile-packs: dry-run · ${files.length} pack file(s)`);
    for (const f of files) {
      const pack = await readPackFile(f);
      console.log(`  ✓ ${pack.id} (${pack.status}) hash=${hashPack(pack).slice(0, 12)}…`);
    }
    return;
  }

  const results = await compileAllPacks();
  if (results.length === 0) {
    console.log("compile-packs: no pack files found in apps/backend/data/packs/");
    return;
  }
  for (const r of results) {
    console.log(
      `  ${r.action === "unchanged" ? "·" : r.action === "inserted" ? "+" : "↻"} ${r.pack_id} (${r.status}) hash=${r.content_hash.slice(0, 12)}…`,
    );
  }
}

main().catch((err) => {
  console.error("compile-packs failed:", err);
  process.exit(1);
});
