import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const magic = 4242;
let toolCalled = false;

const probeServer = createSdkMcpServer({
  name: "probe",
  version: "1.0.0",
  tools: [
    tool(
      "get_magic_number",
      "Returns the secret magic number. You MUST call this to learn the number.",
      { _unused: z.string().optional() },
      async () => {
        toolCalled = true;
        return { content: [{ type: "text", text: String(magic) }] };
      },
    ),
  ],
});

const outputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      magic_number: { type: "number" },
      called_tool: { type: "boolean" },
    },
    required: ["magic_number", "called_tool"],
    additionalProperties: false,
  },
};

const prompt =
  "Call the probe get_magic_number tool to learn the secret magic number, " +
  "then return it. Set called_tool=true if you called the tool.";

let resultMsg = null;
try {
  for await (const msg of query({
    prompt,
    options: {
      mcpServers: { probe: probeServer },
      allowedTools: ["mcp__probe__get_magic_number"],
      outputFormat,
      maxTurns: 6,
      model: "claude-haiku-4-5-20251001",
    },
  })) {
    if (msg.type === "result") resultMsg = msg;
  }
} catch (e) {
  console.log("PROBE_ERROR:", e?.message || String(e));
  process.exit(2);
}

const subtype = resultMsg?.subtype;
const so = resultMsg?.structured_output;
console.log("subtype:", subtype);
console.log("tool_called:", toolCalled);
console.log("structured_output:", JSON.stringify(so));

const pass =
  toolCalled &&
  so &&
  typeof so === "object" &&
  so.called_tool === true &&
  so.magic_number === magic &&
  subtype !== "error_max_structured_output_retries";

console.log(pass ? "\nCOMPOSITION_PROBE: PASS" : "\nCOMPOSITION_PROBE: FAIL");
process.exit(pass ? 0 : 1);
