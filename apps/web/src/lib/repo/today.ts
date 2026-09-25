/**
 * My Day / Companion Today data access.
 *
 * The queue is computed by `public.get_today_queue`, which already encodes the
 * spec's `tasks_and_my_day.today_engine_inputs` (sequence due step, previous
 * activity, reply status, connection status, custom tasks, snooze and due date).
 * This module's job is to call it and map the rows onto `TodayItem`.
 *
 * Recomputing the queue in application code would be worse than useless: it would be
 * a second implementation of the same rules, free to disagree with the database.
 *
 * This file is `server-only`. The pure helpers and types live in `@/lib/today-view`
 * so client components can import them without pulling `server-only` into a browser
 * bundle; they are re-exported here for server callers.
 */
import 'server-only';

import type { Actor } from '../actor';
import type { Row } from '../sql';
import { asBoolean, asIso, asNumber, asString, asStringOrNull, read } from './common';
import {
  TODAY_CATEGORIES,
  TODAY_CATEGORY_LABELS,
  focusHref,
  todayCounts,
  workNext,
  type TodayBucket,
  type TodayCategory,
  type TodayItem,
} from '../today-view';

export { TODAY_CATEGORIES, TODAY_CATEGORY_LABELS, focusHref, todayCounts, workNext };
export type { TodayBucket, TodayCategory, TodayItem };

function asCategory(value: unknown): TodayCategory {
  const candidate = asString(value, 'custom_tasks');
  return (TODAY_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as TodayCategory)
    : 'custom_tasks';
}

function mapItem(row: Row): TodayItem {
  return {
    leadId: asString(row.item_lead_id),
    businessId: asString(row.item_business_id),
    personId: asString(row.item_person_id),
    personName: asString(row.person_name, 'Unknown'),
    companyName: asStringOrNull(row.company_name),
    category: asCategory(row.item_category),
    actionType: asStringOrNull(row.action_type),
    dueAt: asIso(row.due_at),
    isOverdue: asBoolean(row.is_overdue),
    messageInstanceId: asStringOrNull(row.message_instance_id),
    sequenceStepId: asStringOrNull(row.sequence_step_id),
    stepOrder: row.step_order === null || row.step_order === undefined ? null : asNumber(row.step_order),
    stepKind: asStringOrNull(row.step_kind),
    leadState: asStringOrNull(row.item_state),
    taskId: asStringOrNull(row.task_id),
    priority: asStringOrNull(row.priority),
    senderIdentityId: asStringOrNull(row.sender_identity_id),
  };
}

export interface TodayQuery {
  readonly businessId: string;
  readonly bucket?: TodayBucket;
  readonly categories?: readonly TodayCategory[];
  readonly at?: Date;
  /** Admin/manager only: read another user's queue. */
  readonly userId?: string;
}

export async function getTodayQueue(
  actor: Actor,
  actingUserId: string | null,
  query: TodayQuery,
): Promise<readonly TodayItem[]> {
  const userId = query.userId ?? actingUserId;
  if (userId === null) {
    throw new Error('getTodayQueue requires a user id');
  }

  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select * from public.get_today_queue($1, $2, $3, $4::text[], $5)`,
      [
        userId,
        query.businessId,
        query.bucket ?? 'today',
        query.categories === undefined ? null : [...query.categories],
        (query.at ?? new Date()).toISOString(),
      ],
    );
    return result.rows.map((row: Row) => mapItem(row));
  });
}
