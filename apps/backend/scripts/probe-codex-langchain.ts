
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { isCodexEnabled } from "../src/services/codex-subscription";
import { buildCodexChatModel } from "../src/services/agents/deepagent/codex-langchain-model";

const MODEL = process.env.CODEX_PROBE_MODEL?.trim();

async function tryInvoke(
  label: string,
  llm: NonNullable<ReturnType<typeof buildCodexChatModel>>,
  messages: (HumanMessage | SystemMessage)[],
) {
  console.log(`\n[probe] === ${label} ===`);
  try {
    const out = await llm.invoke(messages);
    const text =
      typeof out.content === "string"
        ? out.content
        : JSON.stringify(out.content).slice(0, 200);
    console.log(`[probe] OK — reply (${text.length} chars): ${text.slice(0, 120)}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[probe] FAIL — ${msg.slice(0, 500)}`);
    return false;
  }
}

async function main() {
  if (!isCodexEnabled()) {
    console.error("[probe] CODEX_ACCESS_TOKEN not set — run: npm run sync:codex-env -w @zavi/backend");
    process.exit(1);
  }
  if (!process.env.CODEX_ACCOUNT_ID?.trim()) {
    console.warn("[probe] CODEX_ACCOUNT_ID unset — codex may 401");
  }

  const llm = buildCodexChatModel(MODEL);
  if (!llm) {
    console.error("[probe] buildCodexChatModel returned null");
    process.exit(1);
  }

  const cases: Array<{
    label: string;
    messages: (HumanMessage | SystemMessage)[];
  }> = [
    {
      label: "human-only",
      messages: [new HumanMessage("Reply with exactly: codex-ok")],
    },
    {
      label: "system + human",
      messages: [
        new SystemMessage("You are a terse assistant."),
        new HumanMessage("Reply with exactly: codex-ok"),
      ],
    },
  ];

  let anyOk = false;
  for (const c of cases) {
    if (await tryInvoke(c.label, llm, c.messages)) anyOk = true;
  }

  if (!anyOk) {
    console.error("\n[probe] All cases failed.");
    process.exit(1);
  }
  console.log("\n[probe] Codex + LangChain OK.");
}

main().catch((e) => {
  console.error("[probe] unhandled:", e instanceof Error ? e.message : e);
  process.exit(1);
});
