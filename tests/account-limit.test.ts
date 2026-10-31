import { describe, expect, it } from "vitest";

import {
  enhanceCursorStreamError,
  isAccountLimitMessage,
  isContextOverflowMessage,
} from "../src/stream/protocol.js";
import { classifyBridgeExit, formatTransportFailure } from "../src/stream/transport-errors.js";

// Pi's own retry rule (pi-ai utils/retry.js): terminal limit wording wins over retriable wording.
const PI_NON_RETRYABLE = /insufficient_quota|out of budget|quota exceeded|billing/i;
const PI_RETRYABLE = /rate.?limit|too many requests|connection.?lost/i;
const piRetries = (m: string) => !PI_NON_RETRYABLE.test(m) && PI_RETRYABLE.test(m);

describe("quota vs context overflow", () => {
  it("does not call a bare resource_exhausted a context overflow", () => {
    const raw = "Connect error resource_exhausted: Error";
    expect(isContextOverflowMessage(raw)).toBe(false);
    expect(isAccountLimitMessage(raw)).toBe(true);
    const message = enhanceCursorStreamError(raw);
    expect(message).toContain("limit-hint");
    expect(message).not.toContain("/compact)");
    expect(piRetries(message)).toBe(true);
  });

  it.each([
    "Connect error resource_exhausted: You've hit your usage limit",
    "Connect error resource_exhausted: Your subscription has expired",
    "Connect error resource_exhausted: quota reached for this billing period",
  ])("surfaces %s as a terminal quota error", (raw) => {
    const message = enhanceCursorStreamError(raw);
    expect(message).toContain("quota-hint");
    expect(message).toContain("quota exceeded");
    expect(message).not.toContain("context-hint");
    expect(piRetries(message)).toBe(false);
  });

  it.each([
    "Connect error resource_exhausted: context length exceeded",
    "Connect error invalid_argument: request too large",
    "Connect error resource_exhausted: prompt is too long",
  ])("keeps size wording %s as context overflow", (raw) => {
    expect(isContextOverflowMessage(raw)).toBe(true);
    const message = enhanceCursorStreamError(raw);
    expect(message).toContain("context-hint");
    expect(message).not.toContain("quota-hint");
    expect(message).not.toContain("limit-hint");
  });

  it("labels a rate-limit bridge exit after retries run out", () => {
    const failure = classifyBridgeExit({
      exitCode: 0,
      endErrorMessage: "Connect error resource_exhausted: Error",
    });
    const message = formatTransportFailure(failure);
    expect(message).toContain("limit-hint");
    expect(message).not.toContain("context-hint");
  });
});
