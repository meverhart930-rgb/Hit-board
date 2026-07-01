// Netlify Function: same-origin proxy that kills CORS for the MLB Stats API
// and adds Baseball Savant (Statcast) expected stats, which browsers can't fetch directly.
//
// Routes:
//   /.netlify/functions/mlb?path=/api/v1/schedule?sportId=1&date=...   -> proxies statsapi.mlb.com
//   /.netlify/functions/mlb?savant=expected&year=2026                  -> Savant xBA leaderboard as JSON
//
// Node 18+ runtime (global fetch). No dependencies.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "content-type": "application/json",
};

// Warm-container memory cache (best-effort) to avoid re-fetching slow, slowly-changing data.
const CACHE = new Map(); // key -> { t, status, body, ct }
function cacheGet(key, ttlMs) {
  const e = CACHE.get(key);
  if (e && Date.now() - e.t < ttlMs) return e;
  if (e) CACHE.delete(key);
  return null;
}
function cacheSet(key, val) {
  CACHE.set(key, { ...val, t: Date.now() });
  if (CACHE.size > 240) CACHE.delete(CACHE.keys().next().value);
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

// CSV line splitter that respects double-quoted fields (Savant's name column has a comma)
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += ch;
    } else {
      if (ch === ",") { out.push(cur); cur = ""; }
      else if (ch === '"') q = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const o = {};
    for (const k in idx) o[k] = f[idx[k]];
    rows.push(o);
  }
  return { rows, idx };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  const qs = event.queryStringParameters || {};

  try {
    // ---- Baseball Savant expected statistics (xBA / xwOBA) ----
    if (qs.savant === "expected") {
      const year = (qs.year || "").replace(/[^0-9]/g, "") || String(new Date().getFullYear());
      const ckey = "savant:" + year;
      const cached = cacheGet(ckey, 6 * 3600 * 1000); // 6h
      if (cached) return { statusCode: 200, headers: { ...CORS, "cache-control": "public, max-age=21600" }, body: cached.body };
      const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=10&csv=true`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" } });
      if (!r.ok) return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: "savant " + r.status }) };
      const csv = await r.text();
      const { rows, idx } = parseCsv(csv);
      const pidKey = ("player_id" in idx) ? "player_id" : Object.keys(idx).find((k) => /player_id|mlbam/i.test(k));
      const xbaKey = ("est_ba" in idx) ? "est_ba" : Object.keys(idx).find((k) => /est_ba|xba/i.test(k));
      const xwobaKey = ("est_woba" in idx) ? "est_woba" : Object.keys(idx).find((k) => /est_woba|xwoba/i.test(k));
      const out = [];
      for (const o of rows) {
        const id = num(pidKey ? o[pidKey] : null);
        if (!id) continue;
        out.push({ id, xba: num(xbaKey ? o[xbaKey] : null), xwoba: num(xwobaKey ? o[xwobaKey] : null), ba: num(o.ba), pa: num(o.pa) });
      }
      const body = JSON.stringify(out);
      cacheSet(ckey, { body });
      return { statusCode: 200, headers: { ...CORS, "cache-control": "public, max-age=21600" }, body };
    }

    // ---- MLB Stats API passthrough (allowlisted to /api/ paths) ----
    const path = qs.path || "";
    if (!path.startsWith("/api/")) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "path must start with /api/" }) };
    }
    // Season leaderboards change ~daily -> cache 15 min. Live data (schedule, boxscore, gameLog) stays fresh.
    const cacheable = /\/api\/v1\/stats\?stats=season/.test(path);
    if (cacheable) {
      const hit = cacheGet("mlb:" + path, 15 * 60 * 1000);
      if (hit) return { statusCode: hit.status, headers: { ...CORS, "cache-control": "public, max-age=900" }, body: hit.body };
    }
    const r = await fetch("https://statsapi.mlb.com" + path, { headers: { "Accept": "application/json" } });
    const body = await r.text();
    const ct = r.headers.get("content-type") || "application/json";
    if (cacheable && r.ok) cacheSet("mlb:" + path, { status: r.status, body, ct });
    return { statusCode: r.status, headers: { ...CORS, "content-type": ct, "cache-control": cacheable ? "public, max-age=900" : "no-store" }, body };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
