import * as React from 'react';

/**
 * §69.1 item 6 — the OUTREACH section of Lead Detail, and its pure row model.
 *
 * The two rules this module exists to keep are §20.1 and §20.3:
 *
 *   * a **discovery source never dictates an outreach channel** — the rows are computed
 *     from the accounts the business holds and the contact points the person has, and the
 *     discovery source is passed through only to be *displayed* as such;
 *   * an **outreach channel never implies a discovery source**, so nothing here reads the
 *     source to decide availability.
 *
 * The worked examples in §20.2 are the acceptance tests: a Reddit-discovered lead with an
 * email contact point and an email account is an email lead, and `channelOutreachRows`
 * returns exactly the same rows for it as it would for a LinkedIn-discovered lead with the
 * same accounts and contact points.
 *
 * Contact-point precedence follows §26.2 (confirmed wins, then confidence, then the most
 * recently observed) and §26.4 requires confirmed, extracted and imported to look different
 * on screen — the component renders the state as text, never by colour alone.
 */
import { OUTREACH_CHANNELS, type OutreachChannel } from '@nexus/core';
import { Card, Chip, Row, Stack } from '@nexus/ui';

import { outreachChannelLabel } from './lead-intelligence-brief';

export interface ChannelAccountView {
  readonly channel: string;
  readonly displayName: string;
  readonly status: string;
}

export interface ContactPointView {
  readonly kind: string;
  readonly value: string;
  readonly isPrimary: boolean;
  readonly confirmedByUser: boolean;
  readonly confidence: number;
  readonly source: string | null;
  readonly observedAt: string;
}

export interface ChannelOutreachInput {
  /** Channels derived from accounts + contact points. Never from the discovery source. */
  readonly availableChannels: readonly OutreachChannel[];
  readonly accounts: readonly ChannelAccountView[];
  readonly contactPoints: readonly ContactPointView[];
  readonly discoverySource: string;
  /** What happens next for this lead, from the sequence/next-action rows. */
  readonly nextAction: string | null;
  readonly sequenceState: string | null;
  readonly isDnc: boolean;
}

export interface ChannelOutreachRow {
  readonly channel: OutreachChannel;
  readonly label: string;
  readonly account: ChannelAccountView | null;
  readonly contact: ContactPointView | null;
  /** Which half is absent, in the operator's words. Empty when both are present. */
  readonly missing: readonly string[];
  readonly nextAction: string;
}

/**
 * The winning contact point for one channel, by §26.2 precedence.
 *
 * Ties are broken by the row order the caller supplied (the query orders by `is_primary`
 * then `observed_at desc`), so the result is deterministic without a clock.
 */
export function winningContactPoint(
  channel: OutreachChannel,
  contactPoints: readonly ContactPointView[],
): ContactPointView | null {
  const candidates = contactPoints.filter((point) => point.kind === channel);
  if (candidates.length === 0) return null;

  const confirmed = candidates.filter((point) => point.confirmedByUser);
  const pool = confirmed.length > 0 ? confirmed : candidates;
  return pool.reduce((best, point) => (point.confidence > best.confidence ? point : best));
}

/** The account a business would send from on one channel: the first non-retired one. */
export function accountForChannel(
  channel: OutreachChannel,
  accounts: readonly ChannelAccountView[],
): ChannelAccountView | null {
  return accounts.find((account) => account.channel === channel && account.status !== 'retired') ?? null;
}

/** How a contact point reads: confirmed, extracted or imported (§26.4). */
export function contactPointProvenanceLabel(point: ContactPointView): 'confirmed' | 'imported' | 'extracted' {
  if (point.confirmedByUser) return 'confirmed';
  return point.source === 'manual' ? 'imported' : 'extracted';
}

/**
 * One row per V1.2 channel, in vocabulary order.
 *
 * A channel with no account or no contact point says **which** is missing, because "email
 * unavailable" is not actionable and §20.4 forbids phrasing the reason as a source.
 */
export function channelOutreachRows(input: ChannelOutreachInput): readonly ChannelOutreachRow[] {
  const available = new Set<string>(input.availableChannels);

  return OUTREACH_CHANNELS.map((channel) => {
    const account = accountForChannel(channel, input.accounts);
    const contact = winningContactPoint(channel, input.contactPoints);
    const missing: string[] = [];
    if (account === null) missing.push('no channel account');
    if (contact === null) missing.push('no contact point');
    if (missing.length === 0 && !available.has(channel)) missing.push('not currently available');

    const nextAction =
      missing.length > 0
        ? missing.join(' and ')
        : input.isDnc
          ? 'suppressed — do not contact'
          : input.sequenceState === null
            ? 'not enrolled in a sequence'
            : (input.nextAction ?? 'no next action scheduled');

    return { channel, label: outreachChannelLabel(channel), account, contact, missing, nextAction };
  });
}

export interface LeadChannelOutreachProps {
  readonly rows: readonly ChannelOutreachRow[];
  readonly discoverySource: string;
  readonly isDnc: boolean;
}

/**
 * §69.1 item 6 — the outreach panel: account, state and next action per channel.
 *
 * The last line is deliberate: it states the independence of source and channel, which is
 * the one thing an operator coming from a Reddit-sourced lead needs to be told.
 */
export function LeadChannelOutreach({
  rows,
  discoverySource,
  isDnc,
}: LeadChannelOutreachProps): React.ReactElement {
  return (
    <Card
      title="Outreach"
      actions={
        <Row wrap>
          <Chip accent="indigo">discovery source: {discoverySource}</Chip>
          {isDnc && <Chip accent="red">DNC</Chip>}
        </Row>
      }
    >
      <Stack size="sm">
        {rows.map((row) => (
          <div key={row.channel} className="nx-channel-row" data-state={row.missing.length > 0 ? 'blocked' : 'ready'}>
            <Row between wrap>
              <Row wrap>
                <strong className="nx-channel-row__name">{row.label}</strong>
                {row.account === null ? (
                  <Chip accent="amber">no account</Chip>
                ) : (
                  <Chip accent={row.account.status === 'active' ? 'green' : 'amber'}>
                    {row.account.displayName} · {row.account.status}
                  </Chip>
                )}
                {row.contact !== null && (
                  <Chip accent={row.contact.confirmedByUser ? 'green' : 'cyan'}>
                    {contactPointProvenanceLabel(row.contact)}
                  </Chip>
                )}
              </Row>
              <span className="nx-hint">{row.nextAction}</span>
            </Row>
            {row.contact !== null && (
              <Row wrap>
                <code className="nx-channel-row__value">{row.contact.value}</code>
                <span className="nx-hint">confidence {row.contact.confidence.toFixed(2)}</span>
                {row.contact.isPrimary && <Chip accent="indigo">primary</Chip>}
              </Row>
            )}
          </div>
        ))}
        <p className="nx-hint">
          The discovery source records where this lead came from; it never restricts how you may
          contact them. A channel is available when the business holds an account on it and the
          person has a contact point for it.
        </p>
      </Stack>
    </Card>
  );
}
