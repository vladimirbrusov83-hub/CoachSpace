# CoachSpace

A single-file coaching platform where coaches program workouts for clients and clients track completion — all in one `index.html`, no build step required.

**Live site:** https://coach-space.vercel.app

---

## What it does

- **Coach view** — monthly calendar per client, add/edit/delete workouts with exercises, copy-paste days, volume tracking, workout history drawer
- **Client view** — weekly list of assigned workouts, tap to view details and mark done
- **Two roles** — coach and client are set at signup via `user_metadata.role` in Supabase Auth

---

## Tech stack

| Layer | Tool |
|---|---|
| Frontend | Vanilla JS + HTML/CSS (single `index.html`) |
| Auth | Supabase Auth (email + password) |
| Database | Supabase Postgres |
| Fonts | DM Sans + Syne (Google Fonts) |
| Supabase JS client | CDN via jsDelivr (`@supabase/supabase-js@2`) |
| Hosting | Vercel (auto-deploys on push to `main`) |

---

## Auth flows

### Sign up
New users register with email + password. Role defaults to `client`. All new accounts are auto-confirmed — no email verification step required.

Password rules (enforced client-side + server-side minimum):
- Minimum 8 characters (enforced by Supabase server)
- At least one letter
- At least one number

### Sign in
Email + password via Supabase `signInWithPassword`.

### Forgot password
A "Forgot password?" link on the login screen sends a reset email via `sb.auth.resetPasswordForEmail()`. The link in the email points to `https://coach-space.vercel.app`. When the user clicks it, the app detects the `PASSWORD_RECOVERY` event in `onAuthStateChange` and shows a "Set New Password" screen. After setting the new password the user is automatically signed in.

### Change password (in-app)
Logged-in users can change their password via the **Password** button in the top-right toolbar. Opens a modal with the same password rules enforced.

### Role assignment
Role is set once at signup in `user_metadata.role` and never changes. Signing up via the public form always assigns `role: 'client'`. The coach account must be created with `role: 'coach'` set manually (see below).

---

## Database schema

Two tables in Supabase:

### `clients`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | auto |
| `coach_id` | uuid | references auth.users.id |
| `name` | text | display name |
| `email` | text | must match client's auth email |
| `created_at` | timestamptz | auto |

### `workouts`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | auto |
| `client_id` | uuid | references clients.id |
| `coach_id` | uuid | references auth.users.id |
| `date` | text | YYYY-MM-DD |
| `title` | text | workout name |
| `notes` | text | optional session notes |
| `groups` | jsonb | exercise groups (see below) |
| `done` | boolean | client marks complete |
| `client_notes` | jsonb | v2 format (see below) |
| `created_at` | timestamptz | auto |

#### `groups` JSON structure
```json
[
  {
    "label": "A",
    "type": "single",
    "exercises": [
      { "name": "Bench Press", "freeText": "4x8 @ 80kg" }
    ]
  },
  {
    "label": "B",
    "type": "superset",
    "exercises": [
      { "name": "Cable Fly", "freeText": "3x15" },
      { "name": "Push-up", "freeText": "3x20" }
    ]
  }
]
```

#### `client_notes` v2 JSON structure
```json
{
  "v": 2,
  "overall": "Felt good today",
  "ex": { "0_0": "Left shoulder tight" },
  "coach_ex": { "0_0": "Watch form on descent" }
}
```
Keys like `"0_0"` are `groupIndex_exerciseIndex`.

---

## Row Level Security (RLS)

Enable RLS on both tables. Apply these policies:

### `clients` table
```sql
-- Coaches can manage their own clients
CREATE POLICY "coach_full_access" ON clients
  USING (coach_id = auth.uid())
  WITH CHECK (coach_id = auth.uid());
```

### `workouts` table
```sql
-- Coaches can manage workouts for their clients
CREATE POLICY "coach_workout_access" ON workouts
  USING (
    client_id IN (
      SELECT id FROM clients WHERE coach_id = auth.uid()
    )
  )
  WITH CHECK (
    client_id IN (
      SELECT id FROM clients WHERE coach_id = auth.uid()
    )
  );

-- Clients can read their own workouts
CREATE POLICY "client_read_own" ON workouts
  FOR SELECT USING (
    client_id IN (
      SELECT id FROM clients WHERE email = auth.email()
    )
  );

-- Clients can mark workouts done and add notes
CREATE POLICY "client_update_own" ON workouts
  FOR UPDATE USING (
    client_id IN (
      SELECT id FROM clients WHERE email = auth.email()
    )
  )
  WITH CHECK (true);
```

---

## How to replicate

### 1. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) → New project
2. Create the two tables above (run the SQL in the Supabase SQL editor)
3. Enable RLS and apply the policies above
4. Go to **Authentication → Providers → Email** and turn off **"Confirm email"** so clients can log in immediately
5. Go to **Authentication → URL Configuration** and set **Site URL** to your production domain
6. Go to **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://xxxx.supabase.co`)
   - **Anon/Public key**

### 2. Update credentials in `index.html`
Find these two lines near the top of the `<script>` block:
```js
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_KEY = 'YOUR_ANON_KEY';
```

### 3. Deploy to Vercel
1. Push the repo to GitHub
2. Import at [vercel.com/new](https://vercel.com/new)
3. No build settings needed — Vercel serves `index.html` as a static site
4. Every push to `main` auto-deploys

---

## How roles work

Role is stored in Supabase Auth `user_metadata` at signup:

```js
await sb.auth.signUp({
  email,
  password,
  options: { data: { role: 'client', name: 'John' } }
})
```

At login, `initApp()` reads `currentUser.user_metadata.role` and renders either:
- **Coach UI** — sidebar with client list + monthly calendar
- **Client UI** — weekly workout list

To create the coach account: sign up normally, then go to **Supabase Dashboard → Authentication → Users**, find the account, and edit `raw_user_meta_data` to set `"role": "coach"`. There is no in-app admin panel.

---

## Coach workflow

1. Create account and set `role: 'coach'` in Supabase dashboard
2. Add a client (name + email) via the sidebar
3. The client signs up at the same URL — their email must match what the coach entered
4. Click any calendar day → opens in-cell editor to add a workout
5. Add exercises by name (autocomplete from 120+ built-in exercises), enter free-text sets/reps
6. Copy a workout block and paste it to other days
7. Volume panel (top-right button) shows weekly sets per muscle group

---

## Client workflow

1. Sign up at the app URL (role defaults to `client`)
2. See weekly list of workouts assigned by coach
3. Tap a workout to view exercises
4. Add per-exercise notes or an overall session note
5. Tap "Mark as Done" — sets `done: true` in the database
6. Navigate forward/back by week; view full history via the History button
7. Change password anytime via the **Password** button in the top toolbar

---

## File structure

```
CoachSpace/
└── index.html        # entire app — HTML, CSS, and JS in one file
```

No `package.json`, no dependencies to install, no build step.

---

## Exercise database

Built-in `EXERCISE_DB` covering 12 muscle groups (~120 exercises). Coaches can also type any custom name — autocomplete just suggests from the built-in list.

**Groups:** Chest · Shoulders · Triceps · Back · Biceps · Legs (Quads / Hamstrings / Glutes) · Calves · Core · Olympic / Full Body · Cardio
