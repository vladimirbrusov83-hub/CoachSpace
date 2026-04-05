# CoachSpace

A coaching management tool built for strength coaches who want to spend less time on admin and more time coaching.

Live: **[coach-space.vercel.app](https://coach-space.vercel.app)**

---

## What it does

CoachSpace is a web app where coaches manage all their clients and programming in one place. Clients log in separately and see only their own workouts.

**For coaches:**
- Client list with a weekly calendar view per client
- Write workouts directly into calendar cells — no extra clicks
- Built-in exercise picker with a searchable database
- Copy or move workouts between days
- Weekly volume tracker by muscle group (auto-calculated from sets, manually adjustable)
- Coach notes on individual exercises, visible to the client
- Delete with undo — so you don't panic if you mis-click

**For clients:**
- Log in and see your own programming
- Weekly view of all workouts
- Coach notes visible inline under each exercise

---

## Stack

- Single `index.html` — no framework, no build step
- [Supabase](https://supabase.com) for auth and database
- Vanilla JavaScript
- Deployed on [Vercel](https://vercel.com) — auto-deploys on every push to main

---

## Why it's built this way

This project was built by a strength coach, not a developer. The single-file approach keeps things simple — no complicated setup, no dependencies to manage, easy to understand and change. Everything lives in one place.

---

## Running locally

Just open `index.html` in a browser. No install needed.

To connect your own Supabase project, replace the `SUPABASE_URL` and `SUPABASE_KEY` values near the top of the script section in `index.html`.

---

## Status

Actively used and developed. Built and maintained by [@vladimirbrusov83-hub](https://github.com/vladimirbrusov83-hub).
