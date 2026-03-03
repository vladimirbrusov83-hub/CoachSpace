import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9341;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
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
const MOCK_SCRIPT = `
(function() {
  let _session = null;
  let _users = [];
  let _nextId = 1;
  const uid = () => 'id-' + (_nextId++);
  let _signUpError = null;
  let _signInError = null;
  let _signUpDelay = 0;

  window.__mockSB = {
    setSignUpError(msg) { _signUpError = msg; },
    setSignInError(msg) { _signInError = msg; },
    clearErrors() { _signUpError = null; _signInError = null; },
    setSignUpDelay(ms) { _signUpDelay = ms; },
    getUsers() { return _users; },
    getSession() { return _session; },
    resetAll() { _session=null; _users=[]; _signUpError=null; _signInError=null; _signUpDelay=0; }
  };

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
        from(table) {
          const b = {
            select() { return b; },
            insert() { return b; },
            update() { return b; },
            delete() { return b; },
            eq() { return b; },
            order() { return b; },
            single() { return b; },
            then(resolve) { resolve({ data: null, error: null }); }
          };
          return b;
        }
      };
    }
  };
})();
`;

async function freshPage(browser, url = BASE) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**cdn.jsdelivr.net**/supabase**', route =>
    route.fulfill({ contentType: 'application/javascript', body: MOCK_SCRIPT }));
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ body: '' }));
  await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 12000 }).catch(() => {});
  return page;
}

async function freshLoginPage(browser) {
  const page = await freshPage(browser);
  await page.waitForSelector('#login-screen', { state: 'visible', timeout: 8000 }).catch(() => {});
  return page;
}

async function freshRegisterPage(browser, email = '') {
  const url = email
    ? `${BASE}/?register&email=${encodeURIComponent(email)}`
    : `${BASE}/?register`;
  const page = await freshPage(browser, url);
  await page.waitForSelector('#client-register-screen', { state: 'visible', timeout: 8000 }).catch(() => {});
  return page;
}

// ═════════════════════════════════════════════════════════════════════════════
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server']
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n━━━ COACH LOGIN PAGE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// T1: Clean login form on fresh load
{
  const page = await freshLoginPage(browser);
  log('Login screen visible on fresh load', await page.isVisible('#login-screen'));
  log('Client register screen hidden on fresh load', !(await page.isVisible('#client-register-screen')));
  log('No role tabs in login form', !(await page.$('.role-tabs')));
  log('No name field in login form', !(await page.$('#login-name-field')));
  log('No signup toggle in login form', !(await page.$('#login-toggle')));
  log('Button says "Enter CoachSpace →"',
    await page.$eval('#login-btn', el => el.textContent.trim()) === 'Enter CoachSpace →');
  log('Error element hidden on fresh load', !(await page.isVisible('#login-err')));
  await page.close();
}

// T2: Coach happy-path login
{
  const page = await freshLoginPage(browser);
  // Seed a coach user in the mock
  await page.evaluate(() =>
    window.__mockSB.getUsers().push({ id: 'coach-1', email: 'coach@coachspace.app',
      user_metadata: { role: 'coach', name: 'Vladimir' } }));
  await page.fill('#login-email', 'coach@coachspace.app');
  await page.fill('#login-password', 'GoCoach1!');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Coach login → app loads', await page.isVisible('#app'));
  log('Sidebar visible after coach login', await page.isVisible('.sidebar'));
  log('Coach-empty state shown', await page.isVisible('#coach-empty'));
  log('Client-view hidden for coach', !(await page.isVisible('#client-view')));
  const avatar = await page.$eval('#top-avatar', el => el.textContent);
  log('Avatar shows "VL" for Vladimir', avatar === 'VL', `"${avatar}"`);
  const topName = await page.$eval('#top-name', el => el.textContent);
  log('Topbar shows "Vladimir"', topName === 'Vladimir', `"${topName}"`);
  await page.close();
}

// T3: Wrong password shows error
{
  const page = await freshLoginPage(browser);
  await page.evaluate(() => window.__mockSB.setSignInError('Invalid login credentials'));
  await page.fill('#login-email', 'coach@coachspace.app');
  await page.fill('#login-password', 'wrong');
  await page.click('#login-btn');
  await wait(500);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Wrong password shows error', errText.includes('Invalid login credentials'), `"${errText}"`);
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button restored after error', btnText === 'Enter CoachSpace →', `"${btnText}"`);
  log('App not shown on bad login', !(await page.isVisible('#app')));
  await page.close();
}

