/** Local operations are executed by Pi, never by the provider. */
import type { McpToolDefinition } from "../proto/agent_pb.js";
import { cursorMcpToolName } from "./root-prompt.js";

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
 * How to reach the registered Pi MCP tools. Cursor exposes them under the `pi`
 * namespace by their raw names; the `mcp_pi_<tool>` form appears in replayed
 * history and is unwrapped on dispatch, but it is not always the callable name.
 * A tool-catalog search does not surface MCP tools, so the model must attempt
 * the call directly instead of treating a failed search as proof of absence.
 */
function mcpToolReachText(available: readonly string[]): string {
  const example = available.find((name) => name !== "codemode");
  const exampleText = example
    ? ` (for example ${example} instead of mcp_pi_${example})`
    : "";
  return (
    "Call a listed tool immediately by name; do not search any tool catalog or list available " +
    "tools first. The tool catalog search does not surface MCP tools, so their absence from it " +
    "is expected and is not proof that they are unregistered. " +
    "If an mcp_pi_<tool> name is not callable, the same tool is reachable under the pi namespace " +
    `by its raw name${exampleText}.`
  );
}

/**
 * Explains how the codemode tool covers local operations when it is exposed but no
 * read/bash-style tool is declared (codemode `only` mode hides direct declarations).
 * Without this note the model only sees a vague "other exposed Pi tools" line and
 * keeps retrying native Cursor tools instead of writing a codemode script.
 */
function codemodeCoverageText(): string {
  return (
    "The codemode tool covers local operations through its nested tools API: call codemode " +
    "with JavaScript such as `await tools.bash({ command: \"...\" })` for shell commands, " +
    "`await tools.read({ path: \"...\" })` for file reads, and `await tools.write(...)` or " +
    "`await tools.edit(...)` for file edits."
  );
}

/** Explains a native rejection using registered tools and their schemas, or the current lack of tools. */
export function nativeToolRejectReason(execCase: string, tools: McpToolDefinition[]): string {
  const candidates = localToolCandidates(execCase, tools);
  const names = candidates.map(cursorMcpToolName);
  const guidance = names.length
    ? `Use the registered Pi MCP tools: ${names.join(", ")}. ${mcpToolReachText(availableToolNamesFor(tools))} ` +
      "Choose a tool that supports the operation and construct arguments according to its schema; " +
      "do not copy native Cursor arguments unchanged. If none supports it, report that limitation."
    : "No Pi MCP tools are exposed for this request, so this operation cannot be performed in this request.";
  const codemodeNote = availableToolNamesFor(tools).includes("codemode")
    ? ` ${codemodeCoverageText()}`
    : "";
  return `Do not retry this native Cursor tool. It is unavailable. No operation was performed. ${guidance}${codemodeNote}`;
}

/** Builds prompt guidance for Pi-owned local operations, including tool-free requests. */
export function localToolPolicyText(tools: McpToolDefinition[]): string {
  const available = availableToolNamesFor(tools);
  const known = new Set(Object.values(LOCAL_TOOL_HINTS).flat());
  const names = available.filter((name) => known.has(name)).map(cursorMcpToolName);
  const codemodeNote = available.includes("codemode") ? ` ${codemodeCoverageText()}` : "";
  return (
    "Local file reads, searches, directory listings, writes, deletions and shell commands " +
    "must use Pi MCP tools. Native Cursor local tools are disabled; do not call or retry them. " +
    (available.length
      ? (names.length
        ? `Local Pi MCP tools: ${names.join(", ")}. ${mcpToolReachText(available)} `
        : "") +
        "Other exposed Pi tools may also support the operation. Follow each tool's input schema. " +
        "If no registered tool supports an operation, report that limitation."
      : "No Pi MCP tools are exposed for this request. Local operations are unavailable in this request.") +
    codemodeNote
  );
}
