// Results tracking for Honky Jefe's Hit List.
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
  const snap = {
    date,
    firstPitch: firstPitch || null,
    savedAt: new Date().toISOString(),
    picks: picks.slice(0, 12).map(p => ({
      id: +p.id, name: String(p.name || ""), team: p.team || "", opp: p.opp || "",
      prob: Math.max(0, Math.min(1, +p.prob || 0)), gamePk: +p.gamePk || null,
      confirmed: !!p.confirmed
    })),
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

    // Age in days: if a game never finalizes (postponed), grade anyway after 3 days.
    const ageDays = Math.floor((Date.parse(today) - Date.parse(snap.date)) / 86400000);
    const boxCache = new Map();
    let allSettled = true;
    const results = [];

    for (const p of snap.picks) {
      if (!p.gamePk) { results.push({ ...p, outcome: "dnp" }); continue; }
      let box = boxCache.get(p.gamePk);
      if (box === undefined) {
        box = await fetchBox(p.gamePk);
        boxCache.set(p.gamePk, box);
      }
      if (!box) { allSettled = false; results.push({ ...p, outcome: "pending" }); continue; }
      if (!box.final) {
        if (ageDays < 3) { allSettled = false; results.push({ ...p, outcome: "pending" }); continue; }
        results.push({ ...p, outcome: "dnp" }); continue; // stale/postponed after 3 days -> void
      }
      const st = box.players["ID" + p.id];
      const ab = st ? (+st.atBats || 0) : 0;
      const hits = st ? (+st.hits || 0) : 0;
      const pa = st ? (+st.plateAppearances || ab) : 0;
      if (!st || pa === 0) results.push({ ...p, outcome: "dnp" });
      else results.push({ ...p, outcome: hits >= 1 ? "hit" : "miss", hits, ab });
    }

    if (!allSettled && ageDays < 3) continue; // try again next run
    snap.picks = results;
    snap.graded = true;
    snap.gradedAt = new Date().toISOString();
    await s.setJSON(key, snap);
    doneDays.push(snap.date);
  }
  return json({ ok: true, graded: doneDays });
}

async function fetchBox(gamePk) {
  try {
    const r = await fetch(`${MLB}/api/v1/game/${gamePk}/boxscore`);
    if (!r.ok) return null;
    const j = await r.json();
    const status = await gameFinal(gamePk);
    const players = {};
    for (const side of ["home", "away"]) {
      const ps = j.teams?.[side]?.players || {};
      for (const k of Object.keys(ps)) {
        const batting = ps[k]?.stats?.batting;
        if (batting) players[k] = batting;
      }
    }
    return { final: status, players };
  } catch { return null; }
}

async function gameFinal(gamePk) {
  try {
    const r = await fetch(`${MLB}/api/v1.1/game/${gamePk}/feed/live?fields=gameData,status,abstractGameState`);
    if (!r.ok) return false;
    const j = await r.json();
    return (j.gameData?.status?.abstractGameState || "") === "Final";
  } catch { return false; }
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
  let n = 0, hits = 0, dnp = 0, gradedDays = 0;
  for (const d of days) {
    if (!d.graded) continue;
    gradedDays++;
    for (const p of d.picks) {
      if (p.outcome === "dnp" || p.outcome === "pending") { dnp++; continue; }
      n++; if (p.outcome === "hit") hits++;
      const b = bands.find(b => p.prob >= b.lo && p.prob < b.hi);
      if (b) { b.n++; if (p.outcome === "hit") b.hits++; }
    }
  }
  return json({
    days: days.slice(-10).reverse(), // newest first, last 10 days for the panel
    summary: { gradedDays, picks: n, hits, rate: n ? hits / n : null, dnp, bands }
  });
}
