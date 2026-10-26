#!/usr/bin/env node
/**
 * Trakt -> Navfolio movie (film/series shelf) collection sync.
 *
 *   node scripts/trakt-sync.mjs --auth     # one-time device login, writes .trakt-token.json
 *   node scripts/trakt-sync.mjs            # pull watched history, write src/content/movie/*.md
 *
 * Options:
 *   --auth              run the Trakt device-code flow and store the token
 *   --user=<handle>     public profile mode (needs a public Trakt profile)
 *   --only=movies|shows limit to one side
 *   --limit=20          stop after N titles (smoke test)
 *   --dry-run           print what would be written, touch nothing
 *   --refresh-details   ignore the people/images cache
 *   --fixture=file.json render from a saved API dump instead of the network
 *
 * Credentials come from .env (TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET) or the env.
 * Nothing secret is written into src/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN_FILE = path.join(ROOT, '.trakt-token.json');
const CACHE_FILE = path.join(ROOT, 'scripts/.trakt-cache.json');
const API = 'https://api.trakt.tv';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const [k, v = 'true'] = raw.replace(/^--/, '').split('=');
  args.set(k, v);
}
const flag = (name) => args.has(name);
const opt = (name, fallback) => (args.has(name) ? args.get(name) : fallback);

const only = opt('only', 'all');
const limit = Number(opt('limit', '0')) || Infinity;
const dryRun = flag('dry-run');
const fixturePath = opt('fixture', null);
const OUT_DIR = path.resolve(ROOT, opt('out', 'src/content/movie'));

/* ------------------------------------------------------------------ env */

async function loadEnv() {
  const file = path.join(ROOT, '.env');
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      let value = m[2].trim().replace(/^["']|["']$/g, '');
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
  } catch {
    /* no .env, rely on the real environment */
  }
}

const CLIENT_ID = () => process.env.TRAKT_CLIENT_ID?.trim();
const CLIENT_SECRET = () => process.env.TRAKT_CLIENT_SECRET?.trim();

function requireCreds() {
  if (!CLIENT_ID() || !CLIENT_SECRET()) {
    console.error(
      '\n缺少 TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET。\n' +
        '到 https://trakt.tv/oauth/applications 新建一个应用（Redirect URI 填 urn:ietf:wg:oauth:2.0:oob），\n' +
        '然后把两个值写进仓库根目录的 .env：\n\n' +
        '  TRAKT_CLIENT_ID=xxxx\n  TRAKT_CLIENT_SECRET=xxxx\n'
    );
    process.exit(1);
  }
}

/* ----------------------------------------------------------------- http */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function api(endpoint, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const gap = Date.now() - lastCall;
    if (gap < 150) await sleep(150 - gap);
    lastCall = Date.now();

    const res = await fetch(`${API}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 5) * 1000;
      console.warn(`  rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 204) return raw ? { data: null, res } : null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${endpoint} -> ${res.status} ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return raw ? { data, res } : data;
  }
  throw new Error(`giving up on ${endpoint}`);
}

async function* paginate(endpoint) {
  let page = 1;
  let total = 1;
  do {
    const { data, res } = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}page=${page}&limit=100`, {
      raw: true,
    });
    total = Number(res.headers.get('x-pagination-page-count') || 1);
    yield data;
    page += 1;
  } while (page <= total);
}

/* ----------------------------------------------------------------- auth */

async function writeToken(token) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2));
}

async function deviceAuth() {
  requireCreds();
  const code = await api('/oauth/device/code', {
    method: 'POST',
    body: { client_id: CLIENT_ID() },
  });

  console.log('\n  浏览器打开：' + code.verification_url);
  console.log('  输入代码：  ' + code.user_code);
  console.log(`  （${Math.round(code.expires_in / 60)} 分钟内有效）\n`);

  const interval = (code.interval || 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await fetch(`${API}/oauth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.device_code,
        client_id: CLIENT_ID(),
        client_secret: CLIENT_SECRET(),
      }),
    });
    if (res.status === 200) {
      const token = await res.json();
      await writeToken({ ...token, obtained_at: Math.floor(Date.now() / 1000) });
      console.log('  授权成功，token 已保存到 .trakt-token.json\n');
      return token;
    }
    if (res.status === 400) continue; // pending
    if (res.status === 404 || res.status === 409 || res.status === 410 || res.status === 418) {
      throw new Error(`device auth failed: ${res.status} ${await res.text()}`);
    }
    if (res.status === 429) {
      await sleep(interval);
      continue;
    }
    throw new Error(`device auth unexpected: ${res.status} ${await res.text()}`);
  }
  throw new Error('device code expired, run --auth again');
}

