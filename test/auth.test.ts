import { describe, it, expect } from 'vitest';
import { extractBearerToken } from '../src/server/auth.js';

describe('extractBearerToken', () => {
  it('extracts a token, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('BEARER   abc123')).toBe('abc123');
  });

  it('rejects missing, empty, or wrong-scheme headers', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Basic abc123')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearerabc123')).toBeUndefined();
    expect(extractBearerToken('Bearer    ')).toBeUndefined();
  });

  it('rejects tokens containing line breaks', () => {
    expect(extractBearerToken('Bearer abc\nDEF')).toBeUndefined();
  });

  it('handles long whitespace runs in linear time', () => {
    const start = Date.now();
    const hostile = 'Bearer' + ' '.repeat(200_000) + '\n';
    expect(extractBearerToken(hostile)).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
