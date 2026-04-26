const SEED_PHRASE_RE = /^[a-z]+(\s+[a-z]+){11,}$/;
const SSH_KEY_RE = /^ssh-(ed25519|rsa|ecdsa)\s/;
const API_TOKEN_RE = /\d{5,}:[A-Za-z0-9_-]{35,}/;
const SGNL_URL_RE = /^sgnl:\/\//;

export function isSensitive(body: string): boolean {
  const trimmed = body.trim();
  return !!trimmed && (SEED_PHRASE_RE.test(trimmed) || SSH_KEY_RE.test(trimmed) || API_TOKEN_RE.test(trimmed) || SGNL_URL_RE.test(trimmed));
}
