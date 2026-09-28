/**
 * Reply classification — the call site for the `REPLY_CLASSIFICATION` task.
 *
 * The inbound reply is already stored verbatim before this module runs: the
 * `capture_reply` function writes the exact bytes into `interactions.summary` and
 * its payload, records the operator's outcome on `conversation_outcomes`, and
 * creates the DNC suppression when the outcome calls for it. Classification is a
 * *separate interpretation* of that stored text, and every rule here follows from
 * that separation:
 *
 *   * **The exact text is never written.** This module issues no `UPDATE` against
 *     the reply interaction, and its own row is a different one (`type = 'system'`,
 *     `direction = 'internal'`) carrying the structured reading plus provenance.
 *   * **The captured outcome is not the model's to set.** `conversation_outcomes.outcome`
 *     and `is_terminal` are left exactly as capture wrote them, so a DNC reply stays
 *     DNC even if the model reads it as interested. Only an *empty* `reason` is
 *     filled, so a note a person wrote is never replaced by a model's sentence.
 *   * **A classification failure never costs the reply.** Capture has already
 *     committed in its own transaction before this runs, and every failure path here
 *     is caught: the reply is saved, the ledger row records the typed failure, and
 *     the caller is told the reading is missing rather than that the reply was lost.
 *   * **Caching is safe only where the input is identical.** The input hash covers
 *     the exact reply text, the channel, the prior-outreach summary and the prompt
 *     version, so retrying the same reply reuses the same reading and a different
 *     reply can never be served the previous one's.
 *
 * Deliberately *not* fire-and-forget: under a serverless runtime a floating promise
 * can be killed with the request, which would make "classification happens
 * afterwards" a wish rather than a guarantee. The capture has already committed, so
 * awaiting this cannot roll the reply back.
 */
import 'server-only';

import { withActor, type Actor } from '../actor';
import { asNumber } from '../repo/common';
import type { CapturedReply } from '../repo/common';
import { TASK_REGISTRY, taskPrompt, type ReplyClassificationInput } from './tasks';
import { hashAiInput, runAiTask, type AiRunFailureCode } from './runner';
import type { ReplyClassification } from './tasks';
import type { AiProvider } from './types';

export type { CapturedReply };

export type ReplyClassificationFailureCode = AiRunFailureCode | 'reply_not_found' | 'commit_failed';

export interface ReplyClassificationSuccess {
  readonly ok: true;
  readonly classification: ReplyClassification;
  /** True when the reading agreed with the outcome the operator captured. */
  readonly agreesWithCapturedOutcome: boolean;
  readonly cached: boolean;
  readonly runId: string | null;
  readonly interactionId: string | null;
  readonly model: string;
  readonly promptVersionId: string | null;
}

export interface ReplyClassificationFailure {
  readonly ok: false;
  readonly error: string;
  readonly errorCode: ReplyClassificationFailureCode;
  readonly retryable: boolean;
  readonly runId: string | null;
}

export type ReplyClassificationOutcome = ReplyClassificationSuccess | ReplyClassificationFailure;

export interface ClassifyReplyInput {
  readonly reply: CapturedReply;
  /** The exact inbound text, as captured. Read-only here; never persisted by this module. */
  readonly exactText: string;
  readonly channel?: string;
  readonly provider?: AiProvider;
}

interface ContextRow extends Record<string, unknown> {
  business_id: string;
  person_id: string;
  outreach_identity_channel: string | null;
  messages_sent: number | null;
  last_outbound_at: string | null;
}

/**
 * The one real personalization context a reading needs: the channel the reply came
 * in on, and a bounded summary of what was sent before it. Never the whole
 * timeline — §24.4's cost rule applies to classification as much as to drafting.
 */
async function loadReplyContext(
  actor: Actor,
  reply: CapturedReply,
): Promise<{ businessId: string; personId: string; channel: string; priorOutreachSummary: string | null } | null> {
  return withActor(actor, async (sql) => {
    const result = await sql.query<ContextRow>(
      `select l.business_id,
              l.person_id,
              (select i.channel
                 from public.outreach_identities i
                where i.id = l.outreach_identity_id) as outreach_identity_channel,
              (select count(*)::int
                 from public.message_instances mi
                where mi.lead_id = l.id and mi.state = 'SENT') as messages_sent,
              (select max(ie.occurred_at)
                 from public.interactions ie
                where ie.lead_id = l.id
                  and ie.direction = 'outbound'
                  and ie.occurred_at < (
                    select coalesce(ir.occurred_at, now())
                      from public.interactions ir
                     where ir.id = $2
                  )) as last_outbound_at
         from public.leads l
        where l.id = $1
          and l.deleted_at is null`,
      [reply.leadId, reply.interactionId],
    );

    const row = result.rows[0];
    if (row === undefined) return null;

    const channel = row.outreach_identity_channel ?? 'linkedin';
    const sent = asNumber(row.messages_sent, 0);
    return {
      businessId: String(row.business_id),
      personId: String(row.person_id),
      channel,
      priorOutreachSummary:
        sent === 0
          ? null
          : `${String(sent)} message(s) sent on ${channel}` +
            (row.last_outbound_at === null ? '' : `; last outbound ${String(row.last_outbound_at).slice(0, 10)}`),
    };
  });
}

