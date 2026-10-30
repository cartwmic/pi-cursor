import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  ConversationTokenBreakdownSchema,
  ConversationTokenCategorySchema,
  ConversationTokenDetailsSchema,
} from "../src/proto/agent_pb.js";
import { cursorModelCost, estimateModelCost } from "../src/models/cost.js";
import {
  countedChars,
  DEFAULT_CHARS_PER_TOKEN,
  estimateContextTokens,
  resolveCharsPerToken,
} from "../src/stream/token-estimate.js";

// Captured 2026-10-30 from a claude-sonnet-5-5 checkpoint (a 104 KB attached file):
// tokenDetails field 3, length-prefixed as it was on the wire. usedTokens 67260; every
// category is chars / ~2.44.
const FIELD3_B64 =
  "mQIIvI0EEOCnEhokCg1zeXN0ZW1fcHJvbXB0Eg1TeXN0ZW0gcHJvbXB0GIsRIN4pGiAKBXRvb2xzEhBUb29sIGRlZmluaXRpb25zGIs1INuBARoUCgVydWxlcxIFUnVsZXMYrAQgzwoaEgoGc2tpbGxzEgZTa2lsbHMgABocCgNtY3ASE01DUCAmIGR5bmFtaWMgdG9vbHMgABojCglzdWJhZ2VudHMSFFN1YmFnZW50IGRlZmluaXRpb25zIAAaNAoXc3VtbWFyaXplZF9jb252ZXJzYXRpb24SF1N1bW1hcml6ZWQgY29udmVyc2F0aW9uIAAaJAoMY29udmVyc2F0aW9uEgxDb252ZXJzYXRpb24Y+sIDIJrOCA==";

function capturedDetails() {
  const head = toBinary(
    ConversationTokenDetailsSchema,
    create(ConversationTokenDetailsSchema, { usedTokens: 67260, maxTokens: 300000 }),
  );
  const wire = Buffer.concat([head, Buffer.from([0x1a]), Buffer.from(FIELD3_B64, "base64")]);
  return fromBinary(ConversationTokenDetailsSchema, wire);
}

describe("Cursor context token estimate", () => {
  it("decodes the per-category breakdown Cursor sends in tokenDetails", () => {
    const details = capturedDetails();
    expect(details.usedTokens).toBe(67260);
    expect(details.maxTokens).toBe(300000);
    expect(details.breakdown?.categories.map((c) => c.key)).toContain("conversation");
    expect(details.$unknown ?? []).toHaveLength(0);
    expect(countedChars(details)).toBe(5342 + 16603 + 1359 + 141082);
  });

  it("estimates from counted characters instead of Cursor's chars/2.44 figure", () => {
    const details = capturedDetails();
    const estimate = estimateContextTokens(details, DEFAULT_CHARS_PER_TOKEN);
    expect(estimate).toBe(Math.ceil(164386 / 3.5));
    expect(estimate / details.usedTokens).toBeCloseTo(0.7, 1);
  });

  it("keeps Cursor's number when it sends no breakdown", () => {
    const details = create(ConversationTokenDetailsSchema, { usedTokens: 1234, maxTokens: 300000 });
    expect(estimateContextTokens(details)).toBe(1234);
  });

  it("round-trips the breakdown through the schema", () => {
    const details = create(ConversationTokenDetailsSchema, {
      usedTokens: 41,
      breakdown: create(ConversationTokenBreakdownSchema, {
        categories: [
          create(ConversationTokenCategorySchema, { key: "conversation", tokens: 41, chars: 100 }),
        ],
      }),
    });
    const back = fromBinary(
      ConversationTokenDetailsSchema,
      toBinary(ConversationTokenDetailsSchema, details),
    );
    expect(estimateContextTokens(back, 4)).toBe(25);
  });

  it("accepts a positive PI_CURSOR_CHARS_PER_TOKEN override only", () => {
    expect(resolveCharsPerToken(undefined)).toBe(DEFAULT_CHARS_PER_TOKEN);
    expect(resolveCharsPerToken("3")).toBe(3);
    expect(resolveCharsPerToken("0")).toBe(DEFAULT_CHARS_PER_TOKEN);
    expect(resolveCharsPerToken("abc")).toBe(DEFAULT_CHARS_PER_TOKEN);
  });
});

describe("Cursor model cost", () => {
  it("is zero by default because Cursor bills plan quota", () => {
    expect(cursorModelCost("claude-opus-5-5", undefined)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("uses API-rate estimates only when opted in", () => {
    expect(cursorModelCost("claude-opus-5-5", "1")).toEqual(estimateModelCost("claude-opus-5-5"));
  });
});
