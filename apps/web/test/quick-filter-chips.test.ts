/**
 * The Leads quick-filter chips.
 *
 * Each chip is a link that promises two things that must agree: the **count** it displays, and the
 * **filter** it opens. A chip that renders `Replied 2` and then links to a query matching nothing is
 * worse than no chip at all — the operator is told there is work to do and then shown an empty
 * table.
 *
 * That is not hypothetical. Every chip used to send its key with the value `1`, which is correct for
 * the boolean filters and wrong for the two that select a lifecycle status: "Replied" emitted
 * `?status=1` while its active-state check looked for `status === 'replied'`, so it could never be
 * both correct and highlighted. These tests pin the distinction down at the level where the value is
 * declared, because the page itself is a server component with no DOM environment in this suite.
 */
import { describe, expect, it } from 'vitest';

import { FILTER_PARAM_KEYS } from '@/lib/filter-url';
import { QUICK_FILTER_CHIPS, QUICK_FILTER_KEYS, chipIsActive } from '@/lib/quick-filter-chips';

const STATUS_KEY = 'status';

describe('quick-filter chip definitions', () => {
  it('gives every chip a distinct key, so two chips sharing a filter key stay distinct', () => {
    const keys = QUICK_FILTER_CHIPS.map((chip) => chip.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses only keys the filter model owns', () => {
    for (const chip of QUICK_FILTER_CHIPS) {
      for (const key of Object.keys(chip.set)) {
        expect(FILTER_PARAM_KEYS).toContain(key);
      }
    }
  });

  it('sets exactly one filter key per chip', () => {
    for (const chip of QUICK_FILTER_CHIPS) {
      expect(Object.keys(chip.set)).toHaveLength(1);
    }
  });

  it('expresses a status chip as a status VALUE, never as the flag "1"', () => {
    const statusChips = QUICK_FILTER_CHIPS.filter((chip) => STATUS_KEY in chip.set);
    // The two status chips are Replied and Dormant; both must carry a real status.
    expect(statusChips).toHaveLength(2);
    for (const chip of statusChips) {
      const value = chip.set[STATUS_KEY];
      expect(value).toBeTypeOf('string');
      // `1` is the exact wrong value: it is a flag, not a lifecycle status.
      expect(value).not.toBe('1');
      expect(value?.length ?? 0).toBeGreaterThan(1);
    }
  });

  it('names the statuses the leads model actually uses', () => {
    const values = QUICK_FILTER_CHIPS.map((chip) => chip.set[STATUS_KEY]).filter((v) => v !== undefined);
    expect(values).toContain('replied');
    expect(values).toContain('dormant');
  });

  it('expresses the boolean filters as the flag "1"', () => {
    for (const key of ['followups', 'needsProfile', 'dnc'] as const) {
      const chip = QUICK_FILTER_CHIPS.find((candidate) => key in candidate.set);
      expect(chip, `no chip sets ${key}`).toBeDefined();
      expect(chip?.set[key]).toBe('1');
    }
  });

  it('counts every chip from a distinct LeadCounts field', () => {
    const countKeys = QUICK_FILTER_CHIPS.map((chip) => chip.countKey);
    expect(new Set(countKeys).size).toBe(countKeys.length);
  });

  it('clears the other chip filters, including the saved view, when a chip is activated', () => {
    for (const key of ['status', 'needsProfile', 'dnc', 'followups', 'needsAttention', 'view'] as const) {
      expect(QUICK_FILTER_KEYS).toContain(key);
    }
  });
});

describe('chipIsActive', () => {
  it('is true only for the chip whose exact filter value is present', () => {
    const replied = QUICK_FILTER_CHIPS.find((chip) => chip.set[STATUS_KEY] === 'replied');
    expect(replied).toBeDefined();
    expect(chipIsActive(replied!, { status: 'replied' })).toBe(true);
    expect(chipIsActive(replied!, { status: 'dormant' })).toBe(false);
    expect(chipIsActive(replied!, { status: '1' })).toBe(false);
    expect(chipIsActive(replied!, {})).toBe(false);
  });

  it('agrees with the link the chip generates — the same payload drives both', () => {
    for (const chip of QUICK_FILTER_CHIPS) {
      // The chip is active exactly when the query already equals what it would set.
      expect(chipIsActive(chip, chip.set)).toBe(true);
    }
  });
});
