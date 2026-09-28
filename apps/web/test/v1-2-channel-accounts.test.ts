/**
 * V1.2 Channel Accounts vocabulary and enrichment-funnel presentation.
 *
 * **Why these assertions exist.** V1.2 renames a product surface — "Outreach
 * Identities" became "Channel Accounts" — while the storage deliberately did not
 * move: the rows are still `public.outreach_identities`, the RLS policy is still
 * `identity_visible`, and the Companion's LinkedIn binding still reads the same
 * table. Two failure modes follow from that and neither is visible in a screenshot:
 *
 *   1. **The legacy `platform` column is mistaken for the channel.** Migration 0030
 *      added `channel` and backfilled it *from* `platform`, so for a LinkedIn-era
 *      row the two agree and either one looks right. They diverge exactly where it
 *      matters — a Twitter-era row has `channel = 'other'` and `platform = 'twitter'`
 *      — and printing the platform as the channel would tell an operator that an
 *      account sends somewhere it cannot.
 *   2. **The enrichment funnel is presented in the wrong order.** The funnel is a
 *      pipeline, so its order is meaning, not styling. Sorting it by count would put
 *      `FAILED` above `NEEDS_PROFILE` in a business with several failures and make
 *      the page read as a ranking rather than a progression.
 *
 * The module under test touches no database and no clock, which is what makes both
 * assertable here rather than only through a rendered screen.
 */
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_ACCOUNT_CHANNELS,
  CHANNEL_LABELS,
  CHANNEL_ORDER,
  ENRICHMENT_STATE_ORDER,
  activityKindAccent,
  activityKindLabel,
  activityLink,
  agentJobStatusAccent,
  agentJobStatusLabel,
  channelLabel,
  enrichmentStateAccent,
  enrichmentStateLabel,
  isChannelAccountChannel,
  legacyPlatformLabel,
} from '@/lib/channel-vocabulary';
import { ENRICHMENT_STATES, OUTREACH_CHANNELS } from '@nexus/core';

describe('channel vocabulary', () => {
  it('offers every V1.2 outreach channel, plus the legacy "other" bucket', () => {
    for (const channel of OUTREACH_CHANNELS) {
      expect(CHANNEL_ACCOUNT_CHANNELS).toContain(channel);
    }
    // `other` is not a channel the product schedules on; migration 0030 maps the
    // legacy `twitter` platform onto it so a pre-V1.2 row survives the vocabulary
    // change without being relabelled as something it never was.
    expect(CHANNEL_ACCOUNT_CHANNELS).toContain('other');
    expect(CHANNEL_ACCOUNT_CHANNELS).toHaveLength(OUTREACH_CHANNELS.length + 1);
  });

  it('lists channels in a fixed order, with the legacy bucket last', () => {
    expect(CHANNEL_ORDER).toEqual([...OUTREACH_CHANNELS, 'other']);
    expect(CHANNEL_ORDER[CHANNEL_ORDER.length - 1]).toBe('other');
  });

  it('names every channel it accepts', () => {
    for (const channel of CHANNEL_ACCOUNT_CHANNELS) {
      expect(CHANNEL_LABELS[channel].length).toBeGreaterThan(0);
    }
    expect(CHANNEL_LABELS.linkedin).toBe('LinkedIn');
    expect(CHANNEL_LABELS.email).toBe('Email');
    expect(CHANNEL_LABELS.instagram).toBe('Instagram');
    expect(CHANNEL_LABELS.upwork).toBe('Upwork');
  });

  it('recognises only the channels it knows', () => {
    expect(isChannelAccountChannel('linkedin')).toBe(true);
    expect(isChannelAccountChannel('other')).toBe(true);
    expect(isChannelAccountChannel('twitter')).toBe(false);
    expect(isChannelAccountChannel(null)).toBe(false);
    expect(isChannelAccountChannel('')).toBe(false);
  });

  it('displays an unknown channel verbatim rather than coercing it to "other"', () => {
    // A value written by a later migration must stay legible, not be silently
    // rewritten: "other" is a specific historical claim, not a fallback.
    expect(channelLabel('tiktok')).toBe('tiktok');
    expect(channelLabel(null)).toBe('Unknown channel');
    expect(channelLabel('')).toBe('Unknown channel');
  });
});

describe('legacy platform is history, never the channel', () => {
  it('hides the platform when it says nothing the channel does not', () => {
    expect(legacyPlatformLabel('linkedin', 'linkedin')).toBeNull();
    expect(legacyPlatformLabel('email', 'email')).toBeNull();
    expect(legacyPlatformLabel(null, 'linkedin')).toBeNull();
    expect(legacyPlatformLabel('', 'linkedin')).toBeNull();
  });

  it('shows the platform when it disagrees with the channel', () => {
    // The Twitter-era row: channel `other`, platform `twitter`. Dropping this
    // would misreport what the account is.
    expect(legacyPlatformLabel('twitter', 'other')).toBe('legacy twitter');
    // A row created as an email account and later moved to Upwork.
    expect(legacyPlatformLabel('email', 'upwork')).toBe('legacy email');
  });

  it('shows the platform when the channel is unknown to this build', () => {
    expect(legacyPlatformLabel('twitter', 'tiktok')).toBe('legacy twitter');
  });
});

