import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  enhanceCursorStreamError,
  isAccountLimitMessage,
  isContextOverflowMessage,
} from "../src/stream/protocol.js";
import { classifyBridgeExit, formatTransportFailure } from "../src/stream/transport-errors.js";

/** What Pi does with an error turn carrying this text: compact, retry, or stop. */
function piOutcome(errorMessage: string): "overflow" | "retry" | "terminal" {
  const message = {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  } as never;
  if (isContextOverflow(message)) return "overflow";
  return isRetryableAssistantError(message) ? "retry" : "terminal";
}

const viaStream = (raw: string) => piOutcome(enhanceCursorStreamError(raw));
const viaTransport = (raw: string) =>
  piOutcome(formatTransportFailure(classifyBridgeExit({ exitCode: 0, endErrorMessage: raw })));

describe("quota vs rate limit vs context overflow, as Pi reads them", () => {
  it("does not hide overflow wording only Pi knows behind a rate-limit hint", () => {
    // Not in this provider's size wording, but in Pi's (xAI style).
    const raw = "Connect error resource_exhausted: maximum prompt length is 131072";
    expect(enhanceCursorStreamError(raw)).toContain("limit-hint");
    expect(viaStream(raw)).toBe("overflow");
    expect(viaTransport(raw)).toBe("overflow");
  });

  it("retries a bare resource_exhausted and does not call it an overflow", () => {
    const raw = "Connect error resource_exhausted: Error";
    expect(isContextOverflowMessage(raw)).toBe(false);
    expect(isAccountLimitMessage(raw)).toBe(true);
    expect(enhanceCursorStreamError(raw)).toContain("limit-hint");
    expect(viaStream(raw)).toBe("retry");
    expect(viaTransport(raw)).toBe("retry");
  });

  it.each([
    "Connect error resource_exhausted: You've hit your usage limit",
    "Connect error resource_exhausted: Your subscription has expired",
    "Connect error resource_exhausted: quota reached for this billing period",
  ])("stops on quota wording: %s", (raw) => {
    expect(enhanceCursorStreamError(raw)).toContain("quota-hint");
    expect(viaStream(raw)).toBe("terminal");
  });

  it.each([
    "Connect error resource_exhausted: Rate limit exceeded. Upgrade your subscription for higher limits",
    "Connect error resource_exhausted: Too many requests; your usage limit resets shortly",
  ])("retries throttle wording even when it mentions a plan: %s", (raw) => {
    expect(enhanceCursorStreamError(raw)).toContain("limit-hint");
    expect(viaStream(raw)).toBe("retry");
  });

  it.each([
    "Connect error resource_exhausted: token limit exceeded",
    "Connect error resource_exhausted: too many tokens",
    "Connect error resource_exhausted: context length exceeded",
    "Connect error resource_exhausted: prompt is too long",
    "Connect error resource_exhausted: request_too_large",
  ])("lets Pi compact on size wording: %s", (raw) => {
    expect(enhanceCursorStreamError(raw)).not.toContain("limit-hint");
    expect(viaStream(raw)).toBe("overflow");
  });

  it.each([
    "Connect error resource_exhausted: context length exceeded",
    "Connect error resource_exhausted: token limit exceeded",
  ])("keeps size wording an overflow after the transport retry gives up: %s", (raw) => {
    const text = formatTransportFailure(classifyBridgeExit({ exitCode: 0, endErrorMessage: raw }));
    expect(text).toContain("context-hint");
    expect(text).not.toContain("limit-hint");
    expect(viaTransport(raw)).toBe("overflow");
  });
});