// T4: Non-existent account shows error
{
  const page = await freshLoginPage(browser);
  await page.fill('#login-email', 'nobody@test.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await wait(500);
  log('Non-existent account shows error', await page.isVisible('#login-err'));
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Error message meaningful', errText.length > 5, `"${errText}"`);
  await page.close();
}

// T5: Empty fields validation
{
  const page = await freshLoginPage(browser);
  await page.click('#login-btn');
  await wait(300);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Empty submit → validation error', errText.includes('fill in all'), `"${errText}"`);
  log('App not shown on empty submit', !(await page.isVisible('#app')));
  await page.close();
}

// T6: Missing password validation
{
  const page = await freshLoginPage(browser);
  await page.fill('#login-email', 'coach@coachspace.app');
  await page.click('#login-btn');
  await wait(300);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Missing password → validation error', errText.includes('fill in all'), `"${errText}"`);
  await page.close();
}

// T7: Missing email validation
{
  const page = await freshLoginPage(browser);
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await wait(300);
  const errText = await page.$eval('#login-err', el => el.textContent);
  log('Missing email → validation error', errText.includes('fill in all'), `"${errText}"`);
  await page.close();
}

// T8: Button loading state during login
{
  const page = await freshLoginPage(browser);
  await page.evaluate(() => window.__mockSB.setSignUpDelay(2000));
  // Use signInError to simulate slow response — actually we need slow signIn
  // Inject delay into signIn instead
  await page.evaluate(() => {
    const orig = window.supabase.createClient('', '');
    // We'll just check the button right after click before mock responds
  });
  // Seed a user, set a delay on the mock's internal calls
  await page.evaluate(() => {
    window.__mockSB.getUsers().push({ id: 'c1', email: 'slow@test.com',
      user_metadata: { role: 'coach', name: 'Slow' } });
    // Patch signInWithPassword on the existing sb client (harder to reach)
    // Instead: just click and measure timing — button should disable immediately
  });
  await page.fill('#login-email', 'slow@test.com');
  await page.fill('#login-password', 'pass');
  // Don't await the click — check state immediately after
  page.click('#login-btn'); // fire and forget
  await wait(50); // very short wait — just enough for JS to run synchronously
  const btnDisabled = await page.$eval('#login-btn', el => el.disabled);
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button disabled immediately on click', btnDisabled);
  log('Button shows "Loading…"', btnText === 'Loading…', `"${btnText}"`);
  await page.waitForSelector('#app', { state: 'visible', timeout: 8000 }).catch(() => {});
  await page.close();
}

// T9: Enter key triggers login
{
  const page = await freshLoginPage(browser);
  await page.evaluate(() =>
    window.__mockSB.getUsers().push({ id: 'c2', email: 'enter@test.com',
      user_metadata: { role: 'coach', name: 'Enter' } }));
  await page.fill('#login-email', 'enter@test.com');
  await page.fill('#login-password', 'pass');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#app', { state: 'visible', timeout: 8000 }).catch(() => {});
  log('Enter key triggers login', await page.isVisible('#app'));
  await page.close();
}

// T10: Logout resets login form and clears fields
{
  const page = await freshLoginPage(browser);
  await page.evaluate(() =>
    window.__mockSB.getUsers().push({ id: 'c3', email: 'logout@test.com',
      user_metadata: { role: 'coach', name: 'Logout' } }));
  await page.fill('#login-email', 'logout@test.com');
  await page.fill('#login-password', 'pass');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});

  await page.click('button:has-text("Sign out")');
  await wait(400);

  log('Login screen returns after logout', await page.isVisible('#login-screen'));
  log('App hidden after logout', !(await page.isVisible('#app')));
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Button reset after logout', btnText === 'Enter CoachSpace →', `"${btnText}"`);
  const btnDisabled = await page.$eval('#login-btn', el => el.disabled);
  log('Button not disabled after logout', !btnDisabled);
  const emailCleared = await page.$eval('#login-email', el => el.value);
  log('Email field cleared after logout', emailCleared === '', `"${emailCleared}"`);
  const passwordCleared = await page.$eval('#login-password', el => el.value);
  log('Password field cleared after logout', passwordCleared === '', `"${passwordCleared}"`);
  const errHidden = !(await page.isVisible('#login-err'));
  log('Error hidden after logout', errHidden);
  await page.close();
}