async function getToken({ refreshIfNeeded = true } = {}) {
  let token;
  try {
    token = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    throw new Error('没有 .trakt-token.json，先运行：node scripts/trakt-sync.mjs --auth');
  }
  const age = Math.floor(Date.now() / 1000) - (token.obtained_at || token.created_at || 0);
  if (!refreshIfNeeded || age < (token.expires_in || 7776000) - 86400) return token.access_token;

  requireCreds();
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: token.refresh_token,
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      redirect_uri: REDIRECT_URI,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const fresh = await res.json();
  await writeToken({ ...fresh, obtained_at: Math.floor(Date.now() / 1000) });
  console.log('  token 已刷新');
  return fresh.access_token;
}

/* ---------------------------------------------------------------- cache */

let cache = { titles: {} };
async function loadCache() {
  try {
    cache = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
  } catch {
    cache = { titles: {} };
  }
  cache.titles ||= {};
}
const saveCache = async () => fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));

async function details(kind, id, token) {
  const key = `${kind}:${id}`;
  if (!flag('refresh-details') && cache.titles[key]) return cache.titles[key];

  const base = kind === 'movie' ? '/movies' : '/shows';
  let full;
  try {
    full = await api(`${base}/${id}?extended=full,images`, { token });
  } catch {
    // images are gated for some accounts; the rest of the metadata still works
    full = await api(`${base}/${id}?extended=full`, { token });
  }

  let creator = '';
  try {
    const people = await api(`${base}/${id}/people`, { token });
    const crew = people?.crew || [];
    const hit =
      crew.find((c) => /^creator$/i.test(c.job || '')) ||
      crew.find((c) => /director/i.test(c.job || '')) ||
      crew.find((c) => /^writer$/i.test(c.job || '')) ||
      crew[0];
    creator = hit?.person?.name || '';
  } catch {
    creator = '';
  }

  const entry = {
    overview: full?.overview || '',
    genres: full?.genres || [],
    runtime: full?.runtime || 0,
    year: full?.year || 0,
    network: full?.network || '',
    aired: full?.aired_episodes || 0,
    status: full?.status || '',
    poster: full?.images?.poster?.[0] || '',
    fanart: full?.images?.fanart?.[0] || '',
    creator,
  };

  // Trakt's image CDN is not always populated (it needs fanart.tv), so fall back
  // to TMDB when the user supplied a key. One extra call per new title at most.
  if (!entry.poster && !entry.fanart && process.env.TMDB_API_KEY && full?.ids?.tmdb) {
    const tmdbId = full.ids.tmdb;
    const kindPath = kind === 'movie' ? 'movie' : 'tv';
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/${kindPath}/${tmdbId}?api_key=${process.env.TMDB_API_KEY}&language=zh-CN`
      );
      if (res.ok) {
        const meta = await res.json();
        if (meta.poster_path) entry.poster = `https://image.tmdb.org/t/p/w500${meta.poster_path}`;
        else if (meta.backdrop_path) entry.fanart = `https://image.tmdb.org/t/p/w780${meta.backdrop_path}`;
      }
    } catch {
      /* keep going without a cover */
    }
  }

  cache.titles[key] = entry;
  await saveCache();
  return entry;
}

/* ------------------------------------------------------------ aggregate */

const movieIndex = new Map(); // trakt id -> { ids, title, year, plays, first, last }
const showIndex = new Map(); // trakt id -> { ids, title, year, seasons: Map, plays, first, last }

function bump(map, id, seed) {
  let row = map.get(id);
  if (!row) {
    row = { ...seed, plays: 0, first: null, last: null };
    map.set(id, row);
  }
  return row;
}

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

function addMovies(history) {
  for (const row of history) {
    const m = row.movie;
    if (!m?.ids?.trakt) continue;
    const rec = bump(movieIndex, m.ids.trakt, { ids: m.ids, title: m.title, year: m.year });
    rec.plays += 1;
    rec.first = earlier(rec.first, row.watched_at);
    rec.last = later(rec.last, row.watched_at);
  }
}

