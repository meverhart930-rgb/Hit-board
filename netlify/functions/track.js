// Results tracking for El Jefe's Hit List.
// Actions:
//   POST ?action=save    body: {date, firstPitch, picks:[{id,name,team,opp,prob,gamePk,confirmed}]}
//   GET  ?action=record  -> {days:[...], summary:{...}}
//   GET  ?action=grade   -> grades any pending past days against final box scores
import { getStore } from "@netlify/blobs";

const MLB = "https://statsapi.mlb.com";
const store = () => getStore("hitlist");

const etToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); // YYYY-MM-DD

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "record";
  try {
    if (action === "save" && req.method === "POST") return await save(req);
    if (action === "grade") return await grade();
    return await record();
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
};

async function save(req) {
  const body = await req.json();
  const { date, firstPitch, picks } = body || {};
  if (!date || !Array.isArray(picks) || !picks.length) return json({ ok: false, reason: "bad payload" }, 400);
  if (date !== etToday()) return json({ ok: false, reason: "only today (ET) can be saved" });

  const s = store();
  const key = "snap:" + date;
  const existing = await s.get(key, { type: "json" }).catch(() => null);
  if (existing) {
    if (existing.graded) return json({ ok: false, reason: "already graded" });
    // Don't let a rebuild after games started overwrite the pre-pitch snapshot.
    if (existing.firstPitch && Date.now() > Date.parse(existing.firstPitch))
      return json({ ok: false, reason: "games underway; keeping original snapshot" });
  }
  const clean = arr => (Array.isArray(arr) ? arr : []).slice(0, 12).map(p => ({
    id: +p.id, name: String(p.name || ""), team: p.team || "", opp: p.opp || "",
    prob: Math.max(0, Math.min(1, +p.prob || 0)), gamePk: +p.gamePk || null,
    confirmed: !!p.confirmed
  }));
  const snap = {
    date,
    firstPitch: firstPitch || null,
    savedAt: new Date().toISOString(),
    picks: clean(picks),
    hrPicks: clean(body.hrPicks),
    graded: false
  };
  await s.setJSON(key, snap);
  return json({ ok: true, saved: snap.picks.length });
}

async function grade() {
  const s = store();
  const today = etToday();
  const { blobs } = await s.list({ prefix: "snap:" });
  const pending = [];
  for (const b of blobs) {
    const d = b.key.slice(5);
    if (d < today) pending.push(b.key);
  }
  pending.sort();
  const doneDays = [];
  for (const key of pending.slice(-10)) { // safety cap per run
    const snap = await s.get(key, { type: "json" }).catch(() => null);
    if (!snap || snap.graded) continue;

    const ageDays = Math.floor((Date.parse(today) - Date.parse(snap.date)) / 86400000);
    // ONE call per day: which of the day's games are final.
    const finals = await fetchFinals(snap.date);
    if (!finals && ageDays < 3) continue; // schedule unreachable; retry next run

    const boxCache = new Map();
    let allSettled = true;
    const results = [];

    for (const p of snap.picks) {
      if (!p.gamePk) { results.push({ ...p, outcome: "dnp" }); continue; }
      const isFinal = finals ? finals.get(p.gamePk) === true : false;
      if (!isFinal) {
        if (ageDays < 3) { allSettled = false; results.push({ ...p, outcome: "pending" }); }
        else results.push({ ...p, outcome: "dnp" }); // postponed/stale -> void
        continue;
      }
      let box = boxCache.get(p.gamePk);
      if (box === undefined) {
        box = await fetchBox(p.gamePk);
        boxCache.set(p.gamePk, box);
      }
      if (!box) {
        if (ageDays < 3) { allSettled = false; results.push({ ...p, outcome: "pending" }); }
        else results.push({ ...p, outcome: "dnp" });
        continue;
      }
      const st = box.players["ID" + p.id];
      const ab = st ? (+st.atBats || 0) : 0;
      const hits = st ? (+st.hits || 0) : 0;
      const pa = st ? (+st.plateAppearances || ab) : 0;
      if (!st || pa === 0) results.push({ ...p, outcome: "dnp" });
      else results.push({ ...p, outcome: hits >= 1 ? "hit" : "miss", hits, ab });
    }

    // HR picks: same boxes, different outcome (homered / no / dnp)
    const hrResults = [];
    for (const p of (snap.hrPicks || [])) {
      if (!p.gamePk) { hrResults.push({ ...p, outcome: "dnp" }); continue; }
      const isFinal = finals ? finals.get(p.gamePk) === true : false;
      if (!isFinal) {
        if (ageDays < 3) { allSettled = false; hrResults.push({ ...p, outcome: "pending" }); }
        else hrResults.push({ ...p, outcome: "dnp" });
        continue;
      }
      let box = boxCache.get(p.gamePk);
      if (box === undefined) { box = await fetchBox(p.gamePk); boxCache.set(p.gamePk, box); }
      if (!box) {
        if (ageDays < 3) { allSettled = false; hrResults.push({ ...p, outcome: "pending" }); }
        else hrResults.push({ ...p, outcome: "dnp" });
        continue;
      }
      const st = box.players["ID" + p.id];
      const pa = st ? (+st.plateAppearances || +st.atBats || 0) : 0;
      const hrs = st ? (+st.homeRuns || 0) : 0;
      if (!st || pa === 0) hrResults.push({ ...p, outcome: "dnp" });
      else hrResults.push({ ...p, outcome: hrs >= 1 ? "hr" : "no", hrs });
    }
    if (!allSettled && ageDays < 3) continue; // try again next run
    snap.picks = results;
    snap.hrPicks = hrResults;
    snap.graded = true;
    snap.gradedAt = new Date().toISOString();
    await s.setJSON(key, snap);
    doneDays.push(snap.date);
  }
  return json({ ok: true, graded: doneDays });
}

