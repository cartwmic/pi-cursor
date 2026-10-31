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
 * instead, at ~3.5 characters per token for every model. That ratio is typical
 * of the BPE tokenizers behind Cursor's Claude, GPT and Gemini models, and it is
 * still an estimate: plain prose runs closer to 4 (the estimate reads high) and
 * dense code or JSON closer to 3 (it reads up to ~14% low, so Pi compacts a
 * little late). Without the breakdown, keep Cursor's own chars / 2.44 number,
 * which always reads higher than the estimate.
 *
 * Per-category ratios were considered and rejected: the categories split by
 * source (system prompt, tools, conversation), not by content, and code and
 * prose share the conversation category. Without a tokenizer any per-category
 * ratio would be a guess. Cursor's `maxTokens` is not a ceiling to clamp to
 * either: on 2026-10-30 Haiku answered a request Cursor counted at 380154 of
 * 300000 with both its first and last lines intact.
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