/**
 * Materialises a cache hit: the reading already stored for this exact input.
 *
 * The lookup is by the input hash inside this module's own interaction payload, so
 * a cache hit can only ever return a reading of the *same* reply text.
 */
async function loadStoredClassification(
  actor: Actor,
  reply: CapturedReply,
  inputHash: string,
): Promise<ReplyClassification | null> {
  return withActor(actor, async (sql) => {
    const stored = await sql.query<{
      outcome: string;
      sentiment: string;
      intent: string;
      recommended_next_action: string;
      reason: string;
    }>(
      `select ie.payload->>'ai_outcome' as outcome,
              ie.payload->>'ai_sentiment' as sentiment,
              ie.payload->>'ai_intent' as intent,
              ie.payload->>'ai_recommended_next_action' as recommended_next_action,
              ie.payload->>'ai_reason' as reason
         from public.interactions ie
        where ie.lead_id = $1
          and ie.payload->>'classification_input_hash' = $2
          and ie.payload ? 'ai_outcome'
        order by ie.created_at desc
        limit 1`,
      [reply.leadId, inputHash],
    );
    const row = stored.rows[0];
    if (row === undefined) return null;
    return {
      outcome: row.outcome as ReplyClassification['outcome'],
      sentiment: row.sentiment,
      intent: row.intent,
      recommended_next_action: row.recommended_next_action,
      reason: row.reason,
    };
  });
}

