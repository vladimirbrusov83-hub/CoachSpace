/**
 * One-time setup: creates the coach account in Supabase.
 * Run once: node create-coach.mjs
 * After running, delete this file or keep it private (not for clients).
 */
import { createClient } from '/home/user/CoachSpace/node_modules/@supabase/supabase-js/dist/index.mjs';

const SUPABASE_URL = 'https://zgmybxpaserhlgiugwpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_0alk20hGmQUXbFnoiyuY1g_d2qRQTjK';

const COACH_EMAIL    = 'coach@coachspace.app';
const COACH_PASSWORD = 'GoCoach1!';
const COACH_NAME     = 'Vladimir';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log(`Creating coach account: ${COACH_EMAIL}`);
const { data, error } = await sb.auth.signUp({
  email: COACH_EMAIL,
  password: COACH_PASSWORD,
  options: { data: { role: 'coach', name: COACH_NAME } }
});

if (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

if (data.user && !data.session) {
  console.log('✅ Account created. Check your email for a confirmation link before logging in.');
} else {
  console.log('✅ Account created and ready to log in.');
}
console.log(`\nYour login credentials:\n  Email:    ${COACH_EMAIL}\n  Password: ${COACH_PASSWORD}\n`);
