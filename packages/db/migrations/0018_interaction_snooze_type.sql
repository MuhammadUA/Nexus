-- ---------------------------------------------------------------------------
-- 0018 — `interactions.type` accepts 'snooze'
--
-- `snoozeLead` has always recorded a timeline entry with `type = 'snooze'`, but
-- `interactions_type_check` (0005) never listed that value. Every snooze therefore raised
-- `23514`, so the action failed outright: the panel was told the request could not be completed, and
-- nothing was snoozed.
--
-- The vocabulary is extended rather than the writer changed. A snooze is its own fact about a lead —
-- "the operator deferred this deliberately until X" — and folding it into `task_event` or `system`
-- would lose exactly the distinction `reply_and_notes.history_rule` asks the timeline to preserve.
-- ---------------------------------------------------------------------------

alter table public.interactions
  drop constraint if exists interactions_type_check;

alter table public.interactions
  add constraint interactions_type_check
  check (type in (
    'outbound_message', 'inbound_reply', 'internal_note',
    'connection_event', 'sequence_state_change', 'task_event',
    'profile_capture', 'signal', 'assignment', 'identity_transfer',
    'import', 'system',
    'snooze'
  ));
