/**
 * Domain-aware presentation components shared by the web app and the Companion.
 *
 * Status → accent mapping lives here, in one place, because spec
 * `design_system.layout_notes.status_accents` assigns fixed semantics
 * (cyan = new/connection/profile, green = ready/sent/replied/active,
 * amber = follow-up/due/cooldown, red = overdue/DNC/destructive,
 * indigo = business/ICP/configuration). A screen must never invent its own
 * colour for a state.
 *
 * Labels are always rendered alongside colour, so status is never conveyed by
 * colour alone (accessibility requirement).
 */
import type { ReactElement, ReactNode } from 'react';

import { Chip, Row, type AccentName } from './primitives.js';

/** Human labels for the spec's lead lifecycle states. */
const LEAD_STATE_LABELS: Readonly<Record<string, string>> = {
  new: 'New',
  needs_profile: 'Needs profile',
  ready: 'Ready',
  connection_due: 'Connection due',
  connection_sent: 'Connection sent',
  connection_accepted: 'Accepted',
  message_due: 'Message 1 due',
  followup_due: 'Follow-up due',
  replied: 'Replied',
  paused: 'Paused',
  cooldown: 'Cooldown',
  dormant: 'Dormant',
  reactivation_due: 'Reactivation due',
  interested: 'Interested',
  wrong_person: 'Wrong person',
  do_not_contact: 'Do not contact',
  archived: 'Archived',
  deleted: 'Deleted',
};

/** Accent per lifecycle state, per `status_accents`. */
const LEAD_STATE_ACCENTS: Readonly<Record<string, AccentName>> = {
  new: 'cyan',
  needs_profile: 'cyan',
  ready: 'green',
  connection_due: 'cyan',
  connection_sent: 'cyan',
  connection_accepted: 'green',
  message_due: 'green',
  followup_due: 'amber',
  replied: 'green',
  paused: 'neutral',
  cooldown: 'amber',
  dormant: 'neutral',
  reactivation_due: 'amber',
  interested: 'green',
  wrong_person: 'red',
  do_not_contact: 'red',
  archived: 'neutral',
  deleted: 'red',
};

export function leadStateLabel(state: string): string {
  return LEAD_STATE_LABELS[state] ?? state.replace(/_/g, ' ');
}

export function leadStateAccent(state: string): AccentName {
  return LEAD_STATE_ACCENTS[state] ?? 'neutral';
}

/** A lifecycle-status pill. Always shows the label, never colour alone. */
export function LeadStatusChip({ state }: { readonly state: string }): ReactElement {
  return (
    <Chip accent={leadStateAccent(state)} dataState={state}>
      {leadStateLabel(state)}
    </Chip>
  );
}

/** Message state chip: DYNAMIC may regenerate, LOCKED is frozen, SENT is history. */
export function MessageStateChip({ state }: { readonly state: 'DYNAMIC' | 'LOCKED' | 'SENT' }): ReactElement {
  const map: Record<typeof state, { accent: AccentName; label: string; title: string }> = {
    DYNAMIC: {
      accent: 'cyan',
      label: 'Dynamic',
      title: 'May be regenerated until it is sent',
    },
    LOCKED: {
      accent: 'amber',
      label: 'Locked',
      title: 'Manually edited or approved: never overwritten by a sequence publish',
    },
    SENT: {
      accent: 'green',
      label: 'Sent',
      title: 'Immutable historical content — corrections use new events, never overwrite',
    },
  };
  const entry = map[state];
  return (
    <Chip accent={entry.accent} title={entry.title} dataState={state}>
      {entry.label}
    </Chip>
  );
}

/** DNC badge — the strongest suppression in the product. */
export function DncChip({ channel }: { readonly channel?: string }): ReactElement {
  return (
    <Chip accent="red" title="Do Not Contact: suppressed across every outreach identity" dataState="dnc">
      DNC{channel === undefined ? '' : ` · ${channel}`}
    </Chip>
  );
}

/**
 * The "you already contacted this person from another identity" warning.
 * spec `identity_model.duplicate_outreach_warning` requires the previous sender,
 * timestamp, prior message/status to be shown.
 */
