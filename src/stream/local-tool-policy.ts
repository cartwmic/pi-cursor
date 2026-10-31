/** Local operations are executed by Pi, never by the provider. */
import { create } from "@bufbuild/protobuf";

import { McpToolDefinitionSchema, type McpToolDefinition } from "../proto/agent_pb.js";
import { cursorMcpToolName, cursorMcpToolNames } from "./root-prompt.js";

export const MAX_LOCAL_TOOL_REJECTIONS = 8;
export const LOCAL_TOOL_LOOP_ERROR =
  `Cursor repeatedly requested disabled local tools (${MAX_LOCAL_TOOL_REJECTIONS} requests without a Pi tool result). ` +
  "Local operations must use the registered Pi MCP tools. Stopped to avoid an endless retry loop.";

const LOCAL_TOOL_HINTS: Record<string, string[]> = {
  readArgs: ["read", "Read", "bash"],
  lsArgs: ["ls", "LS", "bash"],
  grepArgs: ["grep", "Grep", "bash"],
  writeArgs: ["write", "Write", "edit", "Edit", "bash"],
  deleteArgs: ["bash"],
  shellArgs: ["bash"],
  shellStreamArgs: ["bash"],
  backgroundShellSpawnArgs: ["bash"],
  writeShellStdinArgs: ["bash"],
};

/** Identifies native file and shell requests that must be rejected in favor of Pi tools. */
export function isLocalToolExec(execCase: string): boolean {
  return Object.hasOwn(LOCAL_TOOL_HINTS, execCase);
}

const namesCache = new WeakMap<McpToolDefinition[], string[]>();
/** Caches nonempty tool names and aliases; the definitions array must remain immutable. */
export function availableToolNamesFor(tools: McpToolDefinition[]): string[] {
  const cached = namesCache.get(tools);
  if (cached) return cached;
  const names = [...new Set(tools.flatMap((tool) => [tool.toolName, tool.name]))].filter(Boolean);
  namesCache.set(tools, names);
  return names;
}

/** Registered names advertised under something other than their usual prefixed form. */
function renamedToolNames(available: readonly string[]): Array<[string, string]> {
  const names = cursorMcpToolNames(available);
  return available
    .map((name): [string, string] => [name, names.advertised(name)])
    .filter(([name, advertised]) => advertised !== cursorMcpToolName(name));
}

const wireCache = new WeakMap<McpToolDefinition[], McpToolDefinition[]>();
/**
 * The Pi catalog as sent in RunRequest and RequestContext, under the wire names of
 * `cursorMcpToolNames`. The registry passed to dispatch keeps Pi's own names.
 */
export function wireMcpToolDefinitions(tools: McpToolDefinition[]): McpToolDefinition[] {
  const cached = wireCache.get(tools);
  if (cached) return cached;
  const names = cursorMcpToolNames(availableToolNamesFor(tools));
  let changed = false;
  const wire = tools.map((tool) => {
    const name = tool.toolName || tool.name;
    const wireName = names.wire(name);
    if (wireName === name || (tool.providerIdentifier || "pi") !== "pi") return tool;
    changed = true;
    return create(McpToolDefinitionSchema, { ...tool, name: wireName, toolName: wireName });
  });
  const result = changed ? wire : tools;
  wireCache.set(tools, result);
  return result;
}

/** Lists registered tools with known matches first, custom tools visible, and bash last. */
export function localToolCandidates(execCase: string, tools: McpToolDefinition[]): string[] {
  const available = availableToolNamesFor(tools);
  const preferred = (LOCAL_TOOL_HINTS[execCase] ?? []).filter(
    (name) => name !== "bash" && available.includes(name),
  );
  // Custom tools may be more appropriate than a shell. Keep them visible even
  // when a known tool exists; names alone cannot establish their capabilities.
  return [
    ...new Set([
      ...preferred,
      ...available.filter((name) => name !== "bash"),
      ...available.filter((name) => name === "bash"),
    ]),
  ];
}

/**
 * How to reach the registered Pi MCP tools. Cursor's agent no longer puts MCP tools in the
 * model's direct function list: the model sees its native tools plus the meta tools
 * GetDynamicTools and CallDynamicTool, and reaches MCP servers through them (the `pi`
 * namespace is answered by `mcpStateServersFor`). Without this recipe, models that look for a
 * direct `codemode` or `mcp_pi_read` function conclude the Pi tools are not registered and
 * refuse (observed with Claude Opus, Sonnet and Haiku under codemode `only`).
 */
