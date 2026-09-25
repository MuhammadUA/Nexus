/**
 * Completed-work history for the Done screen.
 *
 * Reads the same `interactions` and `message_events` rows the queue writes when an
 * operator marks something done, so Done is a projection of real activity rather
 * than a second bookkeeping system that could drift from it.
 */
import 'server-only';

import type { Actor } from '../actor';
import type { Row } from '../sql';
import { asIso, asString, asStringOrNull, read } from './common';

export interface CompletionEntry {
  readonly id: string;
  readonly at: string;
  readonly summary: string;
  readonly leadId: string;
  readonly personName: string | null;
  readonly businessName: string;
  readonly identityName: string | null;
}

/** Human labels for the interaction types that represent completed work. */
const COMPLETION_LABELS: Readonly<Record<string, string>> = {
  connection_event: 'Connection sent',
  message_sent: 'Message sent',
  reply: 'Reply captured',
  follow_up: 'Follow-up sent',
  task_completed: 'Task completed',
  snooze: 'Snoozed',
  profile_capture: 'Profile captured',
};

export async function getRecentCompletions(
  actor: Actor,
  businessId: string,
  userId: string | null,
  limit = 50,
): Promise<readonly CompletionEntry[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select i.id, i.type, i.occurred_at, i.summary, i.lead_id,
              p.full_name as person_name, b.name as business_name,
              oi.display_name as identity_name
         from public.interactions i
         join public.leads l on l.id = i.lead_id
         join public.people p on p.id = l.person_id
         join public.businesses b on b.id = i.business_id
         left join public.outreach_identities oi on oi.id = i.outreach_identity_id
        where i.business_id = $1
          and ($2::uuid is null or i.actor_user_id = $2)
          and i.direction in ('outbound', 'internal')
        order by i.occurred_at desc
        limit $3`,
      [businessId, userId, limit],
    );

    return result.rows.map((row: Row) => {
      const type = asString(row.type, 'interaction');
      return {
        id: asString(row.id),
        at: asIso(row.occurred_at) ?? '',
        summary: asStringOrNull(row.summary) ?? COMPLETION_LABELS[type] ?? type.replace(/_/g, ' '),
        leadId: asString(row.lead_id),
        personName: asStringOrNull(row.person_name),
        businessName: asString(row.business_name),
        identityName: asStringOrNull(row.identity_name),
      };
    });
  });
}
