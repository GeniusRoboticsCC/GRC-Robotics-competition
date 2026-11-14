/* ==================================================================
   GRC Tournament · shared data layer
   ------------------------------------------------------------------
   • LIVE mode  — Supabase database + Realtime push (config.js filled in)
   • DEMO mode  — localStorage on this device only (config.js empty)
   Every page calls GRC.start() and listens with GRC.on('data', fn).
   Updates arrive three ways so screens never go stale:
     1. Realtime push (instant)       2. Re-fetch after every save
     3. Safety poll (30 s when live, 5 s when the push channel is down)
   ================================================================== */
(function () {
  'use strict';

  const CFG = window.GRC_CONFIG || {};
  const EVENT = Object.assign({
    org: 'Genius Robotics Challenge', title: 'Resource Recovery',
    date: '', time: '', venue: '', tagline: '',
  }, CFG.event || {});

  const TEAM_COUNT = 10;
  const MATCH_COUNT = 15;
  const CLOCK_MS = 180000;
  const COLORS = [
    { name: 'Red',    hex: '#ff5767', material: 'Metals' },
    { name: 'Blue',   hex: '#44b9ff', material: 'Plastics' },
    { name: 'Green',  hex: '#29c784', material: 'Glass' },
    { name: 'Yellow', hex: '#ffd34f', material: 'Paper' },
  ];
  // Same schedule as supabase/schema.sql (used to seed demo mode)
  const FIXTURES = [
    [[1, 4, 8, 9], [0, 2, 3, 1]], [[3, 6, 7, 8], [2, 1, 3, 0]], [[1, 4, 5, 7], [1, 0, 3, 2]],
    [[3, 5, 6, 9], [1, 2, 0, 3]], [[2, 3, 4, 8], [3, 0, 1, 2]], [[1, 3, 7, 10], [2, 3, 1, 0]],
    [[5, 8, 9, 10], [1, 3, 0, 2]], [[2, 4, 6, 10], [2, 3, 1, 0]], [[1, 2, 3, 9], [3, 1, 0, 2]],
    [[2, 5, 7, 8], [2, 3, 0, 1]], [[3, 4, 5, 10], [1, 2, 0, 3]], [[1, 6, 8, 10], [0, 3, 2, 1]],
    [[2, 7, 9, 10], [0, 2, 1, 3]], [[1, 2, 5, 6], [3, 1, 2, 0]], [[4, 6, 7, 9], [1, 2, 3, 0]],
  ];

  const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const MODE = CONFIGURED ? 'live' : 'demo';

  // ---------------------------------------------------------------- state
  let backend = null;
  let data = null;
  let dataSig = '';
  let user = null;
  let authReady = false;
  let serverOffset = 0;          // serverTime - localTime (ms)
  let realtimeUp = false;
  let realtimeDownSince = Date.now();
  let fetchOk = null;            // null = not tried yet
  let lastFetch = 0;
  let lastError = '';
  let started = false;

  const subs = { data: new Set(), status: new Set(), auth: new Set() };
  function emit(kind, value) {
    subs[kind].forEach(fn => { try { fn(value); } catch (e) { console.error(e); } });
  }
  function on(kind, fn) {
    subs[kind].add(fn);
    if (kind === 'data' && data) fn(data);
    if (kind === 'status') fn(getStatus());
    if (kind === 'auth' && authReady) fn(user);
    return () => subs[kind].delete(fn);
  }

  // ---------------------------------------------------------------- helpers
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const validScores = a => Array.isArray(a) && a.length === 4 && a.every(n => Number.isInteger(n) && n >= 0 && n <= 9999);
  // An extra match's line-up: four different teams (1–10), each robot colour (0–3) used once. Same rule as the database.
  function checkLineup(teamIds, colors) {
    if (!Array.isArray(teamIds) || teamIds.length !== 4 || new Set(teamIds).size !== 4
        || !teamIds.every(t => Number.isInteger(t) && t >= 1 && t <= TEAM_COUNT))
      throw new Error('Pick four different teams');
    if (!Array.isArray(colors) || colors.length !== 4 || colors.slice().sort().join() !== '0,1,2,3')
      throw new Error('Use each robot colour (red, blue, green, yellow) once');
  }

  function parseTime(s) {
    if (!s) return NaN;
    if (typeof s === 'number') return s;
    // Postgres returns microseconds; trim to milliseconds so every browser (incl. Safari) parses it
    return Date.parse(String(s).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  }
  const serverNow = () => Date.now() + serverOffset;

  function formatTime(ms) {
    const n = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }

  // ---------------------------------------------------------------- live stream (YouTube)
  // The database stores only a YouTube video ID (11 chars) or channel ID (UC + 22 chars).
  const STREAM_RE = /^([A-Za-z0-9_-]{11}|UC[A-Za-z0-9_-]{22})$/;
  const isChannel = src => src.length === 24 && src.startsWith('UC');

  // Turn whatever staff paste (watch link, youtu.be, /live/, Studio link, embed, channel link) into an ID
  function parseStream(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    if (STREAM_RE.test(s)) return s;
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); }
    catch (e) { throw new Error('Paste the YouTube link of your stream (Share → Copy link).'); }
    const host = u.hostname.replace(/^(www|m)\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    let id = null;
    if (host === 'youtu.be') id = parts[0];
    else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      if (u.searchParams.get('v')) id = u.searchParams.get('v');
      else if (parts[0] === 'embed' && parts[1] === 'live_stream') id = u.searchParams.get('channel');
      else if (['live', 'embed', 'shorts', 'v', 'video'].includes(parts[0])) id = parts[1];   // video/ID = YouTube Studio
      else if (parts[0] === 'channel') id = parts[1];
      else if (parts[0] && parts[0].startsWith('@'))
        throw new Error('That is your channel name link. Open the live stream itself and use Share → Copy link.');
    }
    if (id && STREAM_RE.test(id)) return id;
    throw new Error("That doesn't look like a YouTube stream link. In YouTube use Share → Copy link.");
  }
  const streamEmbedUrl = src => {
    const p = 'autoplay=1&mute=1&playsinline=1&rel=0';
    return isChannel(src) ? `https://www.youtube.com/embed/live_stream?channel=${src}&${p}` : `https://www.youtube.com/embed/${src}?${p}`;
  };
  const streamWatchUrl = src => isChannel(src) ? `https://www.youtube.com/channel/${src}/live` : `https://www.youtube.com/watch?v=${src}`;

  function friendlyError(e) {
    const msg = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/set_live_stream/.test(msg) && /could not find|does not exist/i.test(msg))
      return new Error('The live stream needs a one-time database update: run supabase/live_stream.sql in the Supabase SQL Editor.');
    if (/set_live_score/.test(msg) && /could not find|does not exist/i.test(msg))
      return new Error('Live +/− scoring needs a one-time database update: run supabase/live_scores.sql in the Supabase SQL Editor.');
    if (/(add_match|update_match|delete_match)/.test(msg) && /could not find|does not exist/i.test(msg))
      return new Error('Extra matches need a one-time database update: run supabase/extra_matches.sql in the Supabase SQL Editor.');
    if (/matches_id_check/.test(msg)) return new Error('There are already too many matches.');
    if ((e && e.code === '42501') || /not authori[sz]ed|permission denied/i.test(msg))
      return new Error('This account is not allowed to make changes. Ask the organiser to add your email to the staff list.');
    if (/invalid login credentials/i.test(msg)) return new Error('Wrong email or password.');
    if (/email not confirmed/i.test(msg)) return new Error('This email is not confirmed yet. In Supabase, confirm the user or tick "Auto Confirm User".');
    if (/jwt expired/i.test(msg)) return new Error('Your session expired. Please sign in again.');
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg))
      return new Error('No connection to the server. Check the internet and try again.');
    return new Error(msg);
  }

  function toast(msg, kind) {
    let el = $('grc-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'grc-toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', kind === 'error');
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : 2600);
  }

  // ---------------------------------------------------------------- normalise
  function normalize(raw) {
    const rawTeams = raw.teams || [];
    const teams = Array.from({ length: TEAM_COUNT }, (_, i) => {
      const t = rawTeams.find(x => Number(x.id) === i + 1);
      const name = t && String(t.name || '').trim();
      return { id: i + 1, name: name || 'Team ' + (i + 1) };
    });
    const matches = (raw.matches || []).map(m => ({
      id: Number(m.id),
      team_ids: (m.team_ids || []).map(Number),
      colors: (m.colors || []).map(Number),
      scores: Array.isArray(m.scores) ? m.scores.map(Number) : null,
      scored_at: m.scored_at || null,
      // running score from the +/− buttons (not final until "Save scores"); see supabase/live_scores.sql
      live_scores: Array.isArray(m.live_scores) && m.live_scores.length === 4 ? m.live_scores.map(Number) : null,
      // matches 16+ are extra matches added by judges, with an optional name like "Final"; see supabase/extra_matches.sql
      label: typeof m.label === 'string' && m.label.trim() ? m.label.trim() : null,
      extra: Number(m.id) > MATCH_COUNT,
    })).sort((a, b) => a.id - b.id);
    // false until supabase/live_scores.sql has been run (+/− then only change this device until Save)
    const live_supported = MODE === 'demo' || (raw.matches || []).some(m => Object.prototype.hasOwnProperty.call(m, 'live_scores'));
    // false until supabase/extra_matches.sql has been run (judges can't add matches yet)
    const extras_supported = MODE === 'demo' || (raw.matches || []).some(m => Object.prototype.hasOwnProperty.call(m, 'label'));
    const s = raw.state || {};
    const duration = Number(s.clock_duration_ms) || CLOCK_MS;
    let current = Number(s.current_match) || 1;
    if (!matches.some(m => m.id === current)) current = 1;
    const state = {
      current_match: current,
      clock_running: !!s.clock_running,
      clock_ends_at: s.clock_ends_at || null,
      clock_remaining_ms: Number.isFinite(Number(s.clock_remaining_ms)) && s.clock_remaining_ms !== null ? Number(s.clock_remaining_ms) : duration,
      clock_duration_ms: duration,
      // false until supabase/live_stream.sql has been run (the columns don't exist yet)
      stream_supported: MODE === 'demo' || Object.prototype.hasOwnProperty.call(s, 'stream_source'),
      stream_source: typeof s.stream_source === 'string' && STREAM_RE.test(s.stream_source) ? s.stream_source : null,
      stream_enabled: !!s.stream_enabled,
    };
    return { teams, matches, state, live_supported, extras_supported };
  }

  // ---------------------------------------------------------------- status
  function getStatus() {
    if (MODE === 'demo') return { state: 'demo', label: 'Demo mode', message: lastError };
    if (fetchOk === null) return { state: 'connecting', label: 'Connecting…', message: '' };
    if (!fetchOk) return { state: 'offline', label: 'Offline · retrying', message: lastError };
    if (realtimeUp) return { state: 'live', label: 'Live', message: '' };
    return { state: 'polling', label: 'Live · polling', message: '' };
  }
  let lastStatusKey = '';
  function pushStatus() {
    const s = getStatus();
    const key = s.state + '|' + s.message;
    if (key !== lastStatusKey) { lastStatusKey = key; emit('status', s); }
  }
  function setRealtime(up) {
    if (up === realtimeUp) return;
    realtimeUp = up;
    if (!up) realtimeDownSince = Date.now();
    pushStatus();
  }

  // ---------------------------------------------------------------- refresh
  let refreshTimer = null, inflight = null, queued = null;
  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, delay == null ? 120 : delay);
  }
  function refresh() {
    if (!backend) return Promise.resolve(data);
    // A fetch is already running: queue exactly one more so callers always get fresh data
    if (inflight) {
      if (!queued) queued = inflight.then(() => { queued = null; return refresh(); });
      return queued;
    }
    inflight = (async () => {
      try {
        const raw = await backend.fetchAll();
        if (!raw.matches || raw.matches.length < MATCH_COUNT || !raw.state)
          throw new Error('The database is not set up yet. Run supabase/schema.sql in the Supabase SQL Editor.');
        const next = normalize(raw);
        const sig = JSON.stringify(next);
        fetchOk = true;
        lastError = '';
        lastFetch = Date.now();
        if (sig !== dataSig) { dataSig = sig; data = next; emit('data', data); }
      } catch (e) {
        fetchOk = false;
        lastError = friendlyError(e).message;
        lastFetch = Date.now();
        console.warn('[GRC] refresh failed:', e);
      } finally {
        pushStatus();
        inflight = null;
      }
      return data;
    })();
    return inflight;
  }

  // ---------------------------------------------------------------- live backend (Supabase)
  function liveBackend() {
    if (!(window.supabase && window.supabase.createClient))
      throw new Error('Could not load the Supabase library. Check the internet connection and reload.');

    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'grc-tournament-auth' },
    });
    let channel = null;

    async function fetchAll() {
      const [t, m, s] = await Promise.all([
        sb.from('teams').select('id,name').order('id'),
        // '*' so the optional live_scores column comes through once live_scores.sql is run (and nothing breaks before)
        sb.from('matches').select('*').order('id'),
        // '*' so the optional live-stream columns come through once live_stream.sql is run (and nothing breaks before)
        sb.from('tournament_state').select('*').limit(1).maybeSingle(),
      ]);
      for (const r of [t, m, s]) if (r.error) throw r.error;
      return { teams: t.data, matches: m.data, state: s.data };
    }

    async function rpc(name, args) {
      const { data: out, error } = await sb.rpc(name, args || {});
      if (error) throw friendlyError(error);
      return out;
    }

    function subscribe() {
      if (channel) {
        const old = channel;
        channel = null;
        Promise.resolve(sb.removeChannel(old)).catch(() => {});
      }
      const ch = sb.channel('grc-live-' + Math.random().toString(36).slice(2, 9));
      ['teams', 'matches', 'tournament_state'].forEach(table =>
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => scheduleRefresh(60)));
      channel = ch;
      realtimeDownSince = Date.now();
      ch.subscribe(st => {
        if (ch !== channel) return;
        if (st === 'SUBSCRIBED') { setRealtime(true); scheduleRefresh(0); }
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') setRealtime(false);
      });
    }

    async function syncClock() {
      try {
        const t0 = Date.now();
        const s = await rpc('server_now');
        const t1 = Date.now();
        const srv = parseTime(s);
        if (Number.isFinite(srv) && t1 - t0 < 4000) serverOffset = srv - (t0 + t1) / 2;
      } catch (e) { /* keep previous offset */ }
    }

    async function handleSession(session) {
      const email = session && session.user ? (session.user.email || '') : null;
      let next = null;
      if (email !== null) {
        let staff;
        try { staff = !!(await rpc('is_staff')); }
        // Offline: don't lock staff out of the UI — the database still checks every write
        catch (e) { staff = user && user.email === email ? user.staff : true; }
        next = { email, staff };
      }
      const changed = !authReady || JSON.stringify(next) !== JSON.stringify(user);
      user = next;
      authReady = true;
      if (changed) emit('auth', user);
    }

    return {
      kind: 'live',
      fetchAll, rpc, subscribe, syncClock,
      watchAuth() {
        // Defer: Supabase warns against awaiting other calls inside this callback
        sb.auth.onAuthStateChange((_event, session) => setTimeout(() => handleSession(session), 0));
      },
      async signIn(email, password) {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw friendlyError(error);
      },
      // 'local' = sign out this device only. The default ('global') would log out
      // every phone/iPad/PC sharing the same staff login.
      async signOut() { await sb.auth.signOut({ scope: 'local' }); },
    };
  }

  // ---------------------------------------------------------------- demo backend (this device only)
  function demoBackend() {
    const KEY = 'grc_tournament_demo_v2';
    const blank = () => ({
      teams: Array.from({ length: TEAM_COUNT }, (_, i) => ({ id: i + 1, name: 'Team ' + (i + 1) })),
      matches: FIXTURES.map(([t, c], i) => ({ id: i + 1, team_ids: t, colors: c, scores: null, scored_at: null, live_scores: null })),
      state: { current_match: 1, clock_running: false, clock_ends_at: null, clock_remaining_ms: CLOCK_MS, clock_duration_ms: CLOCK_MS, stream_source: null, stream_enabled: false },
    });
    let memory = null;
    const read = () => {
      try {
        const v = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (v && Array.isArray(v.teams) && Array.isArray(v.matches) && v.matches.length >= MATCH_COUNT && v.state) return v;
      } catch (e) { /* storage blocked */ }
      return memory || blank();
    };
    const write = v => {
      memory = v;
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* in-memory only */ }
    };
    window.addEventListener('storage', e => { if (e.key === KEY) scheduleRefresh(0); });

    const remaining = s => (s.clock_running && s.clock_ends_at)
      ? clamp(parseTime(s.clock_ends_at) - Date.now(), 0, s.clock_duration_ms)
      : s.clock_remaining_ms;
    const find = (d, id) => d.matches.find(m => m.id === id);
    const checkMatch = (d, id) => { const m = Number.isInteger(id) && find(d, id); if (!m) throw new Error('That match does not exist'); return m; };
    const resetClock = s => Object.assign(s, { clock_running: false, clock_ends_at: null, clock_remaining_ms: s.clock_duration_ms });
    const cleanLabel = l => String(l || '').trim().slice(0, 40) || null;

    const fns = {
      save_scores(d, { p_match, p_scores }) {
        const m = checkMatch(d, p_match);
        if (p_scores !== null && !validScores(p_scores)) throw new Error('Scores must be four whole numbers from 0 to 9999');
        m.scores = p_scores;
        m.scored_at = p_scores ? new Date().toISOString() : null;
        m.live_scores = null;              // saving the final result ends live scoring (same as the database trigger)
      },
      set_live_score(d, { p_match, p_slot, p_value }) {
        const m = checkMatch(d, p_match);
        if (!Number.isInteger(p_slot) || p_slot < 0 || p_slot > 3) throw new Error('Robot must be 0, 1, 2 or 3');
        if (!Number.isInteger(p_value) || p_value < 0 || p_value > 9999) throw new Error('Points must be a whole number from 0 to 9999');
        const v = (m.live_scores || m.scores || [0, 0, 0, 0]).slice();
        v[p_slot] = p_value;
        m.live_scores = v;
        return v;
      },
      save_team_names(d, { p_names }) {
        if (!Array.isArray(p_names) || p_names.length !== TEAM_COUNT) throw new Error('Provide exactly 10 team names');
        d.teams = p_names.map((n, i) => ({ id: i + 1, name: String(n || '').trim().slice(0, 80) || 'Team ' + (i + 1) }));
      },
      set_current_match(d, { p_match }) { checkMatch(d, p_match); d.state.current_match = p_match; resetClock(d.state); },
      // Extra matches (same rules as supabase/extra_matches.sql)
      add_match(d, { p_label, p_team_ids, p_colors }) {
        checkLineup(p_team_ids, p_colors);
        const id = Math.max(MATCH_COUNT, ...d.matches.map(m => m.id)) + 1;
        if (id > 99) throw new Error('There are already too many matches');
        d.matches.push({ id, team_ids: p_team_ids.slice(), colors: p_colors.slice(), scores: null, scored_at: null, live_scores: null, label: cleanLabel(p_label) });
        d.matches.sort((a, b) => a.id - b.id);
        return id;
      },
      update_match(d, { p_match, p_label, p_team_ids, p_colors }) {
        if (!(p_match > MATCH_COUNT)) throw new Error('Only extra matches can be changed here. The 15 qualifying matches are fixed.');
        const m = checkMatch(d, p_match);
        checkLineup(p_team_ids, p_colors);
        const teamsChanged = JSON.stringify(m.team_ids) !== JSON.stringify(p_team_ids) || JSON.stringify(m.colors) !== JSON.stringify(p_colors);
        if ((m.scores || m.live_scores) && teamsChanged) throw new Error('This match already has scores. Clear its scores first, then change the teams.');
        Object.assign(m, { label: cleanLabel(p_label), team_ids: p_team_ids.slice(), colors: p_colors.slice() });
      },
      delete_match(d, { p_match }) {
        if (!(p_match > MATCH_COUNT)) throw new Error('The 15 qualifying matches cannot be deleted');
        if (d.state.current_match === p_match) throw new Error('This match is on the audience display. Show another match first, then delete it.');
        checkMatch(d, p_match);
        d.matches = d.matches.filter(m => m.id !== p_match);
      },
      clock_control(d, { p_action }) {
        const s = d.state;
        let rem = remaining(s);
        if (p_action === 'start') {
          if (s.clock_running && rem > 0) return;
          if (rem <= 0) rem = s.clock_duration_ms;
          Object.assign(s, { clock_running: true, clock_ends_at: new Date(Date.now() + rem).toISOString(), clock_remaining_ms: rem });
        } else if (p_action === 'pause') {
          Object.assign(s, { clock_running: false, clock_ends_at: null, clock_remaining_ms: rem });
        } else if (p_action === 'reset') resetClock(s);
        else throw new Error('Unknown clock action');
      },
      reset_tournament(d) {
        const b = blank(), keep = { stream_source: d.state.stream_source || null, stream_enabled: !!d.state.stream_enabled };
        d.teams = b.teams; d.matches = b.matches; d.state = Object.assign(b.state, keep);
      },
      set_live_stream(d, { p_source, p_enabled }) {
        const v = String(p_source || '').trim() || null;
        if (v && !STREAM_RE.test(v)) throw new Error('That is not a valid YouTube video or channel ID');
        d.state.stream_source = v;
        d.state.stream_enabled = !!p_enabled && !!v;
      },
      restore_tournament(d, { p_names, p_scores, p_current }) {
        if (!Array.isArray(p_scores) || p_scores.length !== MATCH_COUNT) throw new Error('Backup must contain exactly 15 matches');
        fns.save_team_names(d, { p_names });
        d.matches = d.matches.filter(m => m.id <= MATCH_COUNT);      // extras are re-added from the backup afterwards
        if (d.state.current_match > MATCH_COUNT) d.state.current_match = 1;
        p_scores.forEach((sc, i) => fns.save_scores(d, { p_match: i + 1, p_scores: sc }));
        fns.set_current_match(d, { p_match: clamp(p_current || 1, 1, MATCH_COUNT) });
      },
      // Ball release: demo mode pretends an ESP32 is connected and finishes each release after ~1 s
      release_items(d) {
        const f = d.field || (d.field = { last_id: 0, at: 0, match: null });
        if (Date.now() - f.at < 3000) throw new Error('The balls were released a moment ago. Wait 3 seconds before trying again.');
        f.last_id++;
        f.at = Date.now();
        f.match = d.state.current_match;
        return f.last_id;
      },
      dropper_status(d) {
        const f = d.field || { last_id: 0, at: 0, match: null };
        const ms = Date.now() - f.at;
        const finished = ms >= 1200;
        return {
          demo: true, online: true, seen_ago: 0, info: null,
          last_done: finished ? f.last_id : Math.max(0, f.last_id - 1),
          done_ago: f.last_id && finished ? Math.floor((ms - 1200) / 1000) : null,
          latest: f.last_id ? { id: f.last_id, match: f.match, ago: Math.floor(ms / 1000) } : null,
        };
      },
    };
    const readOnly = new Set(['dropper_status']);

    return {
      kind: 'demo',
      fetchAll: async () => read(),
      rpc: async (name, args) => {
        const d = JSON.parse(JSON.stringify(read()));
        const out = fns[name](d, args || {});
        if (!readOnly.has(name)) write(d);
        return out;
      },
      subscribe() {}, syncClock: async () => {},
      watchAuth() { user = { email: 'demo@this-device', staff: true, demo: true }; authReady = true; emit('auth', user); },
      async signIn() {}, async signOut() {},
    };
  }

  // ---------------------------------------------------------------- start / loops
  function start(opts) {
    if (started) return;
    started = true;
    opts = opts || {};
    try {
      backend = MODE === 'live' ? liveBackend() : demoBackend();
    } catch (e) {
      fetchOk = false;
      lastError = e.message;
      pushStatus();
      return;
    }
    if (opts.auth) backend.watchAuth();
    backend.syncClock();
    backend.subscribe();
    refresh();

    setInterval(() => {
      if (MODE !== 'live') return;
      const since = Date.now() - lastFetch;
      if (since > (realtimeUp && fetchOk ? 30000 : 5000)) refresh();
      // Watchdog: rebuild the realtime channel if it has been down for 20 s
      if (!realtimeUp && Date.now() - realtimeDownSince > 20000) backend.subscribe();
    }, 5000);
    setInterval(() => backend.syncClock(), 5 * 60 * 1000);

    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      refresh();
      backend.syncClock();
      if (MODE === 'live' && !realtimeUp) backend.subscribe();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
  }

  async function mutate(name, args) {
    if (!backend) throw new Error(lastError || 'Not connected');
    try { await backend.rpc(name, args); }
    catch (e) { throw friendlyError(e); }
    await refresh();
  }

  // A database call that returns a value and doesn't change the tournament data
  async function call(name, args) {
    if (!backend) throw new Error(lastError || 'Not connected');
    try { return await backend.rpc(name, args); }
    catch (e) { throw friendlyError(e); }
  }

  // ---------------------------------------------------------------- tournament maths
  const teamName = (d, id) => {
    const t = d && d.teams[id - 1];
    return (t && t.name) || 'Team ' + id;
  };
  const scoredCount = d => d.matches.filter(m => m.scores).length;

  function standings(d, excludeMatchId) {
    const rows = d.teams.map(t => ({ id: t.id, team: t.name, played: 0, scheduled: 0, total: 0, best: 0, avg: 0 }));
    const byId = new Map(rows.map(r => [r.id, r]));
    d.matches.forEach(m => {
      m.team_ids.forEach(tid => { const r = byId.get(tid); if (r) r.scheduled++; });
      if (!m.scores || m.id === excludeMatchId) return;
      m.team_ids.forEach((tid, slot) => {
        const r = byId.get(tid);
        if (!r) return;
        const v = m.scores[slot];
        r.played++;
        r.total += v;
        r.best = Math.max(r.best, v);
      });
    });
    rows.forEach(r => { r.avg = r.played ? r.total / r.played : 0; });
    // Ranked by average points per match played (award 1), then best single match (award 2), then total
    rows.sort((a, b) => b.avg - a.avg || b.best - a.best || b.total - a.total || a.id - b.id);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  // Standings plus how many places each team moved since the last scored match
  function standingsWithMovement(d) {
    const rows = standings(d);
    const scored = d.matches.filter(m => m.scores);
    if (scored.length >= 2) {
      const latest = scored.reduce((a, b) => (parseTime(b.scored_at) || 0) > (parseTime(a.scored_at) || 0) ? b : a);
      const before = new Map(standings(d, latest.id).map(r => [r.id, r.rank]));
      rows.forEach(r => { r.move = (before.get(r.id) || r.rank) - r.rank; });
      rows.latestMatch = latest.id;
    } else rows.forEach(r => { r.move = 0; });
    return rows;
  }

  function clockRemaining(d) {
    const s = d && d.state;
    if (!s) return CLOCK_MS;
    if (s.clock_running && s.clock_ends_at) return clamp(parseTime(s.clock_ends_at) - serverNow(), 0, s.clock_duration_ms);
    return s.clock_remaining_ms;
  }

  // The scores to show for a match: the running +/− score while one exists, otherwise the final result
  const shownScores = m => (m && (m.live_scores || m.scores)) || null;
  // Final = saved with "Save scores" and no running score on top (only final scores count in the standings)
  const isFinal = m => !!(m && m.scores && !m.live_scores);

  // Matches are looked up by number, never by position: extra matches (16+) can be added and deleted
  const matchById = (d, id) => (d && d.matches.find(m => m.id === id)) || null;
  // "Match 7", or an extra match's own name ("Final"), falling back to "Match 16"
  const matchName = (d, idOrMatch) => {
    const m = typeof idOrMatch === 'object' ? idOrMatch : matchById(d, idOrMatch);
    const id = m ? m.id : idOrMatch;
    return (m && m.label) || 'Match ' + id;
  };
  // The match before/after this one in running order (dir = -1 or +1), or null at either end
  const adjacentMatch = (d, id, dir) => {
    const i = d.matches.findIndex(m => m.id === id);
    return (i >= 0 && d.matches[i + dir]) || null;
  };

  // Where a match is right now: final / in progress / live scoring / paused / awaiting scores / on deck / upcoming
  function matchPhase(d, matchId) {
    const m = matchById(d, matchId);
    if (isFinal(m)) return { key: 'final', label: 'Final scores' };
    const scoring = !!(m && m.live_scores);
    if (d.state.current_match !== matchId)
      return scoring ? { key: 'scoring', label: 'Live scoring' } : { key: 'upcoming', label: 'Not scored yet' };
    const rem = clockRemaining(d);
    if (d.state.clock_running && rem > 0) return { key: 'live', label: 'In progress' };
    if (rem <= 0) return { key: 'awaiting', label: scoring ? 'Awaiting final scores' : 'Awaiting scores' };
    if (scoring) return { key: 'scoring', label: 'Live scoring' };
    if (rem < d.state.clock_duration_ms) return { key: 'paused', label: 'Clock paused' };
    return { key: 'ondeck', label: 'On deck' };
  }

  function highScore(d) {
    let best = null;
    d.matches.forEach(m => {
      if (!m.scores) return;
      m.scores.forEach((v, slot) => {
        if (!best || v > best.points) best = { points: v, team: teamName(d, m.team_ids[slot]), match: m.id };
      });
    });
    return best;
  }

  // The two tournament awards. Each returns null before any points are scored, otherwise
  // { value, final, teams: [{ id, team, matches? }] } — more than one team means a tie.
  // final = all matches are scored, so the leader is the winner.
  function awards(d) {
    const final = scoredCount(d) === d.matches.length;      // every match, extra matches included
    const rows = standings(d).filter(r => r.played);
    let average = null, single = null;
    if (rows.length && rows[0].avg > 0) {
      const top = rows[0].avg;
      average = { value: top, final, teams: rows.filter(r => Math.abs(r.avg - top) < 1e-9).map(r => ({ id: r.id, team: r.team })) };
    }
    const hs = highScore(d);
    if (hs && hs.points > 0) {
      const byTeam = new Map();
      d.matches.forEach(m => m.scores && m.scores.forEach((v, slot) => {
        if (v !== hs.points) return;
        const id = m.team_ids[slot];
        if (!byTeam.has(id)) byTeam.set(id, { id, team: teamName(d, id), matches: [] });
        byTeam.get(id).matches.push(m.id);
      }));
      single = { value: hs.points, final, teams: Array.from(byTeam.values()) };
    }
    return { average, single };
  }
  const formatAvg = n => (Math.round(n * 10) / 10).toFixed(1);

  // ---------------------------------------------------------------- backups (compatible with the original admin file)
  function exportBackup() {
    if (!data) throw new Error('Nothing loaded yet');
    const contents = JSON.stringify({
      version: 2,
      event: EVENT.org + ' · ' + EVENT.title,
      exportedAt: new Date().toISOString(),
      teams: data.teams.map(t => t.name),
      // the 15 qualifying matches stay in the original format, so old and new backups both restore
      scores: data.matches.filter(m => !m.extra).map(m => m.scores),
      selectedMatch: data.state.current_match <= MATCH_COUNT ? data.state.current_match - 1 : 0,
      extra_matches: data.matches.filter(m => m.extra).map(m => ({ label: m.label, team_ids: m.team_ids, colors: m.colors, scores: m.scores })),
    }, null, 2);
    const blob = new Blob([contents], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'GRC_Tournament_Backup_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function parseBackup(text) {
    let v;
    try { v = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
    const names = Array.isArray(v && v.teams) ? v.teams.map(t => typeof t === 'string' ? t : (t && t.name) || '') : null;
    if (!names || names.length !== TEAM_COUNT || names.some(n => typeof n !== 'string' || n.length > 80))
      throw new Error('The backup must contain 10 team names.');
    if (!Array.isArray(v.scores) || v.scores.length !== MATCH_COUNT || !v.scores.every(r => r === null || validScores(r)))
      throw new Error('The backup must contain 15 matches of scores.');
    const current = clamp((Number(v.selectedMatch) || 0) + 1, 1, MATCH_COUNT);
    // Extra matches (backups made after extra_matches.sql); older backups simply have none
    const extras = v.extra_matches == null ? [] : v.extra_matches;
    if (!Array.isArray(extras) || extras.length > 99 - MATCH_COUNT) throw new Error('The extra matches in this backup are not valid.');
    extras.forEach((x, i) => {
      try { checkLineup(x && x.team_ids, x && x.colors); }
      catch (e) { throw new Error('Extra match ' + (i + 1) + ' in the backup is not valid: ' + e.message); }
      if (!(x.scores === null || x.scores === undefined || validScores(x.scores)) || (x.label != null && (typeof x.label !== 'string' || x.label.length > 40)))
        throw new Error('Extra match ' + (i + 1) + ' in the backup is not valid.');
    });
    return { names, scores: v.scores, current, extras };
  }

  // Restore = the 15 qualifying matches in one database step, then re-add the backup's extra matches
  async function restoreBackup(b) {
    await mutate('restore_tournament', { p_names: b.names, p_scores: b.scores, p_current: b.current });
    for (const x of b.extras || []) {
      const id = await call('add_match', { p_label: x.label || null, p_team_ids: x.team_ids, p_colors: x.colors });
      if (x.scores) await call('save_scores', { p_match: Number(id), p_scores: x.scores });
    }
    if (b.extras && b.extras.length) await refresh();
  }

  // ---------------------------------------------------------------- screen wake lock (projector / phones)
  function keepAwake() {
    let lock = null;
    const req = async () => {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || lock) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch (e) { /* not allowed yet, retry on next tap */ }
    };
    document.addEventListener('visibilitychange', req);
    document.addEventListener('pointerdown', req, { passive: true });
    req();
  }

  // ---------------------------------------------------------------- public API
  window.GRC = {
    MODE, EVENT, COLORS, TEAM_COUNT, MATCH_COUNT, CLOCK_MS,
    start, on, refresh,
    get data() { return data; },
    get user() { return user; },
    get status() { return getStatus(); },
    signIn: (email, pw) => backend ? backend.signIn(email, pw) : Promise.reject(new Error(lastError)),
    signOut: () => backend && backend.signOut(),
    saveScores: (match, scores) => mutate('save_scores', { p_match: match, p_scores: scores }),
    saveTeamNames: names => mutate('save_team_names', { p_names: names }),
    setCurrentMatch: match => mutate('set_current_match', { p_match: match }),
    clock: action => mutate('clock_control', { p_action: action }),
    resetTournament: () => mutate('reset_tournament'),
    restoreBackup,
    // Extra matches added by judges (see supabase/extra_matches.sql). team_ids/colors: 4 each, colours 0–3 once.
    addMatch: async (label, teamIds, colors) => { checkLineup(teamIds, colors); const id = await call('add_match', { p_label: label || null, p_team_ids: teamIds, p_colors: colors }); await refresh(); return Number(id); },
    updateMatch: async (match, label, teamIds, colors) => { checkLineup(teamIds, colors); await mutate('update_match', { p_match: match, p_label: label || null, p_team_ids: teamIds, p_colors: colors }); },
    deleteMatch: match => mutate('delete_match', { p_match: match }),
    checkLineup, matchById, matchName, adjacentMatch,
    // Ball release (ESP32 servo, see esp32/README.md)
    releaseItems: () => call('release_items'),
    dropperStatus: () => call('dropper_status'),
    // Live stream (YouTube, see supabase/live_stream.sql)
    setLiveStream: (source, enabled) => mutate('set_live_stream', { p_source: source || null, p_enabled: !!enabled }),
    parseStream, streamEmbedUrl, streamWatchUrl,
    // Live +/− scoring (see supabase/live_scores.sql). slot 0–3 = the match's four robots
    setLiveScore: (match, slot, value) => mutate('set_live_score', { p_match: match, p_slot: slot, p_value: value }),
    shownScores, isFinal,
    exportBackup, parseBackup,
    standings, standingsWithMovement, scoredCount, teamName, clockRemaining, matchPhase, highScore, awards, formatAvg, formatTime, parseTime,
    esc, toast, keepAwake, $,
  };
})();
