import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  TtftBreakdownSchema,
} from "../src/proto/agent_pb.js";
import {
  enhanceCursorStreamError,
  isAuthErrorMessage,
  isContextOverflowMessage,
  isProtocolMismatchMessage,
} from "../src/stream/protocol.js";
import { recordDriftSignal, resetDriftSignalsForTests } from "../src/stream/drift.js";
import { createConnectFrameParser, parseConnectEndStream } from "../src/client/bridge.js";

describe("protocol helpers", () => {
  it("detects auth and protocol mismatch messages", () => {
    expect(isAuthErrorMessage("Connect error unauthenticated: bad token")).toBe(true);
    expect(isAuthErrorMessage("normal failure")).toBe(false);
    expect(isProtocolMismatchMessage("Failed to parse Connect end stream")).toBe(true);
    expect(isProtocolMismatchMessage("Connect error resource_exhausted: request too large")).toBe(
      false,
    );
    expect(isProtocolMismatchMessage("Connect error internal: boom")).toBe(false);
    expect(isProtocolMismatchMessage("Connect error unavailable")).toBe(false);
    expect(isContextOverflowMessage("Connect error resource_exhausted: Error")).toBe(true);
  });

  it("enhances auth/protocol errors with hints", () => {
    const auth = enhanceCursorStreamError("unauthenticated");
    expect(auth).toMatch(/auth-hint/);
    expect(auth).toMatch(/force-refresh|\/login cursor/);
    const proto = enhanceCursorStreamError("Failed to parse Connect end stream");
    expect(proto).toMatch(/protocol-hint/);
    expect(proto).toMatch(/PI_CURSOR_CLIENT_VERSION/);
    resetDriftSignalsForTests();
    recordDriftSignal("unknown_fields", "conversationCheckpointUpdate.payload#34,37");
    const overflow = enhanceCursorStreamError("Connect error resource_exhausted: Error");
    expect(overflow).toMatch(/context-hint/);
    expect(overflow).not.toMatch(/protocol-hint/);
    expect(overflow).not.toContain("[wire-drift");
    resetDriftSignalsForTests();
  });

  it("round-trips current server metadata fields", () => {
    const interaction = create(InteractionUpdateSchema, { timestampMs: 1_787_691_920_843n });
    expect(
      fromBinary(InteractionUpdateSchema, toBinary(InteractionUpdateSchema, interaction))
        .timestampMs,
    ).toBe(1_787_691_920_843n);

    const checkpoint = create(ConversationStateStructureSchema, {
      conversationStartedTimestampMs: 1_787_691_919_077n,
      conversationStartedTimeZone: "UTC",
    });
    expect(
      fromBinary(
        ConversationStateStructureSchema,
        toBinary(ConversationStateStructureSchema, checkpoint),
      ),
    ).toMatchObject({
      conversationStartedTimestampMs: 1_787_691_919_077n,
      conversationStartedTimeZone: "UTC",
    });

    const recovered = create(ConversationStateStructureSchema, {
      activeBranchName: "main",
      clientName: "pi",
      isRootProjectConversation: true,
      unknownField37: 7n,
    });
    const recoveredRoundTrip = fromBinary(
      ConversationStateStructureSchema,
      toBinary(ConversationStateStructureSchema, recovered),
    );
    expect(recoveredRoundTrip).toMatchObject({
      activeBranchName: "main",
      clientName: "pi",
      isRootProjectConversation: true,
      unknownField37: 7n,
    });
    expect(recoveredRoundTrip.$unknown ?? []).toEqual([]);

    // field 37 VARINT 7: tag (37<<3)|0 = 296 → 0xa8 0x02, value 7
    const field37Only = fromBinary(
      ConversationStateStructureSchema,
      new Uint8Array([0xa8, 0x02, 0x07]),
    );
    expect(field37Only.unknownField37).toBe(7n);
    expect((field37Only.$unknown ?? []).some((field) => field.no === 37)).toBe(false);

    const exec = create(ExecServerMessageSchema, { acceptHookAdditionalContexts: false });
    expect(
      fromBinary(ExecServerMessageSchema, toBinary(ExecServerMessageSchema, exec))
        .acceptHookAdditionalContexts,
    ).toBe(false);

    const server = create(AgentServerMessageSchema, {
      ttftBreakdown: create(TtftBreakdownSchema, {
        serverFirstTokenMs: 1,
        preStreamSetupMs: 2,
        waitForFirstEventMs: 3,
        providerTtftMs: 4,
        slowPoolWaitMs: 5,
      }),
    });
    expect(
      fromBinary(AgentServerMessageSchema, toBinary(AgentServerMessageSchema, server))
        .ttftBreakdown,
    ).toMatchObject({ providerTtftMs: 4 });
  });

  it("parses connect end-stream errors", () => {
    const err = parseConnectEndStream(
      new TextEncoder().encode(JSON.stringify({ error: { code: "internal", message: "boom" } })),
    );
    expect(err?.message).toMatch(/Connect error internal: boom/);
  });

  it("frames connect messages and parses them back", () => {
    const messages: Uint8Array[] = [];
    const ends: Uint8Array[] = [];
    const parse = createConnectFrameParser(
      (m) => messages.push(m),
      (e) => ends.push(e),
    );
    const payload = Buffer.from("hello", "utf8");
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    parse(frame);
    expect(messages).toHaveLength(1);
    expect(Buffer.from(messages[0]!).toString("utf8")).toBe("hello");
    expect(ends).toHaveLength(0);
  });
});
