# CoachSpace — Claude Instructions

## Project Overview

Single-page coaching platform. Coaches plan workouts on a calendar; clients log in separately, see their week, add notes, mark workouts done.

- **Live:** https://coach-space.vercel.app
- **Stack:** Single `index.html` (~3230 lines) — all CSS, HTML, JS in one file. No build step, no frameworks.
- **Auth + DB:** Supabase (project: `zgmybxpaserhlgiugwpb`)
- **Fonts:** DM Sans (body) + Syne (headings) via Google Fonts
- **Supabase SDK:** loaded from `cdn.jsdelivr.net/npm/@supabase/supabase-js@2`

## How to Deploy

```
git add index.html && git commit -m "..." && git push
```

Vercel auto-deploys in ~30s. PAT is baked into the git remote — no extra auth.

## Rules

- **Single file only.** All changes go in `index.html`. Do not create new files unless explicitly asked.
- **No frameworks, no build tools.** Vanilla JS and custom CSS only.
- **CSP is on line 8.** Any new external resource (CDN, API endpoint) must be added to the `<meta http-equiv="Content-Security-Policy">` tag or the browser will block it.
- **Don't refactor for its own sake.** Fix what's asked, leave everything else alone.
- **No TypeScript, no modules, no imports.** Everything is inline script tags.

## Database Schema

### `clients`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `coach_id` | uuid | FK → auth.users |
| `name` | text | |
| `email` | text | Unique per coach |

### `workouts`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `client_id` | uuid | FK → clients |
| `coach_id` | uuid | FK → auth.users |
| `date` | text | `YYYY-MM-DD` |
| `title` | text | |
| `notes` | text | Coach-visible |
| `groups` | jsonb | Exercise groups (see below) |
| `done` | boolean | Client marked complete |
| `client_notes` | jsonb | v2 format (see below) |

## Key Data Structures

### `groups` (JSONB)
```js
[
  {
    label: 'A',           // letter A, B, C...
    type: 'single',       // or 'superset'
    exercises: [
      { name: 'Squat', freeText: '4x5 @ 80%\nRest 3 min' }
    ]
  }
]
```

### `client_notes` v2 (JSONB)
```js
{
  v: 2,
  overall: '',              // overall session note from client
  ex: { '0_0': '' },        // client notes keyed by "groupIdx_exIdx"
  coach_ex: { '0_0': '' },  // coach notes per exercise
  sets: { '0_0_0': true },  // ticked set lines, keyed "groupIdx_exIdx_lineIdx"
  dur: 2840                 // elapsed seconds, written only by markDone()
}
```

### `achievements`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `client_id` | uuid | FK → clients, cascade delete |
| `badge_id` | text | matches an `id` in the `BADGES` array in index.html |
| `earned_at` | timestamptz | |

`unique (client_id, badge_id)` — earning is an upsert with `ignoreDuplicates`, so a badge
can never be awarded twice no matter how often `evaluateBadges()` runs.

## Achievements / Badges

15 badges defined in one `BADGES` array (grouped Milestones / Consistency / Time). Adding
one is a single array entry — do not scatter conditionals.

Three things to know before touching this:

- **Badges use `w.done === true`.** This deliberately differs from `statCounts()` (needs a
  note) and `histWorkouts()` (done OR a note). Three predicates, on purpose. Badge counts
  will not match the Stats drawer, and that is not a bug.
- **Weeks anchor on `workouts.date`, the coach-scheduled date.** There is no completion
  timestamp in the schema. Do not add one — every historic workout would be NULL and every
  client would see zero badges.
- **A week with nothing scheduled skips without breaking a run** (planned deload), and the
  *current* week never breaks a run until it's finished.

`evaluateBadges()` runs silently on load and on tab refocus, and with a popup after
`markDone()` — chained 1.5s behind `cvSplash` so celebrations never stack.

## Auth & Roles

Two roles set at signup in `user_metadata.role` — never changes after signup:
- **`coach`** — sidebar + 7-column calendar + workout editor
- **`client`** — week view + per-exercise notes + mark done

Password rules: min 8 chars, at least 1 letter, at least 1 number.

## Key State Variables

```js
currentUser       // Supabase user object
currentRole       // 'coach' or 'client'
selectedClientId  // UUID of currently selected client (coach)
clientsCache      // [] array of client records
workoutsCache     // { clientId: [workouts...], '__client__': [workouts...] }
copyState         // null | { workoutId, mode: 'copy'|'move' }
editorDate        // 'YYYY-MM-DD' of open editor
editorWorkoutId   // UUID or null (null = new workout)
viewingWorkoutId  // UUID of workout client is viewing
undoTimer         // setTimeout ref for 5s delete undo
undoData          // { workout } snapshot for undo restore
cvWeekOffset      // int, weeks offset from today (client view)
calGridBuilt      // bool, prevents rebuilding DOM calendar
```

## UI Structure (key IDs)

```
#loading-screen
#login-screen
#app
  .topbar
  .app-body
    .sidebar               — client list + add client (coach only)
    .content-area
      .paste-banner        — visible in copy/move mode
      .cal-scroll → #cal-grid → .day-cell → .workout-block, .cell-editor
    #client-view → .cv-topbar (week nav), .cv-scroll > .cv-inner
      #cv-week-list → #cv-hero (greeting+progress), #cv-strip (Mon–Sun chips), #cv-list (cards)
      #cv-detail → #cvd-head (sticky: back, title, sets progress, timer), #cv-detail-content
      #cvd-foot — sticky bottom "Complete workout" / "Completed · Undo" bar
#mob-client-overlay        — mobile coach client list
#mob-editor-overlay        — mobile fullscreen editor
#history-drawer            — completed workout history (client)
.vol-tb-panel              — floating volume tracker (coach)
.undo-bar                  — delete undo toast
.notif                     — bottom-right notification toast
```

## Notable Implementation Details

- **Calendar** is built once (`calGridBuilt` flag): 3 months back, 12 months forward. Re-built only on client switch.
- **Editor** is inline in the day cell; on mobile it's a fullscreen overlay. Column 5–7 flips it left.
- **Delete undo**: optimistic delete from cache + 5s timeout before actual DB delete. Undo restores from `undoData`.
- **Volume tracker**: draggable floating panel, position saved to `localStorage`. Keys: `vol_{clientId}_{monDate}`.
- **Exercise autocomplete**: fuzzy match against `EXERCISE_DB` constant (~130 exercises, 12 groups) defined around line 801.
- **Mobile breakpoint**: `window.innerWidth <= 768`.

## LocalStorage Keys

| Key | Value |
|-----|-------|
| `lastClientId` | UUID — last selected client (coach desktop) |
| `vol_{clientId}_{monDate}` | JSON — manual volume sets per muscle |
| `vol_panel_pos` | JSON `{top, left}` — volume panel position |

## CSP (line 8)

```
default-src 'self'
script-src 'self' 'unsafe-inline' cdn.jsdelivr.net
style-src 'self' 'unsafe-inline' fonts.googleapis.com
font-src fonts.gstatic.com
connect-src *.supabase.co wss://*.supabase.co
img-src 'self' data:
```
