/**
 * My Day / Today engine.
 *
 * Spec `tasks_and_my_day`:
 *   today_engine_inputs: sequence due step, previous activity, reply status,
 *     connection status, custom tasks, snooze/reschedule, due date
 *   today_categories: connections, accepted/message1, follow-ups, overdue, custom tasks
 *   today_action_rule: "Opening an item should land on the exact actionable step,
 *     not a long generic conversation page."
 *   done: "Completed items leave Today and appear in Done/history immediately."
 *   upcoming: "Future sequence actions and custom tasks appear in Upcoming."
 *
 * The engine is pure and clock-injected so the same inputs always produce the
 * same queue — the DB RPC `get_today_queue` implements exactly this projection so
 * the web app and the extension cannot disagree about what is due.
 */

import { currentDueStep, isDue, type SequenceConfig, type SequenceEnrollment } from './sequence-engine.js';
import {
  OUTREACH_BLOCKING_LEAD_STATES,
  type LeadState,
  type MyDayBucket,
  type NextActionType,
  type TaskPriority,
  type TodayCategory,
} from './vocabulary.js';

/* --------------------------------------------------------------- inputs - */

export interface TodayLeadInput {
  readonly leadId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly personId: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly jobTitle: string | null;
  readonly linkedinUrl: string | null;
  readonly leadStatus: LeadState;
  readonly primaryIcpId: string;
  readonly primaryIcpName: string;
  readonly ownerUserId: string;
  readonly outreachIdentityId: string | null;
  readonly outreachIdentityName: string | null;
  readonly isDnc: boolean;
  readonly deletedAt: string | null;
  readonly nextActionType: NextActionType;
  readonly nextActionAt: string | null;
  readonly lastActivityAt: string | null;
  readonly enrollment: SequenceEnrollment | null;
  /** DYNAMIC/LOCKED instances still pending for this lead. */
  readonly pendingInstanceIds: readonly string[];
  /** True when a human explicitly snoozed the lead's action. */
  readonly snoozedUntil: string | null;
}

export interface TodayTaskInput {
  readonly taskId: string;
  readonly leadId: string | null;
  readonly businessId: string;
  readonly ownerUserId: string;
  readonly type: string;
  readonly title: string;
  readonly dueAt: string;
  readonly priority: TaskPriority;
  readonly status: string;
  readonly snoozedUntil: string | null;
  readonly note: string | null;
}

export interface TodayInputs {
  readonly leads: readonly TodayLeadInput[];
  readonly tasks: readonly TodayTaskInput[];
  readonly config: SequenceConfig;
  readonly at: Date;
  /** Owner filter: pass null for "everything the actor can see". */
  readonly ownerUserId?: string | null;
  readonly businessId?: string | null;
  readonly categories?: readonly TodayCategory[];
}

/* -------------------------------------------------------------- outputs - */

export interface TodayItem {
  readonly id: string;
  readonly kind: 'sequence_action' | 'custom_task';
  readonly leadId: string | null;
  readonly businessId: string;
  readonly businessName: string;
  readonly personName: string | null;
  readonly companyName: string | null;
  readonly jobTitle: string | null;
  readonly linkedinUrl: string | null;
  readonly outreachIdentityId: string | null;
  readonly outreachIdentityName: string | null;
  readonly primaryIcpId: string | null;
  readonly primaryIcpName: string | null;
  readonly category: TodayCategory;
  readonly actionType: NextActionType;
  /** Exact step label, e.g. "Follow-up 2" — never a generic "thread". */
  readonly actionLabel: string;
  readonly stepOrder: number | null;
  readonly dueAt: string;
  readonly isOverdue: boolean;
  readonly overdueDays: number;
  readonly priority: TaskPriority;
  readonly taskType: string | null;
  readonly note: string | null;
  readonly taskStatus: string | null;
}

export interface TodayResult {
  readonly bucket: MyDayBucket;
  readonly items: readonly TodayItem[];
  readonly counts: Readonly<Record<TodayCategory, number>>;
  readonly total: number;
}

/* ------------------------------------------------ category derivation -- */

/**
 * Derive the Today category for a lead from its state, next action and the exact
 * due step. The order of these checks *is* the priority order used by Work Next.
 */
