import { afterEach, describe, expect, it } from "vitest";

import { registerSessionLifecycleCleanup } from "../src/extension/debug-hooks.js";
import { activeBridges, removeActiveBridge } from "../src/stream/bridge-session.js";
import {
  conversationStates,
  deriveBridgeKeyFromSessionId,
  deriveConversationKeyFromSessionId,
} from "../src/stream/session-state.js";

type Handler = (event: unknown, ctx: unknown) => void;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    emit(name: string, event: unknown, sessionId: string) {
      const ctx = { sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf" } };
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    },
  };
}

/** A bridge parked for Pi tool results, as an aborted tool call leaves it. */
function parkToolBridge(sessionId: string) {
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  let ended = 0;
  activeBridges.set(bridgeKey, {
    bridge: {
      proc: { kill: () => true },
      alive: true,
      lastStderr: () => "",
      write: () => {},
      end: () => {
        ended++;
      },
      onData: () => {},
      onClose: () => {},
    },
    heartbeatTimer: setInterval(() => {}, 60_000),
    blobStore: new Map(),
    mcpTools: [],
    pendingExecs: [],
  } as never);
  return { bridgeKey, ended: () => ended };
}

describe("agent_settled releases a bridge only for an aborted run", () => {
  const sessions: string[] = [];
  afterEach(() => {
    for (const sessionId of sessions.splice(0)) {
      const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
      const active = activeBridges.get(bridgeKey);
      if (active) clearInterval(active.heartbeatTimer);
      removeActiveBridge(bridgeKey);
      conversationStates.delete(deriveConversationKeyFromSessionId(sessionId));
    }
  });

  it.each([
    [{ aborted: true }, true],
    [{ aborted: false }, false],
    [{}, false],
  ])("on %j releases=%s", (event, released) => {
    const sessionId = `settle-${JSON.stringify(event)}`;
    sessions.push(sessionId);
    const pi = fakePi();
    registerSessionLifecycleCleanup(pi as never);
    const parked = parkToolBridge(sessionId);

    pi.emit("agent_settled", event, sessionId);

    expect(activeBridges.has(parked.bridgeKey)).toBe(!released);
    expect(parked.ended()).toBe(released ? 1 : 0);
  });
});
