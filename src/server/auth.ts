import { timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of two bearer tokens (avoids timing side-channels). */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) {
    // Still run a comparison so the false path takes comparable time to the
    // true path regardless of the (public, non-secret) length mismatch.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(a, b);
}

const BEARER_SCHEME = 'bearer';

/** Extracts a bearer token from an Authorization header value, if present. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  // Linear-time parse (no backtracking regex): scheme, at least one
  // whitespace character, then a non-empty single-line token.
  if (authorizationHeader.length <= BEARER_SCHEME.length) return undefined;
  if (authorizationHeader.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) {
    return undefined;
  }
  const rest = authorizationHeader.slice(BEARER_SCHEME.length);
  if (rest.trimStart().length === rest.length) return undefined;
  const token = rest.trimStart();
  if (token.length === 0 || /[\r\n\u2028\u2029]/.test(token)) return undefined;
  return token;
}
