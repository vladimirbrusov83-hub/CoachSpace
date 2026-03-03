import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9341;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } else if (req.url === '/supabase.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(__dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')));
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const results = [];

function log(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ name, ok, detail });
  ok ? passed++ : failed++;
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── MOCK SUPABASE ─────────────────────────────────────────────────────────────
// Controllable mock: exposes window.__mockSB for test manipulation
const MOCK_SCRIPT = `
(function() {
  let _session = null;
  let _users = [];
  let _nextId = 1;
  const uid = () => 'id-' + (_nextId++);
  let _signUpError = null;   // inject error for next signUp call
  let _signInError = null;   // inject error for next signIn call
  let _signUpDelay = 0;      // simulate network latency

  window.__mockSB = {
    setSignUpError(msg) { _signUpError = msg; },
    setSignInError(msg) { _signInError = msg; },
    clearErrors() { _signUpError = null; _signInError = null; },
    setSignUpDelay(ms) { _signUpDelay = ms; },
    getUsers() { return _users; },
    getSession() { return _session; },
    resetAll() { _session=null; _users=[]; _signUpError=null; _signInError=null; _signUpDelay=0; }
  };

  function makeBuilder(table) {
    let _filters={}, _single=false, _op='select', _updateData=null, _insertData=null;
    const _store = [];
    const b = {
      select() { return b; },
      insert(d) { _op='insert'; _insertData=Array.isArray(d)?d:[d]; return b; },
      update(d) { _op='update'; _updateData=d; return b; },
      delete() { _op='delete'; return b; },
      eq(col,val) { _filters[col]=val; return b; },
      order() { return b; },
      single() { _single=true; return b; },
      then(resolve) { resolve({ data: _single ? null : [], error: null }); }
    };
    return b;
  }

  window.supabase = {
    createClient(url, key) {
      return {
        auth: {
          getSession() {
            return Promise.resolve({ data: { session: _session } });
          },
          async signUp({ email, password, options }) {
            if (_signUpDelay) await new Promise(r => setTimeout(r, _signUpDelay));
            if (_signUpError) {
              const msg = _signUpError; _signUpError = null;
              return { error: { message: msg } };
            }
            if (_users.find(u => u.email === email))
              return { error: { message: 'User already registered' } };
            const user = { id: uid(), email, user_metadata: options?.data || {} };
            _users.push(user);
            _session = { user };
            return { data: { user }, error: null };
          },
          async signInWithPassword({ email, password }) {
            if (_signInError) {
              const msg = _signInError; _signInError = null;
              return { error: { message: msg } };
            }
            const user = _users.find(u => u.email === email);
            if (!user) return { error: { message: 'Invalid login credentials' } };
            _session = { user };
            return { data: { user, session: _session }, error: null };
          },
          signOut() { _session = null; return Promise.resolve({ error: null }); }
        },
        from(table) { return makeBuilder(table); }
      };
    }
  };
})();
`;

async function freshPage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**cdn.jsdelivr.net**/supabase**', route =>
    route.fulfill({ contentType: 'application/javascript', body: MOCK_SCRIPT }));
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ body: '' }));
  await page.goto(BASE, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 12000 }).catch(() => {});
  await page.waitForSelector('#login-screen', { state: 'visible', timeout: 8000 }).catch(() => {});
  return page;
}

// Ensure the form is in signup mode (btn = "Create Account →")
async function goSignup(page) {
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  if (btnText !== 'Create Account →') await page.click('#login-toggle a');
  await wait(100);
}

// Ensure the form is in signin mode (btn = "Enter CoachSpace →")
async function goSignin(page) {
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  if (btnText !== 'Enter CoachSpace →') await page.click('#login-toggle a');
  await wait(100);
}


// ═════════════════════════════════════════════════════════════════════════════
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server']
});