export function DuplicateOutreachWarning({
  senderName,
  at,
  status,
  onOpenPrevious,
}: {
  readonly senderName: string;
  readonly at: string;
  readonly status: string;
  readonly onOpenPrevious?: () => void;
}): ReactElement {
  return (
    <div className="nx-alert nx-alert--red" role="alert">
      <div className="nx-stack nx-stack--sm">
        <strong>Already contacted from another identity</strong>
        <span>
          {senderName} · {status} · {at}
        </span>
        {onOpenPrevious !== undefined && (
          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={onOpenPrevious}>
            Open previous conversation
          </button>
        )}
      </div>
    </div>
  );
}

/** Enforces the visual rule that a sent message is historical, not editable. */
export function ImmutableNotice(): ReactElement {
  return (
    <Row>
      <Chip accent="green" title="Sent messages are immutable in meaning">
        Immutable
      </Chip>
      <span className="nx-hint">Corrections are recorded as new events, never by overwriting.</span>
    </Row>
  );
}

/** Apollo enrichment posture — spec `lead_sources.apollo.ui_must_label`. */
export function EnrichmentOffChip(): ReactElement {
  return (
    <Chip accent="amber" title="Email/phone enrichment and paid credits are disabled by default" dataState="enrichment-off">
      Enrichment OFF
    </Chip>
  );
}

/** Step name for a due action, e.g. `Follow-up 2`. */
export function actionLabel(nextActionType: string | null, stepOrder?: number | null): string {
  if (stepOrder !== undefined && stepOrder !== null && stepOrder > 0) {
    if (stepOrder === 1) return 'Message 1';
    return `Follow-up ${String(stepOrder - 1)}`;
  }
  switch (nextActionType) {
    case 'connection':
      return 'Connection';
    case 'message_1':
      return 'Message 1';
    case 'followup_1':
      return 'Follow-up 1';
    case 'followup_2':
      return 'Follow-up 2';
    case 'followup_3':
      return 'Follow-up 3';
    case 'reactivation':
      return 'Reactivation';
    case 'reply':
      return 'Reply';
    case 'review':
      return 'Review';
    default:
      return 'No action';
  }
}

/** Due/overdue indicator; `overdue` follows the same red as the spec accents. */
export function DueChip({
  dueAt,
  overdue,
  now,
}: {
  readonly dueAt: string | null;
  readonly overdue: boolean;
  readonly now?: Date;
}): ReactElement | null {
  if (dueAt === null) return null;
  const due = new Date(dueAt);
  const reference = now ?? new Date();
  const days = Math.round((due.getTime() - reference.getTime()) / 86_400_000);
  const label =
    overdue || days < 0
      ? `Overdue ${String(Math.abs(days))}d`
      : days === 0
        ? 'Due today'
        : `Due in ${String(days)}d`;
  return (
    <Chip accent={overdue || days < 0 ? 'red' : days === 0 ? 'amber' : 'neutral'} dataState={overdue ? 'overdue' : 'due'}>
      {label}
    </Chip>
  );
}

/**
 * Raw provenance display. Scraped/web content is untrusted input, so it is always
 * rendered as text in a `<pre>`-like block and never interpreted as markup.
 */
export function ProvenanceBlock({
  source,
  sourceUrl,
  observedAt,
  confidence,
  content,
}: {
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly observedAt: string;
  readonly confidence: number | null;
  readonly content?: string;
}): ReactElement {
  return (
    <div className="nx-stack nx-stack--sm">
      <Row wrap>
        <Chip accent="indigo">{source}</Chip>
        {confidence !== null && <Chip>{`confidence ${confidence.toFixed(2)}`}</Chip>}
        <span className="nx-hint">observed {observedAt}</span>
      </Row>
      {sourceUrl !== null && (
        <a className="nx-hint" href={sourceUrl} rel="noreferrer noopener" target="_blank">
          {sourceUrl}
        </a>
      )}
      {content !== undefined && <div className="nx-input nx-input--readonly">{content}</div>}
    </div>
  );
}

/** Renders the caller-provided empty slot with a consistent Nexus treatment. */
export function CountChip({ count, label }: { readonly count: number; readonly label: ReactNode }): ReactElement {
  return (
    <Chip>
      {label} <strong>{count}</strong>
    </Chip>
  );
}
