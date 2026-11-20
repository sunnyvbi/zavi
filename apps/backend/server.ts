
import dotenv from "dotenv";
import { installUnhandledRejectionGuard } from "@/services/http/async-errors";
dotenv.config({ path: "dev.env" });
dotenv.config();

import { createApp } from "./src/app";
import {
  resolveClaudeBinary,
  assertClaudeBinaryResolvable,
} from "./src/services/agents/generic-dispatcher";
import { reapOrphanedRunsOnBoot } from "./src/services/agents/boot-reap";
import { reapStaleRuns } from "./src/services/agents/stale-run-reaper";
import { selfSyncInngestOnBoot } from "./src/services/inngest-self-sync";
import { inngest } from "./workers/client";
import {
  isProbeContainer,
  bootPlan,
} from "./src/services/agents/boot-role";
import { startMemorySampler } from "./src/services/observability/memory-sampler";
import { startInngestWatchdog } from "./src/services/observability/inngest-watchdog";
import { startDiscordGateway, stopDiscordGateway } from "./src/services/connectors/discord/gateway";
import { assertSkillsPresent } from "./src/services/agents/deepagent/skills";
import { assertChannelRecipesPresent } from "./src/services/channels/recipe";
import { logCodexTokenStatus } from "./src/services/codex-subscription";
import { assertResumeFlagsSane } from "./src/services/agents/sdk-session-store";
import { assertExecutionEnvSafe } from "./src/services/execution-env/boot-guard";
import { webBaseUrl } from "./src/services/web-base";
import {
  recordBootForensics,
  recordShutdownSigterm,
} from "./src/services/agents/boot-forensics";
import { startOAuthTokenPoolRefresh } from "./src/services/agents/oauth-token-source";
import { startSeatCooldownRefresh } from "./src/services/agents/seat-cooldown-store";
import { startSeatUsageRefresh } from "./src/services/agents/seat-usage-store";
import { warnIfSeatSaltUnset } from "./src/services/agents/seat-identity";
import { reportEmptyPlatformKeys } from "./src/services/config/platform-keys";
import { warmLiveStats } from "./src/routes/public/live-stats";

const PORT = parseInt(process.env.PORT || "3001", 10);

const BOOT_TS = new Date().toISOString();

const SHUTDOWN_GRACE_MS = parseInt(
  process.env.SHUTDOWN_GRACE_MS ||
    (process.env.NODE_ENV === "production" ? "110000" : "8000"),
  10,
);