console.log('\n━━━ COACH REGISTRATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── T1: Coach happy-path signup ────────────────────────────────────────────
{
  const page = await freshPage(browser);
  await goSignup(page);
  await page.fill('#login-email', 'coach1@test.com');
  await page.fill('#login-name', 'Coach One');
  await page.fill('#login-password', 'secret123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Coach signup → app loads', await page.isVisible('#app'));
  log('Sidebar visible after coach signup', await page.isVisible('.sidebar'));
  log('Coach-empty state shown', await page.isVisible('#coach-empty'));
  log('Client-view hidden for coach', !(await page.isVisible('#client-view')));

  const avatar = await page.$eval('#top-avatar', el => el.textContent);
  log('Avatar initials from name', avatar === 'CO', `"${avatar}"`);
  const topName = await page.$eval('#top-name', el => el.textContent);
  log('Topbar shows coach name', topName === 'Coach One', `"${topName}"`);
  await page.close();
}

// ── T2: Coach signup without name → falls back to email username ───────────
{
  const page = await freshPage(browser);
  await goSignup(page);
  await page.fill('#login-email', 'nameless@example.com');
  await page.fill('#login-password', 'secret123');
  // Leave name blank
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Coach signup without name works', await page.isVisible('#app'));
  const topName = await page.$eval('#top-name', el => el.textContent);
  log('Name defaults to email username', topName === 'nameless', `"${topName}"`);
  const avatar = await page.$eval('#top-avatar', el => el.textContent);
  log('Avatar uses email username initials', avatar === 'NA', `"${avatar}"`);
  await page.close();
}

// ── T3: Duplicate email ────────────────────────────────────────────────────
{
  const page = await freshPage(browser);
  await goSignup(page);
  await page.fill('#login-email', 'coach1@test.com');
  await page.fill('#login-name', 'Coach One');
  await page.fill('#login-password', 'secret123');
  // First signup succeeds (mock is fresh per page)
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});

  // Logout and try signing up again with same email
  await page.click('button:has-text("Sign out")');
  await wait(400);
  await goSignup(page);
  await page.fill('#login-email', 'coach1@test.com');
  await page.fill('#login-name', 'Coach Dup');
  await page.fill('#login-password', 'different');
  await page.click('#login-btn');
  await wait(800);
  const errVisible = await page.isVisible('#login-err');
  log('Duplicate email shows error', errVisible);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Error says "already registered"', errText.toLowerCase().includes('already'), `"${errText}"`);
  const appHidden = !(await page.isVisible('#app'));
  log('App NOT shown after duplicate signup', appHidden);
  await page.close();
}

// ── T4: Backend signup error (injected) ───────────────────────────────────
{
  const page = await freshPage(browser);
  await goSignup(page);
  await page.evaluate(() => window.__mockSB.setSignUpError('Email address invalid'));
  await page.fill('#login-email', 'bad@test.com');
  await page.fill('#login-name', 'Bad');
  await page.fill('#login-password', 'pass');
  await page.click('#login-btn');
  await wait(600);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Backend signup error displayed', errText.includes('Email address invalid'), `"${errText}"`);
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button re-enabled after signup error', btnText === 'Create Account →', `"${btnText}"`);
  const btnDisabled = await page.$eval('#login-btn', el => el.disabled);
  log('Button not disabled after error', !btnDisabled);
  await page.close();
}

// ── T5: Button loading state during signup ────────────────────────────────
{
  const page = await freshPage(browser);
  await goSignup(page);
  await page.evaluate(() => window.__mockSB.setSignUpDelay(2000));
  await page.fill('#login-email', 'slow@test.com');
  await page.fill('#login-name', 'Slow');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  // Check immediately while loading
  await wait(100);
  const btnTextLoading = await page.$eval('#login-btn', el => el.textContent.trim());
  const btnDisabledLoading = await page.$eval('#login-btn', el => el.disabled);
  log('Button shows "Loading…" during signup', btnTextLoading === 'Loading…', `"${btnTextLoading}"`);
  log('Button disabled during signup', btnDisabledLoading);
  await page.waitForSelector('#app', { state: 'visible', timeout: 8000 }).catch(() => {});
  await page.close();
}

