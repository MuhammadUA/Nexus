/**
 * Confirms the deployed admin account can actually sign in.
 *
 * Drives the real HTTP surface: fetch `/login`, post the credentials to
 * `/api/auth/login`, then use the returned session cookie to reach an authenticated
 * page. A 303 with a cookie is not enough — the cookie has to work.
 *
 * Usage: node scripts/smoke-login.mjs <url> <email> <password>
 */
const [, , base = 'http://127.0.0.1:3000', email = '', password = ''] = process.argv;

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function attempt(candidatePassword) {
  const data = new FormData();
  data.append('mode', 'signin');
  data.append('email', email);
  data.append('password', candidatePassword);

  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    body: data,
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((entry) => entry.startsWith('nx_session='));
  return {
    status: response.status,
    location: response.headers.get('location') ?? '',
    sessionCookie: session === undefined ? null : session.split(';')[0],
  };
}

// 1. The login page is reachable and offers the sign-in form.
const page = await fetch(`${base}/login`);
const html = await page.text();
check('GET /login is 200', page.status === 200, `status=${page.status}`);
check('the sign-in panel is shown (deployment is claimed)', html.includes('Sign in to continue'));
check('the form posts to the auth handler', html.includes('action="/api/auth/login"'));

// 2. A wrong password must be refused and must set no cookie.
const wrong = await attempt(`${password}-definitely-wrong`);
check('a wrong password is refused', wrong.status === 303 && wrong.location.includes('error='), wrong.location);
check('a wrong password sets no session cookie', wrong.sessionCookie === null);

// 3. The real password must work and yield a usable session.
const good = await attempt(password);
check('the admin password is accepted', good.status === 303, `status=${good.status}`);
check('sign-in redirects into the app', good.location === '/my-day', good.location);
check('sign-in sets a session cookie', good.sessionCookie !== null);

if (good.sessionCookie !== null) {
  const headers = { cookie: good.sessionCookie };

  // 4. The session must actually authenticate a protected page.
  const myDay = await fetch(`${base}/my-day`, { headers, redirect: 'manual' });
  check('the session reaches /my-day', myDay.status === 200, `status=${myDay.status}`);
  const myDayHtml = await myDay.text();
  check('My Day renders real content', myDayHtml.includes('My Day'));

  // 5. Admin-only surfaces must be reachable.
  for (const [label, path] of [
    ['Businesses hub', '/businesses'],
    ['Integrations gateway', '/integrations'],
    ['Team & accounts', '/team'],
    ['Settings', '/settings'],
  ]) {
    const response = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
    check(`${label} (${path}) renders`, response.status === 200, `status=${response.status}`);
  }

  // 6. Without the cookie those pages must not render.
  const unauthenticated = await fetch(`${base}/businesses`, { redirect: 'manual' });
  check(
    'the app redirects an anonymous visitor to /login',
    unauthenticated.status === 307 || unauthenticated.status === 308,
    `status=${unauthenticated.status}`,
  );
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