async function main() {
  installUnhandledRejectionGuard();
  const plan = bootPlan();
  console.log(
    `[praxis-backend] role=${process.env.PRAXIS_ROLE || "all"} container=${process.env.PRAXIS_CONTAINER_ROLE ?? "(unset)"} serves_inngest=${plan.servesInngest}`,
  );
  assertClaudeBinaryResolvable();
  const bin = resolveClaudeBinary();
  console.log(`[praxis-backend] claude binary: ${bin}`);

  assertResumeFlagsSane(process.env);

  assertExecutionEnvSafe();

  webBaseUrl();

  startOAuthTokenPoolRefresh();
  startSeatCooldownRefresh();
  startSeatUsageRefresh();
  warnIfSeatSaltUnset();
  void reportEmptyPlatformKeys();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`[praxis-backend] listening on http://localhost:${PORT}`);
  });
  warmLiveStats();

  let bootStorm = false;
  if (!isProbeContainer()) {
    const f = await recordBootForensics(BOOT_TS);
    bootStorm = f.storm;
    console.log(
      `[praxis-backend] boot forensics: role=${f.container_role} prev_shutdown_clean=${f.prev_shutdown_clean} boots_last_10m=${f.boots_last_10m}${f.storm ? " — BOOT STORM, quarantining boot-reap" : ""}`,
    );
  }

  if (plan.bootReap) {
    if (process.env.NODE_ENV === "production") {
      void Promise.all([import("./workers/functions/site-shards-metrics"), import("./src/services/site-shards/registry")])
        .then(([m, r]) => m.requestShardMetricsSweep({ env: r.shardEnv(), reason: "boot" }))
        .catch((e) => console.warn("[praxis-backend] shard metrics sweep request at boot failed (non-fatal):", (e as Error)?.message ?? e));
      void import("./src/services/site-shards/auto-rollout")
        .then((m) => m.requestSchemaRolloutOnBoot())
        .catch((e) => console.warn("[praxis-backend] shard schema rollout request at boot failed (non-fatal):", (e as Error)?.message ?? e));
    }
    reapOrphanedRunsOnBoot(BOOT_TS, undefined, inngest, {
      quarantine: bootStorm,
      ...(plan.bootReapOwnRunsOnly ? { ownRunsOnly: true } : {}),
    })
      .then(({ reaped, requeued }) => {
        if (reaped > 0 || requeued > 0) {
          console.log(
            `[praxis-backend] boot-reap handled ${reaped + requeued} orphaned run(s): ${requeued} re-queued, ${reaped} terminalized`,
          );
        }
      })
      .catch((e) => {
        console.error("[praxis-backend] boot-reap failed (non-fatal):", e);
      });
    reapStaleRuns(undefined, inngest)
      .then(({ blocked_reaped, queued_reaped, promoted }) => {
        if (blocked_reaped + queued_reaped > 0) {
          console.log(
            `[praxis-backend] stale-run-reap: ${blocked_reaped} blocked + ${queued_reaped} queued reaped, ${promoted} promoted`,
          );
        }
      })
      .catch((e) => {
        console.error(
          "[praxis-backend] stale-run-reap failed (non-fatal):",
          e,
        );
      });
  } else {
    console.log(
      `[praxis-backend] boot-reap SKIPPED — role=${process.env.PRAXIS_CONTAINER_ROLE ?? "(unset)"}/${process.env.PRAXIS_ROLE || "all"} (not canonical, or the api host)`,
    );
  }

  if (plan.inngestSelfSync) {
    selfSyncInngestOnBoot(PORT)
      .then((r) => {
        if (r.skipped) return;
        console.log(
          `[praxis-backend] inngest self-sync ${r.ok ? "OK" : "FAILED"} after ${r.attempts} attempt(s)`,
        );
      })
      .catch((e) => {
        console.error("[praxis-backend] inngest self-sync error (non-fatal):", e);
      });
  } else {
    console.log(
      `[praxis-backend] inngest self-sync SKIPPED — ${!plan.servesInngest ? "api host serves no Inngest functions" : isProbeContainer() ? "role=probe (ephemeral health-probe container)" : "not the canonical container (local or other stack never syncs Inngest Cloud)"}`,
    );
  }

  startMemorySampler();

  if (plan.inngestWatchdog) startInngestWatchdog();

  if (plan.discordGateway) {
    void startDiscordGateway().then((r) => {
      if (r.started) console.log("[praxis-backend] discord gateway started");
    });
  }

  if (plan.platformWorkerSecrets) {
    void import("./src/services/hosting/platform-worker-secrets")
      .then((m) => m.convergePlatformWorkerSecretsOnBoot())
      .catch((e) => console.error("[worker-secrets] boot hook failed to load (non-fatal):", (e as Error).message));
  }

  assertSkillsPresent();

  assertChannelRecipesPresent();

  logCodexTokenStatus();

  let shuttingDown = false;
  const drain = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[praxis-backend] ${signal} received — draining (grace ${SHUTDOWN_GRACE_MS}ms)`);
    void recordShutdownSigterm().catch(() => {});
    void stopDiscordGateway().catch(() => {});
    let exiting = false;
    const exit = () => {
      if (exiting) return;
      exiting = true;
      void import("@/services/sites/site-preview-lease")
        .then((m) => m.releaseHeldSiteLeases())
        .then((n) => void (n && console.log(`[praxis-backend] released ${n} site lease(s) held by this process`)))
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    server.close(() => {
      console.log("[praxis-backend] drained cleanly, exiting");
      exit();
    });
    setTimeout(() => {
      console.log("[praxis-backend] grace window elapsed, forcing exit");
      exit();
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
}

main().catch((e) => {
  console.error("[praxis-backend] fatal:", e);
  process.exit(1);
});
