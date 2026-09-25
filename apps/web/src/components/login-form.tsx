'use client';

import type { ReactElement } from 'react';

import { Button, Field, Stack, TextInput } from '@nexus/ui';

/**
 * Login form. Deliberately generic: spec `screen_inventory` A01/U01 forbid
 * business- or user-specific example copy on a login panel.
 *
 * **The form posts to a route handler, not a server action.** In this Next.js version
 * `cookies()` throws *"called outside a request scope"* inside a server action, so the
 * session could never be established from one. A plain HTML form POST to
 * `/api/auth/login` sets the cookie on its own `303` response and lets the browser
 * navigate; it also means sign-in works with JavaScript disabled.
 *
 * Values are echoed back through the query string on failure, which is why the inputs
 * read their `defaultValue` from props rather than from action state.
 */
export function LoginForm({
  mode,
  localAuthEnabled = true,
  defaultEmail = '',
  defaultFullName = '',
  error = null,
}: {
  readonly mode: 'bootstrap' | 'signin';
  readonly localAuthEnabled?: boolean;
  readonly defaultEmail?: string;
  readonly defaultFullName?: string;
  readonly error?: string | null;
}): ReactElement {
  return (
    <form action="/api/auth/login" method="post">
      {/* Tells the handler whether this is first-run setup or a normal sign-in. */}
      <input type="hidden" name="mode" value={mode} />

      <Stack size="lg">
        {mode === 'bootstrap' && (
          <Field label="Your name" htmlFor="fullName" required>
            <TextInput
              id="fullName"
              name="fullName"
              defaultValue={defaultFullName}
              autoComplete="name"
              required
            />
          </Field>
        )}

        <Field label="Email" htmlFor="email" required>
          <TextInput
            id="email"
            name="email"
            defaultValue={defaultEmail}
            type="email"
            autoComplete="username"
            required
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          required
          hint={mode === 'bootstrap' ? 'At least 12 characters.' : undefined}
        >
          <TextInput
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
            required
          />
        </Field>

        {error !== null && (
          <p className="nx-error" role="alert">
            {error}
          </p>
        )}

        {mode === 'signin' && !localAuthEnabled && (
          <p className="nx-hint">
            Local sign-in is disabled. Set <code>NEXUS_LOCAL_AUTH=1</code> for local development.
          </p>
        )}

        <Button type="submit" variant="primary" block>
          {mode === 'bootstrap' ? 'Create administrator' : 'Sign in'}
        </Button>
      </Stack>
    </form>
  );
}
