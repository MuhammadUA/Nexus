/**
 * Query-parameter limit handling for the companion list routes.
 *
 * These cover a real defect rather than a hypothetical. `GET /api/v1/companion/leads` and
 * `GET /api/v1/companion/search` read their optional `limit` as
 * `clampLimit(Number(params.get('limit') ?? ''), fallback, max)`. An absent parameter makes
 * `params.get()` return `null`, so the `?? ''` yields the empty string, and `Number('')` is **`0`**
 * — not `NaN`. `clampLimit` therefore took its finite branch and clamped `0` up to its minimum of
 * **1**.
 *
 * The consequence was invisible from the outside: the Companion panel never sends a `limit`, so the
 * lead list answered `200 {"total":24,"leads":[…one row…]}`. Every list in the panel could show only
 * a single lead, which in turn made the follow-up and dormant focus screens unreachable. No existing
 * case caught it because the verification harness always passed an explicit `limit`.
 *
 * The fix distinguishes "absent" from "zero", which is what these tests pin down.
 */
import { describe, expect, it } from 'vitest';

import { clampLimit, optionalLimit } from '@/app/api/v1/_lib/http';

describe('optionalLimit', () => {
  it('treats a missing parameter as absent, not as zero', () => {
    expect(optionalLimit(null)).toBeUndefined();
  });

  it('treats an empty value as absent', () => {
    expect(optionalLimit('')).toBeUndefined();
    expect(optionalLimit('   ')).toBeUndefined();
  });

  it('treats zero and negatives as absent rather than clamping them to 1', () => {
    expect(optionalLimit('0')).toBeUndefined();
    expect(optionalLimit('-5')).toBeUndefined();
  });

  it('treats a non-numeric value as absent', () => {
    expect(optionalLimit('abc')).toBeUndefined();
  });

  it('returns a supplied positive limit', () => {
    expect(optionalLimit('5')).toBe(5);
    expect(optionalLimit(' 25 ')).toBe(25);
    expect(optionalLimit('1')).toBe(1);
  });
});

describe('the absent-limit regression', () => {
  it('an absent limit resolves to the route default, never to one row', () => {
    // This is the exact expression the leads route used to perform.
    const before = clampLimit(Number(null ?? ''), 50, 100);
    expect(before).toBe(1);

    // And the expression it performs now.
    const after = clampLimit(optionalLimit(null), 50, 100);
    expect(after).toBe(50);
  });

  it('the search route default is likewise preserved', () => {
    expect(clampLimit(optionalLimit(null), 25, 50)).toBe(25);
  });

  it('still refuses an unbounded client value', () => {
    expect(clampLimit(optionalLimit('100000'), 50, 100)).toBe(100);
  });
});

describe('clampLimit', () => {
  it('falls back when the value is not finite', () => {
    expect(clampLimit(Number.NaN, 50)).toBe(50);
    expect(clampLimit(undefined, 50)).toBe(50);
    expect(clampLimit(Number.POSITIVE_INFINITY, 50)).toBe(50);
  });

  it('clamps a finite value into range', () => {
    expect(clampLimit(0, 50)).toBe(1);
    expect(clampLimit(-3, 50)).toBe(1);
    expect(clampLimit(25, 50, 100)).toBe(25);
    expect(clampLimit(500, 50, 100)).toBe(100);
  });

  it('truncates a fractional value', () => {
    expect(clampLimit(12.9, 50)).toBe(12);
  });
});
