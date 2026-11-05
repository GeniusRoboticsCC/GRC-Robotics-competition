/* ------------------------------------------------------------------
   GRC Tournament · configuration
   ------------------------------------------------------------------
   1. In Supabase open Project Settings → API (or "API Keys").
   2. Copy the Project URL and the anon / publishable key below.
      Both are designed to be public — your data is protected by the
      database rules in supabase/schema.sql, not by hiding this key.
      NEVER paste the service_role / secret key here.
   3. Leave them empty to run in DEMO MODE (data stays on one device).
   ------------------------------------------------------------------ */
window.GRC_CONFIG = {
  supabaseUrl: 'https://qponplxxgemmiijcboza.supabase.co',
  supabaseAnonKey: 'sb_publishable_zkTme6JRjK6DrRyzd_r6hQ_gZf-AyvK',

  event: {
    org: 'Genius Robotics Challenge',
    title: 'Resource Recovery',
    date: 'Sat 14 November 2026',
    time: '09:30–12:00',
    venue: 'Bell St, Southern Industrial · Windhoek',
    tagline: 'Engineering a cleaner future',
  },
};