/** Classifies a captured reply and stores the reading. Never throws. */
export async function classifyCapturedReply(
  actor: Actor,
  input: ClassifyReplyInput,
): Promise<ReplyClassificationOutcome> {
  const exactText = input.exactText;
  if (exactText.trim().length === 0) {
    // `capture_reply` refuses an empty body, so this is unreachable from a real
    // capture; refusing rather than classifying nothing keeps the ledger clean.
    return {
      ok: false,
      error: 'There is no reply text to classify.',
      errorCode: 'reply_not_found',
      retryable: false,
      runId: null,
    };
  }

  const context = await loadReplyContext(actor, input.reply);
  if (context === null) {
    return {
      ok: false,
      error: 'That lead could not be found.',
      errorCode: 'reply_not_found',
      retryable: false,
      runId: null,
    };
  }

  const channel = input.channel ?? context.channel;
  const taskInput: ReplyClassificationInput = {
    replyText: exactText,
    channel,
    priorOutreachSummary: context.priorOutreachSummary,
  };
  const inputHash = hashAiInput({
    task: 'REPLY_CLASSIFICATION',
    leadId: input.reply.leadId,
    replyInteractionId: input.reply.interactionId,
    replyText: exactText,
    channel,
    priorOutreachSummary: context.priorOutreachSummary,
  });

  const task = TASK_REGISTRY.REPLY_CLASSIFICATION;
  const outcome = await runAiTask<ReplyClassification>(
    { actor },
    {
      businessId: context.businessId,
      task: 'REPLY_CLASSIFICATION',
      promptKey: task.promptKey,
      leadId: input.reply.leadId,
      personId: context.personId,
    },
    {
      inputHash,
      schema: task.schema,
      build: (prompt) => taskPrompt(task, taskInput, prompt),
      maxOutputTokens: task.maxOutputTokens,
      temperature: task.temperature,
      loadCached: async () => loadStoredClassification(actor, input.reply, inputHash),
      provider: input.provider,
    },
  );

  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.error,
      errorCode: outcome.errorCode,
      retryable: outcome.retryable,
      runId: outcome.runId,
    };
  }

  const classification = outcome.data;
  const agreesWithCapturedOutcome = classification.outcome === input.reply.outcome;

  try {
    const interactionId = await withActor(actor, async (sql) => {
      // 1. The structured interpretation, in its own row. The verbatim inbound
      //    interaction is untouched: this is a *second* record of the same event,
      //    not a rewrite of the first.
      const inserted = await sql.query<{ id: string }>(
        `insert into public.interactions
           (business_id, lead_id, person_id, conversation_id, type, actor_user_id,
            outreach_identity_id, direction, summary, payload, source_client, occurred_at)
         values ($1, $2, $3, $4, 'system', null, null, 'internal', $5, $6::jsonb, 'ai_pipeline', now())
         returning id`,
        [
          context.businessId,
          input.reply.leadId,
          context.personId,
          input.reply.conversationId,
          `AI reading of the reply: ${classification.outcome} — ${classification.reason}`.slice(0, 2000),
          JSON.stringify({
            // A plain-language reading for a human, and the machine fields beside
            // it. Never the reply text: that already exists in its own row, and a
            // copy here would be a second thing to keep in step.
            ai_outcome: classification.outcome,
            ai_sentiment: classification.sentiment,
            ai_intent: classification.intent,
            ai_recommended_next_action: classification.recommended_next_action,
            ai_reason: classification.reason,
            agrees_with_captured_outcome: agreesWithCapturedOutcome,
            captured_outcome: input.reply.outcome,
            source_reply_interaction_id: input.reply.interactionId,
            classification_input_hash: inputHash,
            ai_run_id: outcome.runId,
            model: outcome.model,
            prompt_version_id: outcome.promptVersionId,
          }),
        ],
      );
      const row = inserted.rows[0];
      const newInteractionId = row === undefined ? null : String(row.id);

      // 2. The outcome row keeps its captured `outcome` and `is_terminal` — those
      //    are the operator's decision and DNC's authority. Only an empty `reason`
      //    is filled in.
      if (input.reply.outcomeId !== null) {
        await sql.query(
          `update public.conversation_outcomes co
              set reason = $2
            where co.id = $1
              and (co.reason is null or btrim(co.reason) = '')`,
          [
            input.reply.outcomeId,
            `AI reading: ${classification.outcome} (${classification.sentiment}; intent: ${classification.intent}). ${classification.recommended_next_action}`.slice(
              0,
              1000,
            ),
          ],
        );
      }

      return newInteractionId;
    });

    return {
      ok: true,
      classification,
      agreesWithCapturedOutcome,
      cached: outcome.cached,
      runId: outcome.runId,
      interactionId,
      model: outcome.model,
      promptVersionId: outcome.promptVersionId,
    };
  } catch {
    return {
      ok: false,
      error: 'The reply was saved, but its AI reading could not be stored.',
      errorCode: 'commit_failed',
      retryable: true,
      runId: outcome.runId,
    };
  }
}

/**
 * The reading, or nothing — for a caller whose own job is already done.
 *
 * Every capture path uses this, so "a classification failure must not prevent the
 * reply itself from being saved" is a property of one function rather than a habit
 * each call site has to remember.
 */
export async function classifyCapturedReplyQuietly(
  actor: Actor,
  input: ClassifyReplyInput,
): Promise<ReplyClassificationOutcome | null> {
  try {
    return await classifyCapturedReply(actor, input);
  } catch (error) {
    // Belt and braces: `classifyCapturedReply` returns its failures, so reaching
    // here means something unforeseen. The reply is saved either way, which is the
    // only property that must hold.
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The AI reading failed.',
      errorCode: 'commit_failed',
      retryable: true,
      runId: null,
    };
  }
}

/**
 * Captures an externally submitted reply and then classifies it.
 *
 * Used by the MCP transport, where the caller is an actor rather than a signed-in
 * viewer. The capture is awaited first and the classification second, so the reply
 * exists before any model call is attempted.
 */
export async function captureReplyAndClassify(
  actor: Actor,
  input: {
    readonly leadId: string;
    readonly exactText: string;
    readonly outcome: string;
    readonly note?: string | null;
    readonly sourceClient?: string;
    readonly provider?: AiProvider;
  },
): Promise<{ readonly reply: CapturedReply; readonly classification: ReplyClassificationOutcome | null }> {
  const { recordExternalReply } = await import('../repo/ingest');
  const reply = await recordExternalReply(actor, {
    leadId: input.leadId,
    exactText: input.exactText,
    outcome: input.outcome,
    sourceClient: input.sourceClient ?? 'external',
  });
  const classification = await classifyCapturedReplyQuietly(actor, {
    reply,
    exactText: input.exactText,
    provider: input.provider,
  });
  return { reply, classification };
}