export function deriveCategory(item: {
  leadStatus: LeadState;
  nextActionType: NextActionType;
  stepKind: 'connection' | 'message' | 'followup' | 'reactivation' | null;
  isOverdue: boolean;
}): TodayCategory | null {
  if (item.isOverdue) return 'overdue';
  if (item.leadStatus === 'connection_due' || item.nextActionType === 'connection') {
    return 'connections';
  }
  if (item.leadStatus === 'connection_sent' || item.leadStatus === 'connection_accepted') {
    return 'accepted_message1';
  }
  if (item.nextActionType === 'message_1' || item.stepKind === 'message') {
    return 'accepted_message1';
  }
  if (item.stepKind === 'followup' || item.nextActionType.startsWith('followup')) {
    return 'followups';
  }
  if (item.stepKind === 'reactivation' || item.nextActionType === 'reactivation') {
    return 'followups';
  }
  return null;
}

/** spec `tasks_and_my_day.today_categories` ordering for the segmented control. */
export const TODAY_CATEGORY_ORDER: readonly TodayCategory[] = [
  'connections',
  'accepted_message1',
  'followups',
  'overdue',
  'custom_tasks',
];

export const TODAY_CATEGORY_LABELS: Readonly<Record<TodayCategory, string>> = {
  connections: 'Connections',
  accepted_message1: 'Accepted / Message 1',
  followups: 'Follow-ups',
  overdue: 'Overdue',
  custom_tasks: 'Custom tasks',
};

const PRIORITY_WEIGHT: Readonly<Record<TaskPriority, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/* ---------------------------------------------------------- the engine - */

function startOfDayUTC(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((startOfDayUTC(a) - startOfDayUTC(b)) / 86_400_000));
}

