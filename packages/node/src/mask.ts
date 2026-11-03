/**
 * Hide secrets before anything leaves the app: error messages and stack
 * traces can contain tokens, passwords, emails or connection strings.
 */
const RULES: [RegExp, string][] = [
  // URLs with credentials: postgres://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1***:***@"],
  // Bearer / Basic tokens
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***"],
  // key=value style secrets
  [/\b([A-Za-z0-9_-]*(?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key|auth)[A-Za-z0-9_-]*)\s*[=:]\s*["']?[^\s"',;]{3,}/gi, "$1=***"],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "***jwt***"],
  // well-known key shapes (Stripe, GitHub, AWS, Slack, Google)
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, "***key***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "***key***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***key***"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "***key***"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "***key***"],
  // emails
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "***@***"],
  // long hex or base64 blobs (secrets, hashes)
  [/\b[0-9a-f]{40,}\b/gi, "***"],
  [/\b[A-Za-z0-9+/]{48,}={0,2}/g, "***"],
];

export function mask(text: string, max = 4000): string {
  let out = text.length > max * 2 ? text.slice(0, max * 2) : text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
