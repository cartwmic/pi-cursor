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
  isProtocolMismatchMessage,
} from "../src/stream/protocol.js";
import { createConnectFrameParser, parseConnectEndStream } from "../src/client/bridge.js";

describe("protocol helpers", () => {
  it("detects auth and protocol mismatch messages", () => {
    expect(isAuthErrorMessage("Connect error unauthenticated: bad token")).toBe(true);
    expect(isAuthErrorMessage("normal failure")).toBe(false);
    expect(isProtocolMismatchMessage("Failed to parse Connect end stream")).toBe(true);
  });

  it("enhances auth/protocol errors with hints", () => {
    const auth = enhanceCursorStreamError("unauthenticated");
    expect(auth).toMatch(/auth-hint/);
    expect(auth).toMatch(/force-refresh|\/login cursor/);
    const proto = enhanceCursorStreamError("Failed to parse Connect end stream");
    expect(proto).toMatch(/protocol-hint/);
    expect(proto).toMatch(/PI_CURSOR_CLIENT_VERSION/);
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
