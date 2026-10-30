/**
 * Context-size estimate for Pi's meter and auto-compaction.
 *
 * Cursor's checkpoint reports `tokenDetails.usedTokens`, but that is not a
 * tokenizer count. Its per-category breakdown shows `tokens = chars / ~2.44`
 * in every category (observed 2026-10-30 on Claude, Opus and Haiku alike),
 * which reads about 1.4-1.8x higher than Claude's real token count. Passed
 * through as-is, Pi compacted long sessions far too early and showed a full
 * meter for half-full contexts.
 *
 * When the breakdown is present, estimate from the characters Cursor counted
 * instead, at Claude's usual ~3.5 characters per token. It is still an
 * estimate: dense code runs closer to 3, plain prose closer to 4. Without the
 * breakdown, keep Cursor's own number, which errs high (compacts early, never
 * late).
 */
import type { ConversationTokenDetails } from "../proto/agent_pb.js";

export const DEFAULT_CHARS_PER_TOKEN = 3.5;

/** `PI_CURSOR_CHARS_PER_TOKEN` overrides the ratio; invalid or non-positive values fall back. */
export function resolveCharsPerToken(raw = process.env.PI_CURSOR_CHARS_PER_TOKEN): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHARS_PER_TOKEN;
}

/** Characters Cursor counted across all categories, or undefined when it sent no breakdown. */
export function countedChars(
  details: Pick<ConversationTokenDetails, "breakdown">,
): number | undefined {
  const categories = details.breakdown?.categories ?? [];
  if (categories.length === 0) return undefined;
  const total = categories.reduce((sum, c) => sum + (c.chars ?? 0), 0);
  return total > 0 ? total : undefined;
}

export function estimateContextTokens(
  details: Pick<ConversationTokenDetails, "usedTokens" | "breakdown">,
  charsPerToken = resolveCharsPerToken(),
): number {
  const chars = countedChars(details);
  if (chars === undefined) return details.usedTokens;
  return Math.ceil(chars / charsPerToken);
}
