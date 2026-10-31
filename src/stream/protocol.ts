/**
 * Protocol-drift helpers: auth error detection, decode error framing, client version.
 */
import { getCursorClientVersion } from "./config.js";
import { formatDriftSummary, hasStrandingDrift } from "./drift.js";

const AUTH_ERROR_RE =
  /\b(unauthenticated|unauthorized|permission[_ ]?denied|auth(?:entication)?[_ ]?failed|invalid[_ ]?token|expired[_ ]?token|401)\b/i;

const PROTOCOL_ERROR_RE =
  /\b(failed to parse|decode|invalid wire|protocol mismatch|unknown field|premature eof)\b/i;

// Size wording only. `resource_exhausted` is gRPC's generic limit code: Cursor sends it for
// rate limits and exhausted plan quota too, usually with the bare message "Error".
const CONTEXT_OVERFLOW_RE =
  /\b(context[_ ]?(length|size|window)|payload too large|request too large|message too (?:large|long)|prompt (?:is )?too long|too many tokens)\b/i;

const ACCOUNT_LIMIT_RE =
  /\b(resource_exhausted|quota|usage[_ ]?limit|rate[_ ]?limit(?:ed)?|too many requests|subscription|billing|spend(?:ing)? limit)\b/i;

const QUOTA_RE = /\b(quota|usage[_ ]?limit|subscription|billing|spend(?:ing)? limit)\b/i;

export function isContextOverflowMessage(message: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(message);
}

/** Rate limit or plan quota: `resource_exhausted` or limit wording without size wording. */
export function isAccountLimitMessage(message: string): boolean {
  return !isContextOverflowMessage(message) && ACCOUNT_LIMIT_RE.test(message);
}

export function formatContextOverflowHint(message: string): string {
  return (
    `${message} ` +
    `[context-hint: Cursor rejected this request as too large, not wire-drift. ` +
    `A blob-store miss can force a full history rebuild. Compact the session (/compact) or start a new one.]`
  );
}

/**
 * Quota wording reads "quota exceeded", which Pi's auto-retry treats as terminal. A bare
 * `resource_exhausted` reads as a rate limit, which Pi retries with backoff.
 */
export function formatAccountLimitHint(message: string): string {
  if (QUOTA_RE.test(message)) {
    return (
      `${message} ` +
      `[quota-hint: Cursor quota exceeded for this account or plan; this is not a context-size problem. ` +
      `Check /cursor.usage. Compacting will not help.]`
    );
  }
  return (
    `${message} ` +
    `[limit-hint: Cursor rate limit or plan usage limit (resource_exhausted), not a context-size problem. ` +
    `Wait and retry, or check /cursor.usage. Compact only if the session is near its context window.]`
  );
}

export function isAuthErrorMessage(message: string): boolean {
  return AUTH_ERROR_RE.test(message);
}

export function isProtocolMismatchMessage(message: string): boolean {
  return PROTOCOL_ERROR_RE.test(message);
}

export function formatProtocolMismatchHint(message: string): string {
  const version = getCursorClientVersion();
  return (
    `${message} ` +
    `[protocol-hint: Cursor wire may have drifted. ` +
    `clientVersion=${version}. Try bumping PI_CURSOR_CLIENT_VERSION or re-run /cursor.doctor.]`
  );
}

/**
 * Appends what actually drifted, when anything did.
 *
 * A turn that fails after we skipped an unrecognized server message would
 * otherwise surface as a bare timeout. Naming the unhandled case turns "it hung"
 * into a reproducible bug report.
 */
export function appendDriftDiagnostic(message: string): string {
  const summary = formatDriftSummary();
  if (!summary) return message;
  const severity = hasStrandingDrift()
    ? "unhandled wire messages — the turn may have been left waiting on one"
    : "unknown wire fields — schema is likely behind Cursor";
  return (
    `${message} ` +
    `[wire-drift: ${severity}. Observed: ${summary}. ` +
    `Regenerate the schema (see proto/README.md) or bump PI_CURSOR_CLIENT_VERSION; ` +
    `/cursor.doctor shows the full list.]`
  );
}

const TRANSIENT_CONNECT_RE =
  /\b(Connect error (?:internal|unavailable|deadline_exceeded)|GOAWAY)\b/i;

export function enhanceCursorStreamError(message: string): string {
  if (isAuthErrorMessage(message)) {
    return (
      `${message} ` +
      `[auth-hint: token may be expired. Idle stream retries force-refresh credentials; ` +
      `if this persists run /login cursor or check /cursor.doctor tokenSource.]`
    );
  }
  if (isContextOverflowMessage(message)) {
    return formatContextOverflowHint(message);
  }
  if (isAccountLimitMessage(message)) {
    return formatAccountLimitHint(message);
  }
  if (isProtocolMismatchMessage(message)) {
    return appendDriftDiagnostic(formatProtocolMismatchHint(message));
  }
  // Informational unknown fields accumulate on long sessions. Stapling them onto a
  // Connect `internal` abort made a transport retry look like a schema mismatch.
  if (TRANSIENT_CONNECT_RE.test(message)) {
    return message;
  }
  return appendDriftDiagnostic(message);
}