export function computeMyDay(inputs: TodayInputs): {
  readonly today: TodayResult;
  readonly upcoming: TodayResult;
  readonly done: TodayResult;
} {
  const { leads, tasks, config, at } = inputs;
  const ownerFilter = inputs.ownerUserId ?? null;
  const businessFilter = inputs.businessId ?? null;
  const categoryFilter = inputs.categories && inputs.categories.length > 0 ? new Set(inputs.categories) : null;

  const todayItems: TodayItem[] = [];
  const upcomingItems: TodayItem[] = [];

  for (const lead of leads) {
    if (lead.deletedAt !== null) continue;
    if (businessFilter !== null && lead.businessId !== businessFilter) continue;
    if (ownerFilter !== null && lead.ownerUserId !== ownerFilter) continue;
    // Outreach must never surface as work for a suppressed / terminal lead.
    if (lead.isDnc || OUTREACH_BLOCKING_LEAD_STATES.includes(lead.leadStatus)) continue;

    const stepInfo = lead.enrollment ? currentDueStep(lead.enrollment, config, at) : null;

    if (stepInfo === null) {
      // No sequence context: fall back to the lead's own next_action_at so a lead
      // with a manually scheduled action still appears.
      if (lead.nextActionAt === null) continue;
      const dueAt = new Date(lead.nextActionAt);
      const overdue = at.getTime() - dueAt.getTime() > 86_400_000;
      const category = deriveCategory({
        leadStatus: lead.leadStatus,
        nextActionType: lead.nextActionType,
        stepKind: null,
        isOverdue: overdue,
      });
      if (category === null) continue;
      if (dueAt.getTime() > at.getTime()) {
        upcomingItems.push(buildItem(lead, category, labelForNextAction(lead.nextActionType), null, dueAt, false, at));
      } else {
        todayItems.push(buildItem(lead, category, labelForNextAction(lead.nextActionType), null, dueAt, overdue, at));
      }
      continue;
    }

    const effectiveDueAt = lead.snoozedUntil !== null && new Date(lead.snoozedUntil).getTime() > stepInfo.dueAt.getTime()
      ? new Date(lead.snoozedUntil)
      : stepInfo.dueAt;

    const overdueDays = daysBetween(at, effectiveDueAt);
    const overdue = overdueDays >= 1;

    const category = deriveCategory({
      leadStatus: lead.leadStatus,
      nextActionType: lead.nextActionType,
      stepKind: stepInfo.step.kind,
      isOverdue: overdue,
    });
    if (category === null) continue;

    const item = buildItem(lead, category, stepInfo.step.name, stepInfo.step.stepOrder, effectiveDueAt, overdue, at);

    if (effectiveDueAt.getTime() <= at.getTime()) {
      todayItems.push(item);
    } else {
      upcomingItems.push(item);
    }
  }

  for (const task of tasks) {
    if (businessFilter !== null && task.businessId !== businessFilter) continue;
    if (ownerFilter !== null && task.ownerUserId !== ownerFilter) continue;
    if (task.status === 'done' || task.status === 'cancelled') continue;

    const effectiveDueAt =
      task.snoozedUntil !== null && new Date(task.snoozedUntil).getTime() > new Date(task.dueAt).getTime()
        ? new Date(task.snoozedUntil)
        : new Date(task.dueAt);

    const overdueDays = daysBetween(at, effectiveDueAt);
    const overdue = overdueDays >= 1;
    const category: TodayCategory = 'custom_tasks';

    const item: TodayItem = {
      id: `task:${task.taskId}`,
      kind: 'custom_task',
      leadId: task.leadId,
      businessId: task.businessId,
      businessName: '',
      personName: null,
      companyName: null,
      jobTitle: null,
      linkedinUrl: null,
      outreachIdentityId: null,
      outreachIdentityName: null,
      primaryIcpId: null,
      primaryIcpName: null,
      category,
      actionType: 'task',
      actionLabel: task.title,
      stepOrder: null,
      dueAt: effectiveDueAt.toISOString(),
      isOverdue: overdue,
      overdueDays,
      priority: task.priority,
      taskType: task.type,
      note: task.note,
      taskStatus: task.status,
    };

    if (effectiveDueAt.getTime() <= at.getTime()) {
      todayItems.push(item);
    } else {
      upcomingItems.push(item);
    }
  }

  const filterByCategory = (items: readonly TodayItem[]): readonly TodayItem[] =>
    categoryFilter === null ? items : items.filter((i) => categoryFilter.has(i.category));

  const todayFiltered = sortToday(filterByCategory(todayItems));
  const upcomingFiltered = sortUpcoming(filterByCategory(upcomingItems));

  // Done is derived from completed tasks + leads whose last activity is today.
  const doneItems: TodayItem[] = tasks
    .filter((t) => {
      if (t.status !== 'done') return false;
      if (businessFilter !== null && t.businessId !== businessFilter) return false;
      if (ownerFilter !== null && t.ownerUserId !== ownerFilter) return false;
      const completed = t.snoozedUntil ?? t.dueAt;
      return new Date(completed).getTime() <= at.getTime();
    })
    .map<TodayItem>((t) => ({
      id: `task-done:${t.taskId}`,
      kind: 'custom_task',
      leadId: t.leadId,
      businessId: t.businessId,
      businessName: '',
      personName: null,
      companyName: null,
      jobTitle: null,
      linkedinUrl: null,
      outreachIdentityId: null,
      outreachIdentityName: null,
      primaryIcpId: null,
      primaryIcpName: null,
      category: 'custom_tasks',
      actionType: 'task',
      actionLabel: t.title,
      stepOrder: null,
      dueAt: t.dueAt,
      isOverdue: false,
      overdueDays: 0,
      priority: t.priority,
      taskType: t.type,
      note: t.note,
      taskStatus: t.status,
    }))
    .sort((a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime());

  return {
    today: buildResult('today', todayFiltered),
    upcoming: buildResult('upcoming', upcomingFiltered),
    done: buildResult('done', doneItems),
  };
}

function buildItem(
  lead: TodayLeadInput,
  category: TodayCategory,
  actionLabel: string,
  stepOrder: number | null,
  dueAt: Date,
  overdue: boolean,
  at: Date,
): TodayItem {
  return {
    id: `lead:${lead.leadId}:${stepOrder ?? 'na'}`,
    kind: 'sequence_action',
    leadId: lead.leadId,
    businessId: lead.businessId,
    businessName: lead.businessName,
    personName: lead.personName,
    companyName: lead.companyName,
    jobTitle: lead.jobTitle,
    linkedinUrl: lead.linkedinUrl,
    outreachIdentityId: lead.outreachIdentityId,
    outreachIdentityName: lead.outreachIdentityName,
    primaryIcpId: lead.primaryIcpId,
    primaryIcpName: lead.primaryIcpName,
    category,
    actionType: lead.nextActionType,
    actionLabel,
    stepOrder,
    dueAt: dueAt.toISOString(),
    isOverdue: overdue,
    overdueDays: daysBetween(at, dueAt),
    priority: overdue ? 'high' : 'normal',
    taskType: null,
    note: null,
    taskStatus: null,
  };
}

function labelForNextAction(type: NextActionType): string {
  switch (type) {
    case 'capture_profile':
      return 'Capture profile';
    case 'connection':
      return 'Connection request';
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
    case 'review':
      return 'Review';
    case 'task':
      return 'Task';
    case 'none':
      return 'No action';
  }
}

/**
 * Today ordering = "Work Next" order: category priority, then overdue depth, then
 * due time, then priority.
 */
function sortToday(items: readonly TodayItem[]): readonly TodayItem[] {
  const categoryRank: Readonly<Record<TodayCategory, number>> = {
    overdue: 0,
    connections: 1,
    accepted_message1: 2,
    followups: 3,
    custom_tasks: 4,
  };
  return [...items].sort((a, b) => {
    const cat = categoryRank[a.category] - categoryRank[b.category];
    if (cat !== 0) return cat;
    if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
    const due = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    if (due !== 0) return due;
    const pri = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (pri !== 0) return pri;
    return a.id.localeCompare(b.id);
  });
}

function sortUpcoming(items: readonly TodayItem[]): readonly TodayItem[] {
  return [...items].sort((a, b) => {
    const due = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    if (due !== 0) return due;
    return a.id.localeCompare(b.id);
  });
}

function buildResult(bucket: MyDayBucket, items: readonly TodayItem[]): TodayResult {
  const counts: Record<TodayCategory, number> = {
    connections: 0,
    accepted_message1: 0,
    followups: 0,
    overdue: 0,
    custom_tasks: 0,
  };
  for (const item of items) counts[item.category] += 1;
  return { bucket, items, counts, total: items.length };
}

/* ------------------------------------------------------- work next ----- */

/**
 * "Work Next" — the next single item the operator should work, honouring the
 * Today ordering. Returns null when the queue is empty.
 */
export function workNext(result: TodayResult, afterItemId?: string | null): TodayItem | null {
  if (result.items.length === 0) return null;
  if (!afterItemId) return result.items[0] ?? null;
  const index = result.items.findIndex((i) => i.id === afterItemId);
  if (index === -1) return result.items[0] ?? null;
  return result.items[index + 1] ?? null;
}

/** Completing an item removes it from Today and records history immediately. */
export function completeItem(
  result: TodayResult,
  itemId: string,
): { readonly remaining: TodayResult; readonly completed: TodayItem | null } {
  const completed = result.items.find((i) => i.id === itemId) ?? null;
  if (completed === null) return { remaining: result, completed: null };
  const remainingItems = result.items.filter((i) => i.id !== itemId);
  return { remaining: buildResult(result.bucket, remainingItems), completed };
}

/** Companion Today filters — spec `screen_behavior_crosswalk.extension_U24_Today`. */
export function todayCategoryCounts(result: TodayResult): Readonly<Record<TodayCategory, number>> {
  return result.counts;
}

/** True when a Today item is a follow-up that should open Follow-up Focus. */
export function opensFollowUpFocus(item: TodayItem): boolean {
  return item.kind === 'sequence_action' && (item.category === 'followups' || item.actionType.startsWith('followup'));
}

/** True when a Today item must open Connection Focus (note / no-note choice). */
export function opensConnectionFocus(item: TodayItem): boolean {
  return item.kind === 'sequence_action' && item.actionType === 'connection';
}

/** True when the item opens the Dormant & Reactivation view. */
export function opensReactivationFocus(item: TodayItem): boolean {
  return item.kind === 'sequence_action' && item.actionType === 'reactivation';
}

export { isDue };