// T11: Login screen has no signup toggle — client-register-screen is separate
{
  const page = await freshLoginPage(browser);
  const toggleExists = await page.$('#login-toggle');
  log('No signup toggle on login screen', !toggleExists);
  const registerScreenHidden = !(await page.isVisible('#client-register-screen'));
  log('Client register screen not visible on login page', registerScreenHidden);
  await page.close();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n━━━ CLIENT REGISTRATION (?register) ━━━━━━━━━━━━━━━━━━━━━━\n');

// T12: ?register shows client registration screen (not login)
{
  const page = await freshRegisterPage(browser);
  log('Register screen visible on ?register URL', await page.isVisible('#client-register-screen'));
  log('Login screen hidden on ?register URL', !(await page.isVisible('#login-screen')));
  log('Name field visible on register screen', await page.isVisible('#reg-name'));
  log('Email field visible on register screen', await page.isVisible('#reg-email'));
  log('Password field visible on register screen', await page.isVisible('#reg-password'));
  const btnText = await page.$eval('#reg-btn', el => el.textContent.trim());
  log('Register button says "Create Account →"', btnText === 'Create Account →', `"${btnText}"`);
  await page.close();
}

// T13: ?register&email=x pre-fills the email field
{
  const page = await freshRegisterPage(browser, 'jane@gym.com');
  const email = await page.$eval('#reg-email', el => el.value);
  log('Email pre-filled from URL param', email === 'jane@gym.com', `"${email}"`);
  await page.close();
}

// T14: Client registration happy path
{
  const page = await freshRegisterPage(browser, 'client1@test.com');
  await page.fill('#reg-name', 'Jane Doe');
  // email already pre-filled
  await page.fill('#reg-password', 'secret123');
  await page.click('#reg-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Client registration → app loads', await page.isVisible('#app'));
  log('Client view visible after registration', await page.isVisible('#client-view'));
  log('Sidebar hidden for client', !(await page.isVisible('.sidebar')));
  const topName = await page.$eval('#top-name', el => el.textContent);
  log('Topbar shows client name "Jane Doe"', topName === 'Jane Doe', `"${topName}"`);
  const avatar = await page.$eval('#top-avatar', el => el.textContent);
  log('Avatar shows "JA" for Jane', avatar === 'JA', `"${avatar}"`);
  await page.close();
}

// T15: Client registration without pre-filled email
{
  const page = await freshRegisterPage(browser);
  await page.fill('#reg-name', 'Bob Smith');
  await page.fill('#reg-email', 'bob@test.com');
  await page.fill('#reg-password', 'pass123');
  await page.click('#reg-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Client can register without email pre-fill', await page.isVisible('#app'));
  log('Client view shown', await page.isVisible('#client-view'));
  await page.close();
}

// T16: Client registration empty fields
{
  const page = await freshRegisterPage(browser);
  await page.click('#reg-btn');
  await wait(300);
  const errText = await page.$eval('#reg-err', el => el.textContent);
  log('Empty register → validation error', errText.includes('fill in all'), `"${errText}"`);
  log('App not shown on empty register', !(await page.isVisible('#app')));
  await page.close();
}

// T17: Client registration missing name
{
  const page = await freshRegisterPage(browser);
  await page.fill('#reg-email', 'test@test.com');
  await page.fill('#reg-password', 'pass123');
  await page.click('#reg-btn');
  await wait(300);
  const errText = await page.$eval('#reg-err', el => el.textContent);
  log('Missing name → validation error', errText.includes('fill in all'), `"${errText}"`);
  await page.close();
}

// T18: Client registration backend error
{
  const page = await freshRegisterPage(browser);
  await page.evaluate(() => window.__mockSB.setSignUpError('Email address not allowed'));
  await page.fill('#reg-name', 'Test');
  await page.fill('#reg-email', 'bad@test.com');
  await page.fill('#reg-password', 'pass');
  await page.click('#reg-btn');
  await wait(500);
  const errText = await page.$eval('#reg-err', el => el.textContent);
  log('Backend register error displayed', errText.includes('Email address not allowed'), `"${errText}"`);
  const btnText = await page.$eval('#reg-btn', el => el.textContent.trim());
  log('Register button restored after error', btnText === 'Create Account →', `"${btnText}"`);
  await page.close();
}

// T19: Client registers as role=client (not coach)
{
  const page = await freshRegisterPage(browser);
  await page.fill('#reg-name', 'Alice');
  await page.fill('#reg-email', 'alice@test.com');
  await page.fill('#reg-password', 'pass123');
  await page.click('#reg-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Registered user gets client view', await page.isVisible('#client-view'));
  log('Registered user has no sidebar', !(await page.isVisible('.sidebar')));
  await page.close();
}

// T20: Duplicate email on register
{
  const page = await freshRegisterPage(browser);
  // Pre-seed an existing user with this email in the mock
  await page.evaluate(() =>
    window.__mockSB.getUsers().push({ id: 'existing-1', email: 'dup@test.com',
      user_metadata: { role: 'client', name: 'Existing' } }));
  await page.fill('#reg-name', 'Second');
  await page.fill('#reg-email', 'dup@test.com');
  await page.fill('#reg-password', 'pass123');
  await page.click('#reg-btn');
  await wait(500);
  const errText = await page.$eval('#reg-err', el => el.textContent);
  log('Duplicate email on register shows error', errText.toLowerCase().includes('already'), `"${errText}"`);
  log('App not shown on duplicate register', !(await page.isVisible('#app')));
  await page.close();
}

// T21: Enter key triggers registration
{
  const page = await freshRegisterPage(browser);
  await page.fill('#reg-name', 'Keypress');
  await page.fill('#reg-email', 'keypress@test.com');
  await page.fill('#reg-password', 'pass123');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#app', { state: 'visible', timeout: 8000 }).catch(() => {});
  log('Enter key triggers client registration', await page.isVisible('#app'));
  await page.close();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n━━━ CLIENT LOGIN (after registration) ━━━━━━━━━━━━━━━━━━━━\n');

// T22: Client can log in via coach login form after registering
{
  // Register first on register page
  const regPage = await freshRegisterPage(browser);
  await regPage.fill('#reg-name', 'ReturnClient');
  await regPage.fill('#reg-email', 'return@test.com');
  await regPage.fill('#reg-password', 'pass123');
  await regPage.click('#reg-btn');
  await regPage.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  // Get the user store state so we can share it with the login page mock
  const users = await regPage.evaluate(() => window.__mockSB.getUsers());
  await regPage.close();

  // Now open the login page and inject the same user
  const loginPage = await freshLoginPage(browser);
  await loginPage.evaluate((u) => {
    u.forEach(user => window.__mockSB.getUsers().push(user));
  }, users);
  await loginPage.fill('#login-email', 'return@test.com');
  await loginPage.fill('#login-password', 'pass123');
  await loginPage.click('#login-btn');
  await loginPage.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  log('Client can log in after registering', await loginPage.isVisible('#app'));
  log('Client sees client view on login', await loginPage.isVisible('#client-view'));
  log('Client has no sidebar on login', !(await loginPage.isVisible('.sidebar')));
  await loginPage.close();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n━━━ SESSION BOOT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// T23: Existing session skips login screen
{
  // Seed session in mock before page loads — patch getSession in init script
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Override the mock so getSession returns a pre-existing coach session
  const sessionMock = MOCK_SCRIPT.replace(
    'let _session = null;',
    `let _session = { user: { id: 'pre-1', email: 'pre@test.com',
      user_metadata: { role: 'coach', name: 'PreCoach' } } };`
  ).replace(
    `if (_users.find(u => u.email === email))`,
    // also add the user to _users so signIn works
    `let _users = [{ id: 'pre-1', email: 'pre@test.com', user_metadata: { role: 'coach', name: 'PreCoach' } }];
            if (_users.find(u => u.email === email))`
  );
  // Actually just set _users correctly — the replace is complex, let's do it differently:
  // Use the original mock but patch __mockSB after load via addInitScript
  await ctx.addInitScript(() => {
    window.__preSession = {
      user: { id: 'pre-1', email: 'pre@test.com',
        user_metadata: { role: 'coach', name: 'PreCoach' } }
    };
  });
  const patchedMock = MOCK_SCRIPT.replace(
    'let _session = null;',
    'let _session = window.__preSession || null;'
  );
  await page.route('**cdn.jsdelivr.net**/supabase**', route =>
    route.fulfill({ contentType: 'application/javascript', body: patchedMock }));
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ body: '' }));
  await page.goto(BASE, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 12000 }).catch(() => {});
  await page.waitForSelector('#app', { state: 'visible', timeout: 8000 }).catch(() => {});
  log('Existing session → app shows directly', await page.isVisible('#app'));
  log('Login screen skipped with existing session', !(await page.isVisible('#login-screen')));
  log('Coach name shown from session', await page.$eval('#top-name', el => el.textContent) === 'PreCoach');
  await page.close();
}

// T24: ?register URL ignores existing session (client registration takes priority)
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await ctx.addInitScript(() => {
    window.__preSession = {
      user: { id: 'pre-2', email: 'existing@test.com',
        user_metadata: { role: 'coach', name: 'Existing' } }
    };
  });
  const patchedMock = MOCK_SCRIPT.replace(
    'let _session = null;',
    'let _session = window.__preSession || null;'
  );
  await page.route('**cdn.jsdelivr.net**/supabase**', route =>
    route.fulfill({ contentType: 'application/javascript', body: patchedMock }));
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ body: '' }));
  await page.goto(`${BASE}/?register`, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 12000 }).catch(() => {});
  await page.waitForSelector('#client-register-screen', { state: 'visible', timeout: 8000 }).catch(() => {});
  log('?register shows register screen even with existing session', await page.isVisible('#client-register-screen'));
  log('App not shown when ?register is in URL', !(await page.isVisible('#app')));
  await page.close();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
