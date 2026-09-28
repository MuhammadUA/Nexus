/**
 * The Agent Jobs screen's presentation rules, pinned without a browser or a database.
 *
 * These functions decide what an operator reads in the queue table, and two of them decide
 * something stronger than presentation:
 *
 *   * `rowOperationsFor` is the *only* source of the operations a row offers. "There is no
 *     manual complete" (spec §70.4) is therefore not a promise about a button's absence — it
 *     is a property of this function, and these tests assert it for every status.
 *   * `leaseState` decides whether a claim reads as `expired`, which is the state an operator
 *     acts on. An off-by-one at the boundary would offer "Release claim" on a lease that is
 *     still live, taking work away from an agent that is still working.
 *
 * The module they live in also renders the interactive controls, but the helpers are exported
 * separately so they can be exercised here without a React tree.
 */
import { describe, expect, it } from 'vitest';

import { AGENT_JOB_STATUSES, AGENT_JOB_TYPES } from '@nexus/core';

import {
  JOB_ROW_OPERATIONS,
  canCancel,
  canRetry,
  humaniseJobType,
  jobPriorityAccent,
  jobStatusAccent,
  jobStatusLabel,
  leaseDetail,
  leaseState,
  minutesLabel,
  rowOperationsFor,
  shortTimestamp,
} from '@/components/agent-job-forms';

const NOW = new Date('2026-02-03T12:00:00.000Z');

function at(offsetMinutes: number): string {
  return new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();
}

describe('rowOperationsFor', () => {
  it('never offers a way to complete a job, for any status or lease state', () => {
    for (const status of AGENT_JOB_STATUSES) {
      for (const leaseExpired of [true, false]) {
        const operations = rowOperationsFor(status, leaseExpired);
        expect(operations).not.toContain('complete');
        for (const operation of operations) {
          expect(JOB_ROW_OPERATIONS).toContain(operation);
        }
      }
    }
  });

  it('declares exactly retry, cancel and release as its vocabulary', () => {
    expect([...JOB_ROW_OPERATIONS]).toEqual(['retry', 'cancel', 'release']);
  });

  it('offers retry only on the two terminal-but-recoverable statuses', () => {
    expect(rowOperationsFor('FAILED', false)).toContain('retry');
    expect(rowOperationsFor('CANCELLED', false)).toContain('retry');
    for (const status of ['OPEN', 'RUNNING', 'WAITING_AI', 'COMPLETE'] as const) {
      expect(rowOperationsFor(status, false)).not.toContain('retry');
    }
  });

  it('offers release only for a RUNNING job whose lease has lapsed', () => {
    expect(rowOperationsFor('RUNNING', true)).toContain('release');
    expect(rowOperationsFor('RUNNING', false)).not.toContain('release');
    // A live-status job with no lease (OPEN) has nothing to release, and a terminal job never does.
    expect(rowOperationsFor('OPEN', true)).not.toContain('release');
    expect(rowOperationsFor('WAITING_AI', true)).not.toContain('release');
    expect(rowOperationsFor('FAILED', true)).not.toContain('release');
  });

  it('offers nothing at all on a completed job', () => {
    expect(rowOperationsFor('COMPLETE', true)).toEqual([]);
    expect(rowOperationsFor('COMPLETE', false)).toEqual([]);
  });
});

describe('canRetry / canCancel', () => {
  it('agrees with the database: only FAILED and CANCELLED can be retried', () => {
    const retryable = AGENT_JOB_STATUSES.filter((status) => canRetry(status));
    expect([...retryable].sort()).toEqual(['CANCELLED', 'FAILED']);
  });

  it('cancels only work that still has work ahead of it', () => {
    const cancellable = AGENT_JOB_STATUSES.filter((status) => canCancel(status));
    expect([...cancellable].sort()).toEqual(['OPEN', 'RUNNING', 'WAITING_AI']);
  });
});

describe('leaseState', () => {
  it('treats a missing or unparseable lease as no lease rather than as expired', () => {
    expect(leaseState(null, NOW)).toBe('none');
    expect(leaseState('', NOW)).toBe('none');
    expect(leaseState('not-a-date', NOW)).toBe('none');
  });

  it('treats a lease that expires exactly now as expired', () => {
    expect(leaseState(NOW.toISOString(), NOW)).toBe('expired');
  });

  it('keeps a lease one minute in the future live', () => {
    expect(leaseState(at(1), NOW)).toBe('live');
    expect(leaseState(at(-1), NOW)).toBe('expired');
  });

  it('states the state in words, so it is never colour alone', () => {
    expect(leaseDetail(at(-4), NOW)).toBe('expired 4m ago');
    expect(leaseDetail(at(12), NOW)).toBe('expires in 12m');
    expect(leaseDetail(null, NOW)).toBe('no lease');
  });
});

describe('minutesLabel', () => {
  it('reads as minutes, hours and days without inventing precision', () => {
    expect(minutesLabel(0)).toBe('0m');
    expect(minutesLabel(59)).toBe('59m');
    expect(minutesLabel(60)).toBe('1h 0m');
    expect(minutesLabel(125)).toBe('2h 5m');
    expect(minutesLabel(60 * 24)).toBe('1d 0h');
    expect(minutesLabel(-30)).toBe('30m');
  });
});

describe('status presentation', () => {
  it('has a label and an accent for every status, so no cell can render blank', () => {
    for (const status of AGENT_JOB_STATUSES) {
      expect(jobStatusLabel(status).length).toBeGreaterThan(1);
      expect(jobStatusAccent(status).length).toBeGreaterThan(1);
    }
  });

  it('distinguishes the two states that look alike without colour', () => {
    // WAITING_AI is waiting on the pipeline; CANCELLED is terminal and quiet. Different
    // accents and different words, so the two are never confused at a glance.
    expect(jobStatusLabel('WAITING_AI')).not.toBe(jobStatusLabel('CANCELLED'));
    expect(jobStatusAccent('WAITING_AI')).not.toBe(jobStatusAccent('CANCELLED'));
  });
});

describe('priority presentation', () => {
  it('keeps routine work neutral and reserves the loud accents for urgency', () => {
    expect(jobPriorityAccent('normal')).toBe('neutral');
    expect(jobPriorityAccent('low')).toBe('neutral');
    expect(jobPriorityAccent('high')).toBe('amber');
    expect(jobPriorityAccent('urgent')).toBe('red');
  });
});

describe('humaniseJobType', () => {
  it('turns the enum into a sentence case label', () => {
    expect(humaniseJobType('RESEARCH_COMPANY')).toBe('Research company');
    expect(humaniseJobType('QUALIFY_LEAD')).toBe('Qualify lead');
    expect(humaniseJobType('OTHER')).toBe('Other');
  });

  it('names every job type, so the type filter can never render an empty option', () => {
    for (const jobType of AGENT_JOB_TYPES) {
      expect(humaniseJobType(jobType).length).toBeGreaterThan(1);
    }
  });
});

describe('shortTimestamp', () => {
  it('renders the stored instant to the minute, and an em dash when there is none', () => {
    expect(shortTimestamp('2026-02-03T09:41:07.123Z')).toBe('2026-02-03 09:41');
    expect(shortTimestamp(null)).toBe('—');
    expect(shortTimestamp('')).toBe('—');
  });
});