describe('enrichment funnel presentation', () => {
  it('orders states as a pipeline, not as a ranking', () => {
    expect(ENRICHMENT_STATE_ORDER[0]).toBe('MINIMAL');
    // Every V1.2 enrichment state appears exactly once, so a state cannot be
    // dropped from the funnel by a later edit.
    expect([...ENRICHMENT_STATE_ORDER].sort()).toEqual([...ENRICHMENT_STATES].sort());
    expect(new Set(ENRICHMENT_STATE_ORDER).size).toBe(ENRICHMENT_STATE_ORDER.length);
    // `READY` sits after the pending states: the funnel reads towards readiness.
    expect(ENRICHMENT_STATE_ORDER.indexOf('READY')).toBeGreaterThan(
      ENRICHMENT_STATE_ORDER.indexOf('AGENT_RESEARCH_PENDING'),
    );
    expect(ENRICHMENT_STATE_ORDER.indexOf('FAILED')).toBe(ENRICHMENT_STATE_ORDER.length - 1);
  });

  it('labels every state with prose, not the raw enum', () => {
    for (const state of ENRICHMENT_STATES) {
      const label = enrichmentStateLabel(state);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain('_');
    }
    expect(enrichmentStateLabel('READY')).toBe('Ready for outreach');
    expect(enrichmentStateLabel('AI_PROCESSING')).toBe('AI processing');
  });

  it('gives readiness and failure the accents their semantics require', () => {
    // spec `status_accents`: green = ready, red = failed.
    expect(enrichmentStateAccent('READY')).toBe('green');
    expect(enrichmentStateAccent('FAILED')).toBe('red');
    // A state that is waiting on work is amber rather than green, so "pending"
    // never reads as "done" on a colour-only scan.
    expect(enrichmentStateAccent('AGENT_RESEARCH_PENDING')).toBe('amber');
    expect(enrichmentStateAccent('AI_PROCESSING')).toBe('amber');
  });
});

describe('agent job status presentation', () => {
  it('labels every status the queue can hold', () => {
    expect(agentJobStatusLabel('OPEN')).toBe('Open');
    expect(agentJobStatusLabel('RUNNING')).toBe('Running');
    expect(agentJobStatusLabel('WAITING_AI')).toBe('Waiting AI');
    expect(agentJobStatusLabel('COMPLETE')).toBe('Complete');
    expect(agentJobStatusLabel('FAILED')).toBe('Failed');
    expect(agentJobStatusLabel('CANCELLED')).toBe('Cancelled');
  });

  it('distinguishes a finished job from a queued one by accent', () => {
    expect(agentJobStatusAccent('COMPLETE')).toBe('green');
    expect(agentJobStatusAccent('FAILED')).toBe('red');
    expect(agentJobStatusAccent('WAITING_AI')).toBe('amber');
    expect(agentJobStatusAccent('OPEN')).not.toBe('green');
  });
});

describe('activity feed links', () => {
  const businessKey = 'zemnas';

  it('links a signal to the lead it was observed against', () => {
    expect(activityLink('signal', 'lead-1', businessKey)).toEqual({
      href: '/b/zemnas/leads/lead-1',
      label: 'Open lead',
    });
  });

  it('links an agent job row to the queue screen, not to a lead', () => {
    expect(activityLink('agent_job', null, businessKey)).toEqual({
      href: '/b/zemnas/agent-jobs',
      label: 'Agent jobs',
    });
  });

  it('refuses to link an audit row, whose entity may not be a lead', () => {
    // `audit_events.entity_id` is a generic id. Linking it as a lead would open
    // the wrong record — plain text is the honest rendering.
    expect(activityLink('audit', 'entity-1', businessKey)).toBeNull();
  });

  it('refuses to link a row with no record behind it', () => {
    expect(activityLink('interaction', null, businessKey)).toBeNull();
    expect(activityLink('signal', '', businessKey)).toBeNull();
  });

  it('names and accents each feed', () => {
    expect(activityKindLabel('audit')).toBe('audit');
    expect(activityKindLabel('interaction')).toBe('timeline');
    expect(activityKindLabel('signal')).toBe('signal');
    expect(activityKindLabel('agent_job')).toBe('agent job');
    expect(activityKindAccent('signal')).toBe('cyan');
    expect(activityKindAccent('agent_job')).toBe('indigo');
  });
});
