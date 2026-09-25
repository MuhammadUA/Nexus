'use server';

/**
 * A19 — Automation Mapping actions.
 *
 * A runner is configured with its business, ICP, source type and schedule. The data
 * contract itself is the MCP tool set, which the operator does not define here — an
 * automation cannot widen what an agent may do, only where its submissions land.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { upsertAutomation } from '@/lib/repo/integrations';
import { formString, formStringOrNull } from '@/lib/form-data';

export interface AutomationActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const schema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  runner: z.enum(['browseros', 'opencode', 'n8n', 'other']),
  purpose: z.string().trim().max(500).nullish(),
  runMode: z.string().trim().max(60).nullish(),
  schedule: z.string().trim().max(120).nullish(),
  sourceType: z.string().trim().max(60).nullish(),
  icpId: z.union([z.string().uuid(), z.literal('')]).nullish(),
});

export async function saveAutomationAction(
  _previous: AutomationActionResult,
  formData: FormData,
): Promise<AutomationActionResult> {
  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const parsed = schema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    name: formStringOrNull(formData, 'name'),
    runner: formString(formData, 'runner', 'other'),
    purpose: formStringOrNull(formData, 'purpose'),
    runMode: formStringOrNull(formData, 'runMode'),
    schedule: formStringOrNull(formData, 'schedule'),
    sourceType: formStringOrNull(formData, 'sourceType'),
    icpId: formStringOrNull(formData, 'icpId'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'Give the mapping a name and a runner.' };
  }

  const optional = (value: string | undefined): string | null =>
    value === undefined || value.trim().length === 0 ? null : value.trim();

  const result = await upsertAutomation(viewer, {
    businessId: parsed.data.businessId ?? undefined,
    name: parsed.data.name ?? undefined,
    runner: parsed.data.runner ?? undefined,
    purpose: optional(parsed.data.purpose ?? undefined),
    runMode: optional(parsed.data.runMode ?? undefined),
    schedule: optional(parsed.data.schedule ?? undefined),
    sourceType: optional(parsed.data.sourceType ?? undefined),
    icpId: optional(parsed.data.icpId ?? undefined) === null ? null : (parsed.data.icpId as string),
  });

  if (result.ok) revalidatePath('/automations');

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Automation mapping saved.' : undefined,
  };
}
