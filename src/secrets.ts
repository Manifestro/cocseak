/**
 * Shapes that are almost always credentials. These mirror KAP's redaction patterns: KAP keeps
 * secrets out of its own store, but a file cocseak commits goes into git, where KAP cannot reach.
 */
const SECRET_NAME =
  String.raw`(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|token|secret|password|passwd|authorization|credentials?)\b`;

const PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk)-[a-z0-9_-]{16,}/i,
  /\bhf_[A-Za-z0-9]{20,}\b/,
  /\brpa_[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

/** A credential named by its key; the last group is the value, checked by `isLiteral`. */
const NAMED: readonly RegExp[] = [
  new RegExp(String.raw`\b[A-Za-z0-9_.-]*${SECRET_NAME}["']?\s*[:=]\s*["']?([^\s"',;]{8,})`, "gi"),
  /\b(?:password|passwd)\s+([^\s"']{8,})/gi,
  new RegExp(String.raw`(?:^|\s)--?[a-z0-9-]*${SECRET_NAME}[=\s]+([^\s"']{4,})`, "gi"),
];

/**
 * Whether a value after a credential name is the credential rather than code that handles one:
 * `api_key=args.api_key`, `password=$GH_TOKEN`, and `token = os.environ.get(...)` are not keys.
 * Real keys carry digits; a letters-only password is the accepted miss. Same rule as KAP.
 */
export function isLiteral(value: string): boolean {
  if (/^[${<%(\[@`]/.test(value) || value.includes("(")) return false;
  if (!/[0-9]/.test(value)) return false;
  return !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(value);
}

/**
 * Runs long enough to be a key. `-`, `_`, `.` and `/` end a run, so item ids and paths never
 * form one. Same rule and threshold as KAP's redaction: on the dauys repository no ordinary run
 * reaches 4.0 bits per character, while 99.6% of random 32-character base62 keys do.
 */
const RANDOM_RUN = /[A-Za-z0-9+=]{32,}/g;
const RANDOM_ENTROPY_BITS = 4.0;

/** Whether a run looks like a generated key rather than a word, a hash, or a number. */
export function looksRandom(run: string): boolean {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9]/.test(run)) return false;
  const counts = new Map<string, number>();
  for (const char of run) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / run.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= RANDOM_ENTROPY_BITS;
}

/** Whether text holds something shaped like a credential. */
export function holdsCredential(text: string): boolean {
  if (PATTERNS.some((pattern) => pattern.test(text))) return true;
  for (const pattern of NAMED) {
    for (const match of text.matchAll(pattern)) {
      if (isLiteral(match[1] ?? "")) return true;
    }
  }
  for (const match of text.matchAll(RANDOM_RUN)) {
    if (looksRandom(match[0])) return true;
  }
  return false;
}
