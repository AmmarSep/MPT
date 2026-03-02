# MPT
Masjid Prayer Timings

## Web App
This project includes a simple static web app for managing prayer timings for multiple masjids.

- Shows 3 masjids with prayer times for `Fajr`, `Dhuhr`, `Asr`, `Maghrib`, and `Isha`.
- Lets you edit masjid names and prayer times directly in the UI.
- Saves locally and can sync to Supabase for cross-device persistence.

Open `index.html` in your browser to use the app.

## Cloud Sync Setup (GitHub Pages Compatible)
This app can run on GitHub Pages and still use server-side storage by calling Supabase directly from the browser.

1. Create a Supabase project.
2. In SQL Editor, run:

```sql
create table if not exists public.prayer_timings (
  id text primary key,
  data jsonb not null
);

alter table public.prayer_timings enable row level security;

create policy "anon can read prayer timings"
on public.prayer_timings
for select
to anon
using (true);

create policy "anon can insert prayer timings"
on public.prayer_timings
for insert
to anon
with check (true);

create policy "anon can update prayer timings"
on public.prayer_timings
for update
to anon
using (true)
with check (true);
```

3. Open `config.js` and set:
- `supabaseUrl` from `Project Settings > API > Project URL` (or use `https://<project-ref>.supabase.co/rest/v1`).
- `supabaseAnonKey` from `Project Settings > API > anon public key`.
- Optional: `supabaseTable` and `supabaseRecordId`.
4. Commit and push `config.js`, then wait for GitHub Pages deploy.

When config is set, the app loads/saves prayer timings to Supabase. If cloud sync fails, it falls back to local browser storage.
