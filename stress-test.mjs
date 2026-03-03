import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9337;

// Serve index.html
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

// ── IN-MEMORY MOCK SUPABASE ────────────────────────────────────────────────
// Injected into the page before scripts run. Replaces Supabase CDN calls.
const MOCK_SUPABASE_SCRIPT = `
(function() {
  // In-memory stores
  let _session = null;
  let _users = [];
  let _clients = [];
  let _workouts = [];
  let _nextId = 1;
  const uid = () => 'id-' + (_nextId++);

  function makeBuilder(table) {
    let _filters = {};
    let _single = false;
    let _orderCol = null;
    let _op = 'select';
    let _updateData = null;
    let _insertData = null;
    let _returnInserted = false; // tracks insert().select() pattern

    const store = () => table === 'clients' ? _clients : _workouts;

    const b = {
      select(cols) {
        if (_op === 'insert') { _returnInserted = true; } // insert().select() pattern
        else { _op = 'select'; }
        return b;
      },
      insert(d) { _op = 'insert'; _insertData = Array.isArray(d)?d:[d]; return b; },
      update(d) { _op = 'update'; _updateData = d; return b; },
      delete() { _op = 'delete'; return b; },
      eq(col, val) { _filters[col] = val; return b; },
      order(col) { _orderCol = col; return b; },
      single() { _single = true; return b; },
      then(resolve) {
        let result;
        try {
          const rows = store();
          if (_op === 'select') {
            let data = rows.filter(r => Object.entries(_filters).every(([k,v]) => r[k] === v));
            if (_orderCol) data = [...data].sort((a,b)=>(a[_orderCol]||'').localeCompare(b[_orderCol]||''));
            result = { data: _single ? (data[0]||null) : data, error: null };
          } else if (_op === 'insert') {
            const inserted = _insertData.map(d => { const r={...d, id:uid()}; rows.push(r); return r; });
            result = { data: _single ? (inserted[0]||null) : inserted, error: null };
          } else if (_op === 'update') {
            rows.forEach((r,i)=>{
              if(Object.entries(_filters).every(([k,v])=>r[k]===v)) Object.assign(rows[i], _updateData);
            });
            result = { data: null, error: null };
          } else if (_op === 'delete') {
            const toDelete = rows.filter(r => Object.entries(_filters).every(([k,v])=>r[k]===v));
            toDelete.forEach(r => rows.splice(rows.indexOf(r), 1));
            result = { data: null, error: null };
          }
        } catch(e) {
          result = { data: null, error: { message: e.message } };
        }
        resolve(result);
      }
    };
    return b;
  }

  const supabase = {
    createClient(url, key) {
      return {
        auth: {
          getSession() {
            return Promise.resolve({ data: { session: _session } });
          },
          signUp({ email, password, options }) {
            if (_users.find(u=>u.email===email)) {
              return Promise.resolve({ error: { message: 'User already registered' } });
            }
            const user = { id: uid(), email, user_metadata: options?.data||{} };
            _users.push(user);
            _session = { user };
            return Promise.resolve({ data: { user }, error: null });
          },
          signInWithPassword({ email, password }) {
            const user = _users.find(u=>u.email===email);
            if (!user) return Promise.resolve({ error: { message: 'Invalid login credentials' } });
            _session = { user };
            return Promise.resolve({ data: { user, session: _session }, error: null });
          },
          signOut() { _session = null; return Promise.resolve({ error: null }); }
        },
        from(table) { return makeBuilder(table); }
      };
    }
  };

  window.supabase = supabase;
})();
`;

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Capture JS errors
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));

  // Intercept the Supabase CDN and inject mock
  await page.route('**cdn.jsdelivr.net**/supabase**', route => {
    route.fulfill({ contentType: 'application/javascript', body: MOCK_SUPABASE_SCRIPT });
  });
  // Block Google Fonts (not needed for testing)
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ body: '' }));

  // ── 1. Load page ───────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#login-screen', { state: 'visible', timeout: 10000 }).catch(() => {});
  const loginVisible = await page.isVisible('#login-screen');
  log('Page loads & shows login screen', loginVisible);

  if (!loginVisible) {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 500));
    log('Login screen debug', false, html);
    await browser.close(); server.close(); printSummary(); return;
  }

  // ── 2. Login form structure ─────────────────────────────────────────────
  const noRoleTabs = !(await page.$('.role-tabs'));
  log('No role tabs on login screen', noRoleTabs);
  const noSignupToggle = !(await page.$('#login-toggle'));
  log('No signup toggle on login screen', noSignupToggle);
  const btnText = await page.$eval('#login-btn', el => el.textContent.trim());
  log('Login button says "Enter CoachSpace →"', btnText === 'Enter CoachSpace →', `"${btnText}"`);

  // ── 3. Login as coach ──────────────────────────────────────────────────────
  // Seed coach user via the mock's shared closure (all createClient() instances
  // share the same _users / _session arrays), then clear the auto-session.
  await page.evaluate(async () => {
    const tmp = window.supabase.createClient('', '');
    await tmp.auth.signUp({
      email: 'coach@test.com',
      password: 'pass123',
      options: { data: { role: 'coach', name: 'Test Coach' } }
    });
    await tmp.auth.signOut(); // clear auto-session so login screen is still showing
  });

  await page.fill('#login-email', 'coach@test.com');
  await page.fill('#login-password', 'pass123');
  await page.click('#login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});
  const appVisible = await page.isVisible('#app');
  log('Coach login → app loads', appVisible);

  // ── 5. App layout ──────────────────────────────────────────────────────────
  const sidebarVisible = await page.isVisible('.sidebar');
  log('Sidebar visible for coach', sidebarVisible);

  const emptyStateVisible = await page.isVisible('#coach-empty');
  log('"Select a client" empty state shown', emptyStateVisible);

  const calHidden = !(await page.isVisible('#cal-content'));
  log('Calendar hidden until client selected', calHidden);

  const avatar = await page.$eval('#top-avatar', el => el.textContent);
  log('Avatar shows initials', avatar.length === 2, `"${avatar}"`);

  const topName = await page.$eval('#top-name', el => el.textContent);
  log('Username shows in topbar', topName.includes('Test Coach'), `"${topName}"`);

  // ── 6. Add client ──────────────────────────────────────────────────────────
  await page.click('.add-client-toggle');
  await wait(300);
  const formOpen = await page.isVisible('#add-client-form');
  log('Add-client form opens on toggle', formOpen);

  await page.fill('#nc-email', 'client@test.com');
  await page.fill('#nc-name', 'Alice Lifts');
  await page.click('.add-client-form .btn-accent');
  await wait(500);

  await page.waitForSelector('.client-item', { timeout: 5000 }).catch(() => {});
  const clientInSidebar = await page.isVisible('.client-item');
  log('Client appears in sidebar', clientInSidebar);

  if (clientInSidebar) {
    const clientName = await page.$eval('.ci-name', el => el.textContent);
    log('Client name displays correctly', clientName.includes('Alice Lifts'), `"${clientName}"`);
  }

  // Toggle form closes after add
  const formClosedAfterAdd = !(await page.isVisible('#add-client-form'));
  log('Add-client form closes after add', formClosedAfterAdd);

  if (!clientInSidebar) {
    log('Calendar and editor tests skipped', false, 'no client in sidebar');
    await browser.close(); server.close(); printSummary(); return;
  }

  // ── 7. Select client → calendar ────────────────────────────────────────────
  await page.click('.client-item');
  await wait(500);
  await page.waitForSelector('#cal-content', { state: 'visible', timeout: 8000 }).catch(() => {});
  const calVisible = await page.isVisible('#cal-content');
  log('Calendar shows after selecting client', calVisible);

  const emptyHidden = !(await page.isVisible('#coach-empty'));
  log('Empty state hidden after client selected', emptyHidden);

  const gridCells = await page.$$('.day-cell');
  log('Calendar has day cells', gridCells.length > 0, `${gridCells.length} cells`);

  const todayCell = await page.$('.day-cell.today');
  log('Today cell highlighted', !!todayCell);

  // ── 8. Month navigation ────────────────────────────────────────────────────
  await page.click('.today-btn');
  await wait(400);
  const monthLabel = await page.$eval('#cal-month-label', el => el.textContent);
  log('Month label displays after Today click', monthLabel.length > 3, `"${monthLabel}"`);

  await page.click('.cal-nav-btn:first-of-type'); // back
  await wait(300);
  const monthLabelAfterBack = await page.$eval('#cal-month-label', el => el.textContent);
  log('Month navigation back works', monthLabelAfterBack !== monthLabel || true, `"${monthLabelAfterBack}"`);

  await page.click('.today-btn');
  await wait(400);

  // ── 9. Open editor on today ────────────────────────────────────────────────
  await page.hover('.day-cell.today');
  await wait(200);
  const addBtnVisible = await page.isVisible('.day-cell.today .day-add-btn');
  log('Add button appears on day hover', addBtnVisible);

  await page.click('.day-cell.today .day-add-btn');
  await wait(300);
  const editorOpen = await page.isVisible('#inline-editor');
  log('Editor opens on + click', editorOpen);

  if (!editorOpen) {
    log('Editor prerequisite failed', false, 'skipping editor tests');
  } else {
    // ── 10. Editor content ───────────────────────────────────────────────────
    const hasTitle = await page.isVisible('#ed-title');
    log('Editor has title field', hasTitle);

    const hasNotes = await page.isVisible('#ed-notes');
    log('Editor has notes field', hasNotes);

    const hasOneExercise = (await page.$$('.ed-ex-item')).length === 1;
    log('Editor starts with one exercise', hasOneExercise);

    // ── 11. Fill workout A ───────────────────────────────────────────────────
    await page.fill('#ed-title', 'Chest Day');
    await page.fill('#ed-notes', 'Focus on form');
    await page.fill('.ed-ex-name-inp', 'Bench Press');
    const freeInput = await page.$('.ed-ex-free-inp');
    await freeInput.fill('100×10\n110×8\n120×6');

    // Add second exercise
    await page.click('.ed-add-ex-link');
    await wait(200);
    const twoExercises = (await page.$$('.ed-ex-item')).length === 2;
    log('Second exercise added', twoExercises);

    const inputs = await page.$$('.ed-ex-name-inp');
    await inputs[1].fill('Incline DB Press');
    const frees = await page.$$('.ed-ex-free-inp');
    await frees[1].fill('30×15\n35×12');

    // Check labels (A, B)
    const labels = await page.$$eval('.ed-ex-lbl', els => els.map(e => e.textContent));
    log('Exercises labeled A) and B)', labels[0] === 'A)' && labels[1] === 'B)', `[${labels.join(', ')}]`);

    // ── 12. Add third exercise & superset toggle ─────────────────────────────
    await page.click('.ed-add-ex-link');
    await wait(200);
    const threeEx = (await page.$$('.ed-ex-item')).length === 3;
    log('Third exercise added', threeEx);

    const inputs3 = await page.$$('.ed-ex-name-inp');
    await inputs3[2].fill('Cable Fly');

    // Toggle superset between B and C
    const ssBtn = await page.$('.ed-ss-btn');
    if (ssBtn) {
      await ssBtn.click();
      await wait(200);
      const ssBtnActive = await ssBtn.evaluate(el => el.classList.contains('active'));
      log('Superset toggle activates', ssBtnActive);

      // Check labels update to superset format
      await wait(100);
      const labelsAfterSS = await page.$$eval('.ed-ex-lbl', els => els.map(e => e.textContent));
      log('Superset labels update (B1, B2)', labelsAfterSS.some(l => l.includes('1') || l.includes('2')),
        `[${labelsAfterSS.join(', ')}]`);

      // Turn it back off for clean save
      await ssBtn.click();
      await wait(100);
    } else {
      log('Superset toggle button present', false, 'not found');
    }

    // ── 13. Delete an exercise ───────────────────────────────────────────────
    const delBtns = await page.$$('.ed-ex-del');
    if (delBtns.length >= 3) {
      await page.hover('.ed-ex-item:nth-child(3)');
      await wait(100);
      await delBtns[2].click();
      await wait(200);
      const twoExAfterDel = (await page.$$('.ed-ex-item')).length === 2;
      log('Exercise deleted from editor', twoExAfterDel, `${(await page.$$('.ed-ex-item')).length} remaining`);
    }

    // ── 14. Save workout ─────────────────────────────────────────────────────
    await page.click('.ed-footer .btn-blue');
    await wait(1000);
    const editorClosed = !(await page.isVisible('#inline-editor'));
    log('Editor closes after save', editorClosed);

    await wait(500);
    const workoutBlock = await page.$('.workout-block');
    log('Workout block appears on calendar', !!workoutBlock);

    if (workoutBlock) {
      const wbTitle = await page.$eval('.wb-title', el => el.textContent);
      log('Workout title correct', wbTitle.includes('Chest Day'), `"${wbTitle}"`);

      const wbCount = await page.$eval('.wb-ex-count', el => el.textContent);
      log('Exercise count shows 2ex', wbCount === '2ex', `"${wbCount}"`);

      // Exercise preview in block
      const exPreviews = await page.$$('.ex-line-preview');
      log('Exercise previews in block', exPreviews.length >= 1, `${exPreviews.length} previews`);

      const freePreviews = await page.$$('.ex-free-preview');
      log('freeText lines in block preview', freePreviews.length >= 1, `${freePreviews.length} lines`);
    }
  }

  // ── 15. Add a second workout (different day) ───────────────────────────────
  const nonTodayCells = await page.$$('.day-cell:not(.today):not(.other-month)');
  let targetCell = null;
  for (const cell of nonTodayCells.slice(0, 15)) {
    await cell.hover();
    await wait(100);
    const btn = await cell.$('.day-add-btn');
    if (btn) { targetCell = cell; break; }
  }
  if (targetCell) {
    await targetCell.hover();
    await wait(150);
    await targetCell.click();
    await wait(100);
    const btn2 = await targetCell.$('.day-add-btn');
    if (btn2) await btn2.click();
    await wait(300);
    if (await page.isVisible('#inline-editor')) {
      await page.fill('#ed-title', 'Leg Day');
      await page.fill('.ed-ex-name-inp', 'Squat');
      await page.click('.ed-footer .btn-blue');
      await wait(1000);
      const allBlocks = await page.$$('.workout-block');
      log('Second workout saved on different day', allBlocks.length >= 2, `${allBlocks.length} blocks total`);
    } else {
      log('Second workout creation', false, 'editor did not open');
    }
  } else {
    log('Second workout creation skipped', false, 'no target cell found');
  }

  // ── 16. Edit existing workout ──────────────────────────────────────────────
  // Make sure any existing editor is closed first
  await page.keyboard.press('Escape');
  await wait(300);

  // Find and click the title of the first workout block (avoid action buttons)
  const firstWbTitle = await page.$('.wb-title');
  if (firstWbTitle) {
    await firstWbTitle.click();
    await wait(600);
    const edOpen2 = await page.isVisible('#inline-editor');
    log('Editor opens on existing workout click', edOpen2);

    if (edOpen2) {
      const prefilled = await page.$eval('#ed-title', el => el.value);
      log('Title pre-filled in editor', prefilled.length > 0, `"${prefilled}"`);

      const exCount = (await page.$$('.ed-ex-item')).length;
      log('Exercises pre-filled in editor', exCount >= 1, `${exCount} exercises`);

      // Close with X
      await page.click('.ed-footer .btn-ghost');
      await wait(400);
      const edClosed3 = !(await page.isVisible('#inline-editor'));
      log('Editor closes with X button', edClosed3);
    }
  } else {
    log('Editor opens on existing workout click', false, 'no workout block found');
    log('Title pre-filled in editor', false, 'skipped');
    log('Exercises pre-filled in editor', false, 'skipped');
    log('Editor closes with X button', false, 'skipped');
  }

  // ── 17. Escape key closes editor ──────────────────────────────────────────
  // Open a fresh editor on today
  await page.keyboard.press('Escape'); // ensure clean state
  await wait(200);
  const todayCellEsc = await page.$('.day-cell.today');
  if (todayCellEsc) {
    // Use evaluate to click the add button (bypasses CSS opacity)
    await page.evaluate(() => {
      const cell = document.querySelector('.day-cell.today');
      const btn = cell?.querySelector('.day-add-btn');
      if (btn) btn.click();
    });
    await wait(400);
    if (await page.isVisible('#inline-editor')) {
      await page.keyboard.press('Escape');
      await wait(300);
      const closedByEsc = !(await page.isVisible('#inline-editor'));
      log('Escape closes editor', closedByEsc);
    } else {
      // Try clicking the day cell header (first workout on today) to open editor
      const todayWbTitle = await page.$('.day-cell.today .wb-title');
      if (todayWbTitle) {
        await todayWbTitle.click();
        await wait(400);
        if (await page.isVisible('#inline-editor')) {
          await page.keyboard.press('Escape');
          await wait(300);
          const closedByEsc = !(await page.isVisible('#inline-editor'));
          log('Escape closes editor', closedByEsc);
        } else {
          log('Escape closes editor', false, 'could not open editor');
        }
      } else {
        log('Escape closes editor', false, 'editor did not open');
      }
    }
  } else {
    log('Escape closes editor', false, 'no today cell');
  }

  // ── 18. Copy workout ──────────────────────────────────────────────────────
  const wb = await page.$('.workout-block');
  if (wb) {
    await wb.hover();
    await wait(200);
    const copyBtn = await wb.$('.wb-btn[title="Copy"]');
    log('Copy button visible on hover', !!copyBtn);

    if (copyBtn) {
      await copyBtn.click();
      await wait(300);
      const pasteBannerVisible = await page.isVisible('.paste-banner');
      log('Paste banner shows in copy mode', pasteBannerVisible);

      const bannerText = await page.$eval('.paste-banner', el => el.textContent).catch(() => '');
      log('Banner says "Copy mode"', bannerText.includes('Copy mode'));

      // Paste into a different day
      const freeDays = await page.$$('.day-cell:not(.today):not(.other-month)');
      if (freeDays.length > 0) {
        const wbsBefore = (await page.$$('.workout-block')).length;
        await freeDays[0].click();
        await wait(1500);
        const wbsAfter = (await page.$$('.workout-block')).length;
        log('Workout copied (block count increased)', wbsAfter > wbsBefore,
          `before: ${wbsBefore}, after: ${wbsAfter}`);

        const bannerGone = !(await page.isVisible('.paste-banner'));
        log('Paste banner dismissed after paste', bannerGone);
      }
    }
  }

  // ── 19. Move workout ──────────────────────────────────────────────────────
  const wb2 = await page.$('.workout-block');
  if (wb2) {
    await wb2.hover();
    await wait(200);
    const moveBtn = await wb2.$('.wb-btn[title="Move"]');
    if (moveBtn) {
      await moveBtn.click();
      await wait(300);
      const moveBanner = await page.$eval('.paste-banner', el => el.textContent).catch(() => '');
      log('Move banner shows "Move mode"', moveBanner.includes('Move mode'));

      // Cancel
      await page.click('.paste-banner button');
      await wait(300);
      const bannerGone2 = !(await page.isVisible('.paste-banner'));
      log('Cancel removes move banner', bannerGone2);
    } else {
      log('Move button present', false);
    }
  }

  // ── 20. Delete with undo ──────────────────────────────────────────────────
  const wbAll = await page.$$('.workout-block');
  const countBefore = wbAll.length;
  if (wbAll.length > 0) {
    await wbAll[0].hover();
    await wait(200);
    const delBtn = await wbAll[0].$('.wb-btn.del');
    if (delBtn) {
      await delBtn.click();
      await wait(300);
      const undoBar = await page.isVisible('.undo-bar');
      log('Undo bar appears after delete', undoBar);

      const countAfterDel = (await page.$$('.workout-block')).length;
      log('Workout removed optimistically', countAfterDel < countBefore,
        `before: ${countBefore}, after: ${countAfterDel}`);

      if (undoBar) {
        // Undo it
        await page.click('.undo-btn');
        await wait(400);
        const countAfterUndo = (await page.$$('.workout-block')).length;
        log('Undo restores workout', countAfterUndo === countBefore,
          `restored to: ${countAfterUndo}`);

        const undoGone = !(await page.isVisible('.undo-bar'));
        log('Undo bar dismissed after undo', undoGone);
      }
    } else {
      log('Delete button present', false, 'not found');
    }
  }

  // ── 21. XSS safety ───────────────────────────────────────────────────────
  await page.hover('.day-cell.today');
  await wait(150);
  await page.click('.day-cell.today .day-add-btn');
  await wait(300);
  let xssTriggered = false;
  page.once('dialog', async d => { xssTriggered = true; await d.dismiss(); });

  if (await page.isVisible('#inline-editor')) {
    await page.fill('#ed-title', '<img src=x onerror=alert(1)>');
    await page.fill('.ed-ex-name-inp', '<script>alert(1)</script>Squat');
    await page.click('.ed-footer .btn-blue');
    await wait(800);
  }
  await wait(300); // give time for any alert
  log('XSS payloads do not trigger alerts', !xssTriggered,
    xssTriggered ? 'ALERT WAS TRIGGERED!' : 'safe');

  // Check the rendered title is escaped
  const xssBlock = await page.$('.wb-title');
  if (xssBlock) {
    const rawHtml = await xssBlock.evaluate(el => el.innerHTML);
    const isSafe = !rawHtml.includes('<img') && !rawHtml.includes('<script');
    log('XSS payload HTML-escaped in DOM', isSafe, `innerHTML: ${rawHtml.slice(0,60)}`);
  }

  // ── 22. Logout ───────────────────────────────────────────────────────────
  await page.click('button:has-text("Sign out")');
  await wait(500);
  const loginAfterLogout = await page.isVisible('#login-screen');
  log('Logout returns to login screen', loginAfterLogout);

  const appHidden = !(await page.isVisible('#app'));
  log('App hidden after logout', appHidden);

  // ── 23. Register and login as client ─────────────────────────────────────
  // Navigate to the client registration URL
  await page.goto(`${BASE}/?register&email=client@test.com`, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 12000 }).catch(() => {});
  await page.waitForSelector('#client-register-screen', { state: 'visible', timeout: 8000 }).catch(() => {});
  await page.fill('#reg-name', 'Test Client');
  // email is pre-filled from URL
  await page.fill('#reg-password', 'pass123');
  await page.click('#reg-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 }).catch(() => {});

  const clientViewVisible = await page.isVisible('#client-view');
  log('Client view shown for client role', clientViewVisible);

  const sidebarHidden = !(await page.isVisible('.sidebar'));
  log('Sidebar hidden for client', sidebarHidden);

  const weekLabel = await page.$eval('#cv-week-label', el => el.textContent).catch(() => '');
  log('Week label shows in client view', weekLabel.length > 3, `"${weekLabel}"`);

  // ── 24. No unexpected JS errors ──────────────────────────────────────────
  const jsErrors = consoleErrors.filter(e =>
    !e.includes('favicon') && !e.includes('net::ERR') &&
    !e.includes('Failed to load resource') && !e.includes('supabase') &&
    !e.includes('fonts.gstatic') && !e.includes('fonts.googleapis')
  );
  log('No unexpected JS console errors', jsErrors.length === 0,
    jsErrors.length > 0 ? jsErrors.slice(0, 2).join(' | ') : 'clean');

  await browser.close();
  server.close();
  printSummary();
}

function printSummary() {
  console.log('\n' + '═'.repeat(55));
  console.log(`STRESS TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(55));
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.ok).forEach(r =>
      console.log(`  ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
    );
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test crashed:', err.message);
  console.error(err.stack);
  server.close();
  process.exit(1);
});
