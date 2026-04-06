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
| `date` | date | YYYY-MM-DD |
| `title` | text | workout name |
| `notes` | text | optional session notes |
| `groups` | jsonb | exercise groups (see below) |
| `done` | boolean | client marks complete |
| `created_at` | timestamptz | auto |

#### `groups` JSON structure
```json
[
  {
    "exercises": [
      {
        "name": "Bench Press",
        "free": "4x8 @ 80kg",
        "superset": false
      },
      {
        "name": "Cable Fly",
        "free": "3x15",
        "superset": true
      }
    ]
  }
]
```
`superset: true` on an exercise means it's grouped with the one above it (shown with a blue "SS" tag).

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

-- Clients can mark workouts done
CREATE POLICY "client_mark_done" ON workouts
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
4. Go to **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://xxxx.supabase.co`)
   - **Anon/Public key** (safe-to-expose publishable key)

### 2. Update credentials in `index.html`
Find these two lines near the top of the `<script>` block (~line 763):
```js
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_KEY = 'YOUR_ANON_KEY';
```
Replace with your own values.

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
  options: { data: { role: 'coach', name: 'Vladimir' } }
})
```

At login, `initApp()` reads `currentUser.user_metadata.role` and renders either:
- **Coach UI** — sidebar with client list + monthly calendar
- **Client UI** — weekly workout list

To create a coach account: sign up and ensure `role: 'coach'` is in the metadata. There is no admin panel — if needed, update `raw_user_meta_data` directly in the Supabase dashboard under **Authentication → Users**.

---

## Coach workflow

1. Sign up with role `coach`
2. Add a client (name + email) via the sidebar
3. The client signs up separately at the same URL — their email must match exactly what the coach entered
4. Click any calendar day → opens in-cell editor to add a workout
5. Add exercises by name (autocomplete from 120+ built-in exercises), enter free-text sets/reps
6. Copy a workout block and paste it to other days
7. Volume panel (top-right button) shows weekly sets per muscle group

---

## Client workflow

1. Sign up with role `client` (default if no role set)
2. See weekly list of workouts assigned by coach
3. Tap a workout to view exercises
4. Tap "Mark as Done" — sets `done: true` in the database
5. Navigate forward/back by week; view full history via the History button

---

## File structure

```
CoachSpace/
└── index.html        # entire app — HTML, CSS, and JS in one file
```

No `package.json`, no dependencies to install, no build step.

---

## Password rules (enforced at signup)

- Minimum 8 characters
- At least one letter
- At least one number

---

## Exercise database

Built-in `EXERCISE_DB` covering 12 muscle groups (~120 exercises). Coaches can also type any custom name — autocomplete just suggests from the built-in list.

**Groups:** Chest · Shoulders · Triceps · Back · Biceps · Legs (Quads / Hamstrings / Glutes) · Calves · Core · Olympic / Full Body · Cardio