function mcpToolReachText(available: readonly string[]): string {
  const names = cursorMcpToolNames(available);
  const example = available.find((name) => name !== "codemode") ?? available[0];
  const exampleText = example ? ` (for example "${names.advertised(example)}")` : "";
  return (
    "Pi tools are not in your direct function list. They live in the dynamic tool namespace " +
    '"pi": call one with CallDynamicTool, setting namespace to "pi", toolName to its listed name' +
    `${exampleText}, mcpDetails.description to a one-sentence summary, and arguments to the ` +
    'tool\'s input. GetDynamicTools with namespace "pi" returns their schemas. A Pi tool missing ' +
    "from your direct functions or from a name search is expected and is not proof that it is " +
    "unregistered; call it through CallDynamicTool."
  );
}

/**
 * Explains how the codemode tool covers local operations when it is exposed but no
 * read/bash-style tool is declared (codemode `only` mode hides direct declarations).
 * Without this note the model only sees a vague "other exposed Pi tools" line and
 * keeps retrying native Cursor tools instead of writing a codemode script.
 */
function codemodeCoverageText(available: readonly string[]): string {
  const name = cursorMcpToolNames(available).advertised("codemode");
  return (
    `The codemode tool (namespace "pi", toolName "${name}") covers local operations through ` +
    'its nested tools API: call it through CallDynamicTool with arguments {"code": "<JavaScript>"} ' +
    'using `await tools.bash({ command: "..." })` for shell commands, ' +
    '`await tools.read({ path: "..." })` for file reads, and `await tools.write(...)` or ' +
    "`await tools.edit(...)` for file edits. Run independent operations in one codemode script " +
    "with Promise.all rather than in separate calls."
  );
}

/** Explains a native rejection using registered tools and their schemas, or the current lack of tools. */
export function nativeToolRejectReason(execCase: string, tools: McpToolDefinition[]): string {
  const available = availableToolNamesFor(tools);
  const toolNames = cursorMcpToolNames(available);
  const names = localToolCandidates(execCase, tools).map(toolNames.advertised);
  const guidance = names.length
    ? `Use the registered Pi MCP tools: ${names.join(", ")}. ${mcpToolReachText(available)} ` +
      "Choose a tool that supports the operation and construct arguments according to its schema; " +
      "do not copy native Cursor arguments unchanged. If none supports it, report that limitation."
    : "No Pi MCP tools are exposed for this request, so this operation cannot be performed in this request.";
  const codemodeNote = available.includes("codemode") ? ` ${codemodeCoverageText(available)}` : "";
  return `Do not retry this native Cursor tool. It is unavailable. No operation was performed. ${guidance}${codemodeNote}`;
}

/** Builds prompt guidance for Pi-owned local operations, including tool-free requests. */
export function localToolPolicyText(tools: McpToolDefinition[]): string {
  const available = availableToolNamesFor(tools);
  const known = new Set(Object.values(LOCAL_TOOL_HINTS).flat());
  const names = available
    .filter((name) => known.has(name))
    .map(cursorMcpToolNames(available).advertised);
  const clashes = renamedToolNames(available).map(
    ([name, advertised]) => `call the custom tool "${name}" as ${advertised}`,
  );
  const codemodeNote = available.includes("codemode") ? ` ${codemodeCoverageText(available)}` : "";
  return (
    "Local file reads, searches, directory listings, writes, deletions and shell commands " +
    "must use Pi MCP tools. Native Cursor local tools are disabled; do not call or retry them. " +
    (available.length
      ? (names.length ? `Local Pi MCP tools: ${names.join(", ")}. ` : "") +
        `${mcpToolReachText(available)} ` +
        (clashes.length ? `To avoid a name clash, ${clashes.join("; ")}. ` : "") +
        "Other exposed Pi tools may also support the operation. Follow each tool's input schema. " +
        "If no registered tool supports an operation, report that limitation."
      : "No Pi MCP tools are exposed for this request. Local operations are unavailable in this request.") +
    codemodeNote
  );
}
