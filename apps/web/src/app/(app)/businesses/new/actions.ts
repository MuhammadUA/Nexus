'use server';

/**
 * A23 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Add Business Wizard mutations.
 *
 * spec `business_units.clone_behavior` is the rule this file exists to honour:
 *
 *   may_copy:      ICP structure, signal scoring, message/sequence rules,
 *                  automation skeletons, assignment rules
 *   must_not_copy: leads, people/company history, conversations, replies,
 *                  message history, agent runs
 *
 * `createBusiness` writes a bare business and `cloneBusiness` copies configuration
 * only (its SQL lists the copied tables explicitly), so neither path can drag
 * operational history into a new business. Nothing here widens that.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { createOffer } from '@/lib/repo/brain';
import { cloneBusiness, createBusiness, getBusinessById, type BusinessInput } from '@/lib/repo/businesses';
import { formString, formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
  /** Set on success so the wizard can link straight into the new business. */
  readonly createdKey?: string;
  readonly createdId?: string;
  /** A secondary warning (the business exists but a follow-up step did not land). */
  readonly warning?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

/**
 * Turns a business name into a valid URL slug.
 *
 * Duplicated from the wizard component on purpose: the client uses it to help the
 * operator, and the server uses it as the authoritative fallback. Deriving the key here
 * means a submission whose key field never arrived ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a programmatic fill, a password
 * manager, a browser extension ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â still produces a valid business instead of a
 * validation error the operator cannot act on.
 *
 * `businesses.key` has a CHECK constraint (`^[a-z0-9][a-z0-9-]*$`); validating the same
 * shape here turns a raw constraint error into a usable message.
 */
function slugifyBusinessKey(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const keySchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and dashes, starting with a letter or number.');

/**
 * Optional text field.
 *
 * `.nullish()`, not `.nullish()`: a blank optional input submits as `null` (see
 * `formStringOrNull`), and `z.string().nullish()` accepts `undefined` but rejects
 * `null`. With `.nullish()` every submission that left an optional field blank failed
 * validation with "Expected string, received null" Ã¢â‚¬â€ which is to say, every normal
 * first attempt.
 */
const optionalText = (max: number): z.ZodType<string | null | undefined> =>
  z.string().trim().max(max).nullish();

const wizardSchema = z.object({
  mode: z.enum(['scratch', 'clone', 'template']),
  sourceBusinessId: z.string().uuid().nullish(),
  key: optionalText(60),
  name: z.string().trim().min(1, 'Give the business a name.').max(200),
  focus: optionalText(200),
  regions: optionalText(400),
  notes: optionalText(2000),
  offerName: optionalText(200),
  offerDescription: optionalText(4000),
  offerPositioning: optionalText(4000),
  offerCtaStyle: optionalText(200),
});

export async function createBusinessAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = wizardSchema.safeParse({
    mode: formString(formData, 'mode', 'scratch'),
    sourceBusinessId: formStringOrNull(formData, 'sourceBusinessId'),
    key: formStringOrNull(formData, 'key'),
    name: formString(formData, 'name'),
    focus: formStringOrNull(formData, 'focus'),
    regions: formStringOrNull(formData, 'regions'),
    notes: formStringOrNull(formData, 'notes'),
    offerName: formStringOrNull(formData, 'offerName'),
    offerDescription: formStringOrNull(formData, 'offerDescription'),
    offerPositioning: formStringOrNull(formData, 'offerPositioning'),
    offerCtaStyle: formStringOrNull(formData, 'offerCtaStyle'),
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    // Name the field that failed. A bare "Expected string, received null" tells the
    // operator nothing actionable.
    const field = first?.path.join('.') ?? 'form';
    return {
      ok: false,
      error: `${first?.message ?? 'That value is not valid.'}${field === 'form' ? '' : ` (${field})`}`,
    };
  }

  const data = parsed.data;

  // Derive the slug from the name when the field is absent or unusable, then validate
  // the result: a name of only punctuation has no derivable slug at all, and that must
  // still fail with a message the operator can act on.
  const providedKey = data.key ?? '';
  const derived = providedKey.length > 0 ? providedKey : slugifyBusinessKey(data.name);
  const keyResult = keySchema.safeParse(derived);
  if (!keyResult.success) {
    return {
      ok: false,
      error:
        derived.length === 0
          ? 'That name has no letters or numbers to build a URL slug from. Add a business key.'
          : (keyResult.error.issues[0]?.message ?? 'That business key is not valid.'),
    };
  }
  const businessKey = keyResult.data;

  if ((data.mode === 'clone' || data.mode === 'template') && data.sourceBusinessId === undefined) {
    return {
      ok: false,
      error:
        data.mode === 'clone'
          ? 'Choose the business to copy configuration from.'
          : 'Choose the template to start from.',
    };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  // "Template" is not just a label: `businesses.is_template` is the flag the spec's
  // scratch/clone/template choice refers to, so a template start is refused when the
  // chosen source is an ordinary business.
  if (data.mode === 'template') {
    const source = await getBusinessById(viewer.actor, data.sourceBusinessId ?? '');
    if (source === null) return { ok: false, error: 'That template could not be found.' };
    if (!source.isTemplate) {
      return {
        ok: false,
        error: `${source.name} is not marked as a template. Use "Copy an existing business" instead.`,
      };
    }
  }

  const input: BusinessInput = {
    key: businessKey,
    name: data.name ?? null,
    focus: emptyToNull(data.focus ?? undefined),
    regions: parseRegions(data.regions ?? undefined),
    notes: emptyToNull(data.notes ?? undefined),
  };

  const result =
    data.mode === 'scratch'
      ? await createBusiness(viewer, input)
      : await cloneBusiness(viewer, data.sourceBusinessId ?? '', input);

  if (!result.ok || result.id === undefined) {
    return { ok: false, error: result.error ?? 'The business was not created.' };
  }

  // "Offer" is step 2 of the wizard. It is written after the business exists, and a
  // failure here is reported as a warning because the business itself is already
  // created and usable ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â hiding that would be worse than admitting the partial step.
  let warning: string | undefined;
  const offerName = emptyToNull(data.offerName ?? undefined);
  if (offerName !== null) {
    const offer = await createOffer(viewer, {
      businessId: result.id,
      name: offerName,
      description: emptyToNull(data.offerDescription ?? undefined),
      positioning: emptyToNull(data.offerPositioning ?? undefined),
      ctaStyle: emptyToNull(data.offerCtaStyle ?? undefined),
    });
    if (!offer.ok) {
      warning = `The business was created, but the offer was not saved: ${offer.error ?? 'unknown error'}. Add it on the Business Brain screen.`;
    }
  }

  revalidatePath('/businesses');
  revalidatePath(`/b/${businessKey}/overview`);

  return {
    ok: true,
    error: null,
    createdKey: businessKey,
    createdId: result.id,
    message:
      data.mode === 'scratch'
        ? `${data.name} created. Configuration starts empty.`
        : `${data.name} created from the selected source. Configuration was copied; no lead, conversation, reply, message-history or agent-run data was.`,
    ...(warning === undefined ? {} : { warning }),
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** "US, UK, Germany" -> `text[]`. Regions are free text in the spec's examples. */
function parseRegions(value: string | null | undefined): readonly string[] {
  if (value === undefined || value === null) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 20);
}
