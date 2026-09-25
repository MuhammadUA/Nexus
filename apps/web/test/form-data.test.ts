/**
 * Form-value readers.
 *
 * These cover two bugs that were found by exercising the real login form and that
 * would otherwise reappear silently:
 *
 *   1. React renders `defaultValue` on an input as an extra hidden `<input>`, so a
 *      field is submitted **twice** — first with the default (`""`), then with what the
 *      operator typed. `FormData.get()` returns the first entry, so a naive read got
 *      the empty default and Zod rejected a perfectly good submission. `formString`
 *      takes the operator's value.
 *   2. `FormData.get()` returns `string | File | null`, so `String(...)` on it yields
 *      `"[object Object]"` for a file field — a value that would then flow into a UUID
 *      check or a SQL parameter as though it were real input.
 */
import { describe, expect, it } from 'vitest';

import { formBool, formString, formStringOrNull, formStrings } from '@/lib/form-data';

/** Builds a FormData carrying duplicate keys, the way React's `defaultValue` does. */
function withDuplicate(name: string, first: string, second: string): FormData {
  const data = new FormData();
  data.append(name, first);
  data.append(name, second);
  return data;
}

describe('formString', () => {
  it('prefers the operator value over the defaultValue shadow input', () => {
    const data = withDuplicate('email', '', 'operator@nexus.test');
    expect(formString(data, 'email')).toBe('operator@nexus.test');
  });

  it('skips an empty shadow input even when it comes last', () => {
    const data = withDuplicate('email', 'operator@nexus.test', '');
    expect(formString(data, 'email')).toBe('operator@nexus.test');
  });

  it('returns the last value when every entry is empty, so a cleared field stays cleared', () => {
    const data = withDuplicate('notes', '', '');
    expect(formString(data, 'notes')).toBe('');
  });

  it('falls back when the field is absent', () => {
    expect(formString(new FormData(), 'missing', 'fallback')).toBe('fallback');
    expect(formString(new FormData(), 'missing')).toBe('');
  });

  it('reads a single value unchanged', () => {
    const data = new FormData();
    data.append('fullName', 'Smoke Admin');
    expect(formString(data, 'fullName')).toBe('Smoke Admin');
  });

  it('throws on a file rather than coercing it to "[object Object]"', () => {
    const data = new FormData();
    data.append('avatar', new File(['contents'], 'avatar.txt', { type: 'text/plain' }));
    expect(() => formString(data, 'avatar')).toThrow(/submitted as a file/i);
  });
});

describe('formStringOrNull', () => {
  it('maps a missing or empty field to null, preserving `get` semantics for Zod', () => {
    expect(formStringOrNull(new FormData(), 'missing')).toBeNull();
    expect(formStringOrNull(withDuplicate('notes', '', ''), 'notes')).toBeNull();
  });

  it('returns the operator value when present', () => {
    expect(formStringOrNull(withDuplicate('notes', '', 'keep me'), 'notes')).toBe('keep me');
  });
});

describe('formStrings', () => {
  it('de-duplicates so a shadow input cannot double-count a checkbox', () => {
    const data = new FormData();
    data.append('scopes', 'lead:read');
    data.append('scopes', 'lead:read');
    data.append('scopes', 'note:add');
    expect(formStrings(data, 'scopes')).toEqual(['lead:read', 'note:add']);
  });

  it('drops empty entries', () => {
    const data = new FormData();
    data.append('businessIds', '');
    data.append('businessIds', 'a0000000-0000-4000-8000-000000000001');
    expect(formStrings(data, 'businessIds')).toEqual(['a0000000-0000-4000-8000-000000000001']);
  });

  it('returns an empty array when nothing was selected', () => {
    expect(formStrings(new FormData(), 'scopes')).toEqual([]);
  });
});

describe('formBool', () => {
  it('treats the checkbox encodings as true', () => {
    for (const value of ['on', 'true', '1']) {
      const data = new FormData();
      data.append('flag', value);
      expect(formBool(data, 'flag')).toBe(true);
    }
  });

  it('treats absent and other values as false', () => {
    expect(formBool(new FormData(), 'flag')).toBe(false);
    const data = new FormData();
    data.append('flag', 'off');
    expect(formBool(data, 'flag')).toBe(false);
  });

  it('reads the operator value when a shadow input precedes it', () => {
    expect(formBool(withDuplicate('flag', '', 'on'), 'flag')).toBe(true);
  });
});
