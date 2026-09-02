// redact(text, secrets) is applied at the single serialisation point of every orchestrator
// (the log sink and the run-file writer), so nothing that reaches stdout, a saved run or an
// error message carries a credential. Pattern-based for the shapes this store can leak
// (cookies, the storefront password, preview keys, cart tokens, Admin tokens) plus the caller's
// explicit secret values.

const PATTERNS = [
  // Header forms, any case, header value to end of line.
  [/\b(cookie|set-cookie|authorization|x-shopify-access-token)\s*[:=]\s*[^\n]*/gi, '$1: [redacted]'],
  // Query or form params that carry credentials.
  [/([?&;]|\b)(password|key|token|access_token|cart|checkout_token|_secure_session_id|_shopify_s|_shopify_y|preview_theme_id_bypass)=([^&\s"'<>]+)/gi, '$1$2=[redacted]'],
  // Shopify cart and checkout tokens in paths.
  [/\/cart\/c\/[A-Za-z0-9_-]+/g, '/cart/c/[redacted]'],
  [/\/checkouts\/[A-Za-z0-9_/-]+/g, '/checkouts/[redacted]'],
  // Cart token and line keys in JSON bodies.
  [/("token"\s*:\s*")[^"]*(")/g, '$1[redacted]$2'],
  [/("key"\s*:\s*")[^"]*(")/g, '$1[redacted]$2'],
  // Admin API tokens and app secrets.
  [/\bshp(?:at|ca|ss|pa)_[A-Za-z0-9]+/g, '[redacted-token]'],
  // Bearer tokens.
  [/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]'],
];

/**
 * @param {unknown} text
 * @param {string[]} [secrets] literal values to strip (password, client secret, minted token)
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length > 0) out = out.split(s).join('[redacted]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Bind a secret list once; the orchestrator wraps its log sink with the result. */
export function createRedactor(secrets = []) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  return (text) => redact(text, list);
}
