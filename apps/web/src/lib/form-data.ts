/**
 * Form-value readers.
 *
 * Two real hazards are handled here, both of which produce silent, confusing failures
 * rather than errors:
 *
 * **1. Duplicate keys.** React renders `defaultValue` on a controlled-by-nobody input
 * as an extra hidden `<input>` carrying that default. A form with
 * `<TextInput defaultValue="" name="email" />` therefore submits `email` **twice** —
 * once with the default and once with what the operator typed. `FormData.get()` returns
 * the *first* entry, so a naive read gets the default (`""`) and Zod rejects a perfectly
 * good submission. These helpers take the **last** value, which is the operator's, and
 * `formStrings` de-duplicates so a checkbox group is not double-counted.
 *
 * **2. `File` values.** `FormData.get()` returns `string | File | null`. `String(...)`
 * on that union yields the useless string `"[object Object]"` for a file field, which
 * would then flow into a UUID check or a SQL parameter as if it were real input. A
 * `File` is a hard error here, never a silent coercion.
 *
 * Kept free of `server-only` so both server actions and client code can use it.
 */

/** Every string value submitted under `name`, in submission order. */
function stringValues(formData: FormData, name: string): readonly string[] {
  const raw = formData.getAll(name);
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string') {
      out.push(value);
    } else {
      throw new Error(
        `Field "${name}" was submitted as a file, but a text value was expected. ` +
          'Check that the form field type matches what the handler reads.',
      );
    }
  }
  return out;
}

/**
 * Reads a text field, preferring the last submitted value.
 *
 * The last non-empty value wins when any is present; otherwise the last value is used
 * so that an operator who deliberately cleared a field submits an empty string rather
 * than falling back to the default they can no longer see.
 */
export function formString(formData: FormData, name: string, fallback = ''): string {
  const values = stringValues(formData, name);
  if (values.length === 0) return fallback;

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && value.length > 0) return value;
  }
  return values[values.length - 1] ?? fallback;
}

/** Reads an optional text field, returning null when absent or empty. */
export function formStringOrNull(formData: FormData, name: string): string | null {
  const value = formString(formData, name);
  return value.trim().length === 0 ? null : value;
}

/**
 * Reads a repeated field (checkbox groups, multi-selects).
 *
 * Entries are de-duplicated and any empty submission is dropped, so the
 * `defaultValue` shadow input React adds cannot double-count a chosen value.
 */
export function formStrings(formData: FormData, name: string): readonly string[] {
  const seen = new Set<string>();
  for (const value of stringValues(formData, name)) {
    if (value.length > 0) seen.add(value);
  }
  return [...seen];
}

/** Reads a checkbox as a boolean. */
export function formBool(formData: FormData, name: string): boolean {
  const value = formString(formData, name, '');
  return value === 'on' || value === 'true' || value === '1';
}
