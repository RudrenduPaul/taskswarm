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

/** Extracts a bearer token from an Authorization header value, if present. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  return match?.[1];
}