console.log('\n━━━ CLIENT REGISTRATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── T6: Client happy-path signup ──────────────────────────────────────────
{
  const page = await freshPage(browser);
  await page.click('button.role-tab:nth-child(2)'); // client
  await goSignup(page);
  // Name field must NOT show for client signup
  const nameHidden = !(await page.isVisible('#login-name-field'));
  log('Name field hidden for client signup', nameHidden);

  await page.fill('#login-email', 'client1@test.com');
  await page.fill('#login-password', 'secret123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Client signup → app loads', await page.isVisible('#app'));
  log('Client view visible', await page.isVisible('#client-view'));
  log('Sidebar hidden for client', !(await page.isVisible('.sidebar')));
  log('Cal-content hidden for client', !(await page.isVisible('#cal-content')));

  // Role stored as 'client' in metadata → initApp shows client view
  const weekLabel = await page.$eval('#cv-week-label', el => el.textContent).catch(() => '');
  log('Client week label shown', weekLabel.length > 3, `"${weekLabel}"`);
  await page.close();
}

// ── T7: Client name defaults to email username ────────────────────────────
{
  const page = await freshPage(browser);
  await page.click('button.role-tab:nth-child(2)');
  await goSignup(page);
  await page.fill('#login-email', 'johndoe@gym.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  const topName = await page.$eval('#top-name', el => el.textContent);
  log('Client name defaults to email prefix', topName === 'johndoe', `"${topName}"`);
  await page.close();
}

console.log('\n━━━ LOGIN FLOWS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── T8: Coach login happy path ────────────────────────────────────────────
{
  const page = await freshPage(browser);
  // First create account
  await goSignup(page);
  await page.fill('#login-email', 'coach2@test.com');
  await page.fill('#login-name', 'Coach Two');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});

  // Logout
  await page.click('button:has-text("Sign out")');
  await wait(400);
  log('Login screen returns after logout', await page.isVisible('#login-screen'));
  const btnAfterLogout = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button text reset after logout', btnAfterLogout === 'Enter CoachSpace →', `"${btnAfterLogout}"`);
  const btnDisabledAfterLogout = await page.$eval('#login-btn', el => el.disabled);
  log('Button not disabled after logout', !btnDisabledAfterLogout);

  // Sign back in
  await page.fill('#login-email', 'coach2@test.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Coach login after signup works', await page.isVisible('#app'));
  log('Sidebar visible on coach re-login', await page.isVisible('.sidebar'));
  await page.close();
}

// ── T9: Client login happy path ───────────────────────────────────────────
{
  const page = await freshPage(browser);
  await page.click('button.role-tab:nth-child(2)');
  await goSignup(page);
  await page.fill('#login-email', 'client2@test.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});

  await page.click('button:has-text("Sign out")');
  await wait(400);
  // Log in again (role tab doesn't matter for login — metadata has the role)
  await page.fill('#login-email', 'client2@test.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Client login after signup works', await page.isVisible('#app'));
  log('Client view on re-login', await page.isVisible('#client-view'));
  await page.close();
}

// ── T10: Wrong password ───────────────────────────────────────────────────
{
  const page = await freshPage(browser);
  await page.evaluate(() => window.__mockSB.setSignInError('Invalid login credentials'));
  await page.fill('#login-email', 'anyone@test.com');
  await page.fill('#login-password', 'wrongpass');
  await page.click('#login-btn');
  await wait(600);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Wrong password shows error', errText.includes('Invalid login credentials'), `"${errText}"`);
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button text restored after login error', btnText === 'Enter CoachSpace →', `"${btnText}"`);
  log('App NOT shown on bad login', !(await page.isVisible('#app')));
  await page.close();
}

// ── T11: Non-existent account ─────────────────────────────────────────────
{
  const page = await freshPage(browser);
  // Don't create any user — just try to login
  await page.fill('#login-email', 'ghost@test.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await wait(600);
  const errVisible = await page.isVisible('#login-err');
  log('Non-existent account shows error', errVisible);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Error message is meaningful', errText.length > 5, `"${errText}"`);
  await page.close();
}

console.log('\n━━━ VALIDATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── T12: Empty email and password ─────────────────────────────────────────
{
  const page = await freshPage(browser);
  await page.click('#login-btn');
  await wait(400);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Empty fields → validation error', errText.includes('fill in all'), `"${errText}"`);
  log('App not shown on empty submit', !(await page.isVisible('#app')));
  await page.close();
}

// ── T13: Email filled, password empty ────────────────────────────────────
{
  const page = await freshPage(browser);
  await page.fill('#login-email', 'someone@test.com');
  await page.click('#login-btn');
  await wait(400);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Missing password → validation error', errText.includes('fill in all'), `"${errText}"`);
  await page.close();
}

// ── T14: Password filled, email empty ────────────────────────────────────
{
  const page = await freshPage(browser);
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await wait(400);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Missing email → validation error', errText.includes('fill in all'), `"${errText}"`);
  await page.close();
}

console.log('\n━━━ UI STATE & TOGGLE BEHAVIOUR ━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── T15: Error clears when toggling signup/signin ─────────────────────────
{
  const page = await freshPage(browser);
  // Trigger an error
  await page.click('#login-btn');
  await wait(300);
  log('Error visible before toggle', await page.isVisible('#login-err'));
  // Toggle to signup
  await page.click('#login-toggle a');
  await wait(200);
  log('Error hidden after toggle to signup', !(await page.isVisible('#login-err')));
  // Toggle back
  await page.click('#login-toggle a');
  await wait(200);
  // No error since we didn't submit again
  log('Toggle back to signin — error stays hidden', !(await page.isVisible('#login-err')));
  await page.close();
}

// ── T16: Name field only visible in coach signup mode ────────────────────
{
  const page = await freshPage(browser);
  // Default: coach, sign-in mode
  log('T16a — Coach sign-in: name hidden', !(await page.isVisible('#login-name-field')));

  // Coach signup
  await goSignup(page);
  log('T16b — Coach signup: name visible', await page.isVisible('#login-name-field'));

  // Switch to client while in signup
  await page.click('button.role-tab:nth-child(2)');
  await wait(150);
  log('T16c — Client signup: name hidden', !(await page.isVisible('#login-name-field')));

  // Back to coach
  await page.click('button.role-tab:nth-child(1)');
  await wait(150);
  log('T16d — Coach signup again: name visible', await page.isVisible('#login-name-field'));

  // Back to sign-in
  await goSignin(page);
  log('T16e — Coach sign-in: name hidden again', !(await page.isVisible('#login-name-field')));
  await page.close();
}

// ── T17: Toggle text content ──────────────────────────────────────────────
{
  const page = await freshPage(browser);
  const toggleDefault = await page.$eval('#login-toggle', el => el.textContent);
  log('Default toggle text has "Sign up free"', toggleDefault.includes('Sign up free'), `"${toggleDefault.trim()}"`);

  await page.click('#login-toggle a');
  await wait(150);
  const toggleSignup = await page.$eval('#login-toggle', el => el.textContent);
  log('After toggle: text has "Sign in"', toggleSignup.includes('Sign in'), `"${toggleSignup.trim()}"`);

  const btnSignup = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button says "Create Account →" in signup', btnSignup === 'Create Account →', `"${btnSignup}"`);

  await page.click('#login-toggle a');
  await wait(150);
  const btnSignin = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button says "Enter CoachSpace →" in signin', btnSignin === 'Enter CoachSpace →', `"${btnSignin}"`);
  await page.close();
}

// ── T18: Logout fully resets login form state ─────────────────────────────
{
  const page = await freshPage(browser);
  // Sign up (sets isSignup=true internally)
  await goSignup(page);
  await page.fill('#login-email', 'reset@test.com');
  await page.fill('#login-name', 'Reset Coach');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});

  // Log out
  await page.click('button:has-text("Sign out")');
  await wait(400);

  // Form should be fully reset to sign-in state
  const btnAfter = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Logout resets button to "Enter CoachSpace →"', btnAfter === 'Enter CoachSpace →', `"${btnAfter}"`);
  const nameHidden = !(await page.isVisible('#login-name-field'));
  log('Logout hides name field (resets isSignup)', nameHidden);
  const toggleText = await page.$eval('#login-toggle', el => el.textContent);
  log('Logout resets toggle text to "Sign up free"', toggleText.includes('Sign up free'), `"${toggleText.trim()}"`);
  const errHidden = !(await page.isVisible('#login-err'));
  log('Logout clears any error message', errHidden);
  await page.close();
}

// ── T19: Session persistence — boot with existing session ─────────────────
{
  const page = await freshPage(browser);
  // Inject a pre-existing session before boot runs
  // We do this by adding an init script that sets the session before supabase is used
  // Actually, the mock is injected before page scripts run, but we need session set before boot()
  // Let's sign up, then test that the session is carried into a fresh page reload

  await goSignup(page);
  await page.fill('#login-email', 'persist@test.com');
  await page.fill('#login-name', 'Persist Coach');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Initial login for session test', await page.isVisible('#app'));

  // The mock keeps _session in memory. Reload the page — boot() will see the session.
  // Since it's the same JS context per browser page, we need to simulate this differently.
  // Instead: verify that after login, currentUser is set by checking app is shown (done above).
  // Real session persistence would require localStorage/cookie which needs real Supabase.
  // What we can test: doLogout() clears state properly.
  await page.click('button:has-text("Sign out")');
  await wait(400);
  const loginBack = await page.isVisible('#login-screen');
  log('Logout clears app and shows login', loginBack);
  // Verify app state is reset (sidebar hides when app is hidden)
  const sidebarAfterLogout = await page.isVisible('.sidebar');
  log('Sidebar hidden after logout', !sidebarAfterLogout);
  await page.close();
}

// ── T20: Role tabs both work on login screen ──────────────────────────────
{
  const page = await freshPage(browser);
  // Coach is default
  const coachActive = await page.$eval('.role-tab:nth-child(1)', el => el.classList.contains('active'));
  const clientInactive = !(await page.$eval('.role-tab:nth-child(2)', el => el.classList.contains('active')));
  log('Coach tab active by default', coachActive && clientInactive);

  await page.click('button.role-tab:nth-child(2)');
  await wait(150);
  const clientNowActive = await page.$eval('.role-tab:nth-child(2)', el => el.classList.contains('active'));
  const coachNowInactive = !(await page.$eval('.role-tab:nth-child(1)', el => el.classList.contains('active')));
  log('Switching to Client deactivates Coach', clientNowActive && coachNowInactive);

  await page.click('button.role-tab:nth-child(1)');
  await wait(150);
  const coachBackActive = await page.$eval('.role-tab:nth-child(1)', el => el.classList.contains('active'));
  log('Switching back to Coach works', coachBackActive);
  await page.close();
}

// ── T21: Error element hidden by default ──────────────────────────────────
{
  const page = await freshPage(browser);
  const errHidden = !(await page.isVisible('#login-err'));
  log('Error element hidden on fresh page load', errHidden);
  const errText = await page.$eval('#login-err', el => el.textContent.trim());
  log('Error element empty on fresh page load', errText === '', `"${errText}"`);
  await page.close();
}

// ── T22: No metadata role defaults to client view ────────────────────────
{
  // Use a variant mock that omits role from user_metadata on signUp
  const NO_ROLE_MOCK = MOCK_SCRIPT.replace(
    'options:{data:{role:currentRole,name:name||email.split',
    'options:{data:{name:name||email.split' // won't match — use a different approach
  );
  // Build a mock that strips role out of metadata at signUp time
  const noRoleMock = MOCK_SCRIPT.replace(
    `const user = { id: uid(), email, user_metadata: options?.data || {} };`,
    `const meta = { ...(options?.data || {}) }; delete meta.role;
            const user = { id: uid(), email, user_metadata: meta };`
  );

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**cdn.jsdelivr.net**/supabase**', route =>
    route.fulfill({ contentType: 'application/javascript', body: noRoleMock }));
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ body: '' }));
  await page.goto(BASE, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 12000 }).catch(() => {});
  await page.waitForSelector('#login-screen', { state: 'visible', timeout: 8000 }).catch(() => {});

  await goSignup(page);
  await page.fill('#login-email', 'norole@test.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('No-role user goes to app', await page.isVisible('#app'));
  log('No-role defaults to client view', await page.isVisible('#client-view'));
  log('No-role: sidebar hidden', !(await page.isVisible('.sidebar')));
  await page.close();
}

await browser.close();
server.close();

// ── SUMMARY ────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`AUTH TEST SUMMARY: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));
if (failed > 0) {
  console.log('\nFailed:');
  results.filter(r => !r.ok).forEach(r =>
    console.log(`  ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
  );
}
process.exit(failed > 0 ? 1 : 0);
