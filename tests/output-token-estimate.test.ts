import { describe, expect, it } from "vitest";

import { applyCursorUsage, estimateOutputTokens } from "../src/stream/pi-adapter.js";

const model = {
  id: "claude-sonnet-5-5",
  api: "cursor-native",
  provider: "cursor",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as never;

function state(outputTokens: number, contextTokens = 1000) {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens,
    totalTokens: contextTokens,
    contextTokens,
    turnEnded: true,
  };
}

describe("output token estimate", () => {
  it("counts text, thinking and tool-call arguments at the chars-per-token rule", () => {
    const content = [
      { type: "text", text: "a".repeat(70) },
      { type: "thinking", thinking: "b".repeat(35) },
      { type: "toolCall", id: "t1", name: "codemode", arguments: { code: "x" } },
    ];
    // 70 + 35 + "codemode" (8) + '{"code":"x"}' (12) = 125 chars -> ceil(125 / 3.5) = 36
    expect(estimateOutputTokens({ content } as never, 3.5)).toBe(36);
    expect(estimateOutputTokens({ content: [] } as never, 3.5)).toBe(0);
  });

  it("reports a short reply that Cursor sent no tokenDelta for", () => {
    const output = { content: [{ type: "text", text: "OK" }] } as never as Parameters<
      typeof applyCursorUsage
    >[0];
    applyCursorUsage(output, model, state(0) as never);
    expect(output.usage.output).toBe(1);
    expect(output.usage.totalTokens).toBe(1001);
  });

  it("keeps Cursor's tokenDelta sum when it is higher", () => {
    const output = { content: [{ type: "text", text: "hello" }] } as never as Parameters<
      typeof applyCursorUsage
    >[0];
    applyCursorUsage(output, model, state(50) as never);
    expect(output.usage.output).toBe(50);
  });
});