async function fetchFinals(date) {
  try {
    const r = await fetch(`${MLB}/api/v1/schedule?sportId=1&date=${date}`);
    if (!r.ok) return null;
    const j = await r.json();
    const m = new Map();
    for (const g of (j.dates?.[0]?.games || [])) m.set(g.gamePk, (g.status?.abstractGameState || "") === "Final");
    return m;
  } catch { return null; }
}

async function fetchBox(gamePk) {
  try {
    const r = await fetch(`${MLB}/api/v1/game/${gamePk}/boxscore`);
    if (!r.ok) return null;
    const j = await r.json();
    const players = {};
    for (const side of ["home", "away"]) {
      const ps = j.teams?.[side]?.players || {};
      for (const k of Object.keys(ps)) {
        const batting = ps[k]?.stats?.batting;
        if (batting) players[k] = batting;
      }
    }
    return { players };
  } catch { return null; }
}

async function record() {
  const s = store();
  const { blobs } = await s.list({ prefix: "snap:" });
  const keys = blobs.map(b => b.key).sort().slice(-45); // last ~45 days
  const days = [];
  for (const key of keys) {
    const snap = await s.get(key, { type: "json" }).catch(() => null);
    if (snap) days.push(snap);
  }
  const bands = [
    { lo: 0.00, hi: 0.60, n: 0, hits: 0 },
    { lo: 0.60, hi: 0.65, n: 0, hits: 0 },
    { lo: 0.65, hi: 0.70, n: 0, hits: 0 },
    { lo: 0.70, hi: 0.75, n: 0, hits: 0 },
    { lo: 0.75, hi: 1.01, n: 0, hits: 0 },
  ];
  const hrBands = [
    { lo: 0.00, hi: 0.06, n: 0, hr: 0 },
    { lo: 0.06, hi: 0.09, n: 0, hr: 0 },
    { lo: 0.09, hi: 0.12, n: 0, hr: 0 },
    { lo: 0.12, hi: 1.01, n: 0, hr: 0 },
  ];
  let n = 0, hits = 0, dnp = 0, gradedDays = 0, hrN = 0, hrHit = 0;
  for (const d of days) {
    if (!d.graded) continue;
    gradedDays++;
    for (const p of d.picks) {
      if (p.outcome === "dnp" || p.outcome === "pending") { dnp++; continue; }
      n++; if (p.outcome === "hit") hits++;
      const b = bands.find(b => p.prob >= b.lo && p.prob < b.hi);
      if (b) { b.n++; if (p.outcome === "hit") b.hits++; }
    }
    for (const p of (d.hrPicks || [])) {
      if (p.outcome === "dnp" || p.outcome === "pending") continue;
      hrN++; if (p.outcome === "hr") hrHit++;
      const b = hrBands.find(b => p.prob >= b.lo && p.prob < b.hi);
      if (b) { b.n++; if (p.outcome === "hr") b.hr++; }
    }
  }
  return json({
    days: days.slice(-10).reverse(), // newest first, last 10 days for the panel
    summary: { gradedDays, picks: n, hits, rate: n ? hits / n : null, dnp, bands,
      totalDays: days.length, pendingDays: days.filter(d => !d.graded).length,
      hr: { picks: hrN, homers: hrHit, rate: hrN ? hrHit / hrN : null, bands: hrBands } }
  });
}