function addEpisodes(history) {
  for (const row of history) {
    const s = row.show;
    const e = row.episode;
    if (!s?.ids?.trakt || !e) continue;
    const rec = bump(showIndex, s.ids.trakt, { ids: s.ids, title: s.title, year: s.year, seasons: new Map() });
    rec.plays += 1;
    rec.first = earlier(rec.first, row.watched_at);
    rec.last = later(rec.last, row.watched_at);
    const season = rec.seasons.get(e.season) || new Set();
    season.add(e.number);
    rec.seasons.set(e.season, season);
  }
}

/* ---------------------------------------------------------------- write */

const slugify = (s) =>
  String(s)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'untitled';

const yq = (s) => JSON.stringify(String(s));

const BEGIN_MARK = '<!-- trakt:begin -->';
const END_MARK = '<!-- trakt:end -->';

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

const seasonRows = (rec) =>
  [...rec.seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, eps]) => `| S${n} | ${eps.size} |`)
    .join('\n');

function frontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`, ...v.map((x) => `  - ${yq(x)}`));
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      lines.push(`${k}: ${v}`); // plain dates stay unquoted, like the template's example
    } else {
      lines.push(`${k}: ${yq(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

async function writeEntry({ slug, fields, body, source }) {
  const file = path.join(OUT_DIR, `${slug}.md`);

  // Notes below the end marker are yours: the sync only rewrites the block above it.
  let notes = '';
  try {
    const prev = await fs.readFile(file, 'utf8');
    const prevBody = prev.split(/^---$/m).slice(2).join('---');
    const tail = prevBody.split(END_MARK)[1];
    if (tail) notes = tail.trim();
  } catch {
    /* new file */
  }

  const block = [BEGIN_MARK, body.trim(), END_MARK].join('\n');
  const finalBody = notes ? `${block}\n\n${notes}\n` : `${block}\n`;

  const out = `${frontmatter(fields)}\n\n${finalBody}`;
  if (dryRun) {
    console.log(`--- ${slug}.md\n${out}`);
    return { slug, bytes: out.length };
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(file, out);
  return { slug, bytes: out.length, source };
}

function movieBody(rec, det, rating) {
  const lines = [];
  const when = day(rec.last);
  const meta = [
    det.year ? `${det.year}` : null,
    det.runtime ? `${det.runtime} 分钟` : null,
    rec.plays > 1 ? `看过 ${rec.plays} 次` : null,
    when ? `最近一次 ${when}` : null,
    rating ? `我打 ${rating}/10` : null,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '));
  if (det.overview) lines.push('', `> ${det.overview.replace(/\n+/g, ' ')}`);
  return lines.join('\n');
}

function showBody(rec, det, rating) {
  const episodes = [...rec.seasons.values()].reduce((n, s) => n + s.size, 0);
  const lines = [];
  const progress = det.aired ? `已看 ${episodes}/${det.aired} 集` : `已看 ${episodes} 集`;
  const meta = [
    det.year ? `${det.year}` : null,
    det.network || null,
    progress,
    rec.last ? `最近一次 ${day(rec.last)}` : null,
    rating ? `我打 ${rating}/10` : null,
  ].filter(Boolean);
  lines.push(meta.join(' · '), '', '| 季 | 集数 |', '|---|---|', seasonRows(rec));
  if (det.overview) lines.push('', `> ${det.overview.replace(/\n+/g, ' ')}`);
  return lines.join('\n');
}

/* ----------------------------------------------------------------- main */

const ratings = { movies: new Map(), shows: new Map() };

function toFive(ten) {
  if (!ten) return undefined;
  const five = Math.round((ten / 2) * 2) / 2;
  return five >= 1 && five <= 5 ? five : undefined;
}

async function collectLive(token, user) {
  // user mode works with just the client id against a public profile;
  // token mode uses the private /sync endpoints.
  const p = user
    ? (ep) => `/users/${encodeURIComponent(user)}${ep}`
    : (ep) => `/sync${ep}`;

  if (only !== 'shows') {
    console.log('  拉取电影历史 …');
    for await (const page of paginate(p('/history/movies'))) addMovies(page);
    console.log('  拉取电影评分 …');
    for (const row of await api(p('/ratings/movies'), { token })) {
      if (row?.movie?.ids?.trakt) ratings.movies.set(row.movie.ids.trakt, row.rating);
    }
  }
  if (only !== 'movies') {
    console.log('  拉取剧集历史 …');
    for await (const page of paginate(p('/history/episodes'))) addEpisodes(page);
    console.log('  拉取剧集评分 …');
    for (const row of await api(p('/ratings/shows'), { token })) {
      if (row?.show?.ids?.trakt) ratings.shows.set(row.show.ids.trakt, row.rating);
    }
  }
}

async function collectFixture(file) {
  const dump = JSON.parse(await fs.readFile(file, 'utf8'));
  addMovies(dump.movies || []);
  addEpisodes(dump.episodes || []);
  for (const row of dump.ratingsMovies || []) ratings.movies.set(row.movie.ids.trakt, row.rating);
  for (const row of dump.ratingsShows || []) ratings.shows.set(row.show.ids.trakt, row.rating);
  return dump.details || {};
}

async function main() {
  await loadEnv();
  if (flag('auth')) {
    await deviceAuth();
    return;
  }
  await loadCache();

  let token = null;
  let fixtureDetails = null;
  if (fixturePath) {
    console.log(`离线模式：${fixturePath}`);
    fixtureDetails = await collectFixture(fixturePath);
  } else if (opt('user', null)) {
    const user = opt('user', '').replace(/^@/, '');
    requireCreds();
    console.log(`公开资料模式：trakt.tv/users/${user}`);
    await collectLive(null, user);
  } else {
    requireCreds();
    token = await getToken();
    await collectLive(token, null);
  }

  const wantedMovies = [...movieIndex.values()].slice(0, limit);
  const wantedShows = [...showIndex.values()].slice(0, only === 'shows' ? limit : limit);

  let written = 0;
  const report = [];

  if (only !== 'shows') {
    for (const rec of wantedMovies) {
      const det = fixtureDetails
        ? fixtureDetails[`movie:${rec.ids.trakt}`] || {}
        : await details('movie', rec.ids.trakt, token);
      const rating = ratings.movies.get(rec.ids.trakt);
      const slug = `film-${rec.ids.slug || slugify(rec.title)}`;
      const fields = {
        title: rec.title,
        creator: det.creator || '—',
        type: 'film',
        status: 'completed',
        completedAt: day(rec.last),
        year: det.year || rec.year || null,
        runtime: det.runtime || null,
        cover: det.poster || det.fanart || null,
        coverAspect: det.poster ? 'portrait' : det.fanart ? 'landscape' : null,
        rating: toFive(rating),
        tags: det.genres || [],
        externalUrl: rec.ids.slug ? `https://trakt.tv/movies/${rec.ids.slug}` : null,
      };
      const r = await writeEntry({ slug, fields, body: movieBody(rec, det, rating) });
      report.push({ kind: 'film', title: rec.title, slug, ...r, plays: rec.plays, last: day(rec.last) });
      written += 1;
    }
  }

  if (only !== 'movies') {
    for (const rec of wantedShows) {
      const det = fixtureDetails
        ? fixtureDetails[`show:${rec.ids.trakt}`] || {}
        : await details('show', rec.ids.trakt, token);
      const rating = ratings.shows.get(rec.ids.trakt);
      const episodes = [...rec.seasons.values()].reduce((n, s) => n + s.size, 0);
      const finished = det.aired > 0 && episodes >= det.aired;
      const slug = `series-${rec.ids.slug || slugify(rec.title)}`;
      const fields = {
        title: rec.title,
        creator: det.creator || det.network || '—',
        type: 'series',
        status: finished ? 'completed' : 'in-progress',
        completedAt: day(rec.last),
        year: det.year || rec.year || null,
        cover: det.poster || det.fanart || null,
        coverAspect: det.poster ? 'portrait' : det.fanart ? 'landscape' : null,
        rating: toFive(rating),
        tags: det.genres || [],
        externalUrl: rec.ids.slug ? `https://trakt.tv/shows/${rec.ids.slug}` : null,
      };
      const r = await writeEntry({ slug, fields, body: showBody(rec, det, rating) });
      report.push({ kind: 'series', title: rec.title, slug, ...r, plays: episodes, last: day(rec.last) });
      written += 1;
    }
  }

  if (!dryRun) {
    report.sort((a, b) => String(b.last).localeCompare(String(a.last)));
    const out = report.map((r) => `${r.last}  ${r.kind.padEnd(6)} ${r.title}`).join('\n');
    await fs.writeFile(path.join(ROOT, 'scripts/.trakt-report.txt'), out + '\n');
    console.log(`\n写入 ${written} 个条目到 src/content/movie/`);
    console.log(`清单：scripts/.trakt-report.txt`);
  }
}

main().catch((err) => {
  console.error('\n失败：' + err.message);
  process.exit(1);
});
