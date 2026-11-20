/**
 * One-off cover repair: re-fetch current poster URLs from Trakt's public API
 * and rewrite the `cover` field in src/content/movie/*.md.
 *
 * Trakt rehashes its image URLs over time; the saved links in frontmatter rot
 * into 404s. The public /movies|shows/{id}?extended=images endpoint returns the
 * current valid URL and needs no OAuth token, so it works even when the token
 * refresh flow is blocked.
 *
 * Usage:
 *   node scripts/repair-covers.mjs --dry-run   # report only, write nothing
 *   node scripts/repair-covers.mjs             # rewrite covers
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'src/content/movie');
const FIXTURE = path.join(ROOT, 'scripts/.trakt-fixture.json');
const ENV_FILE = path.join(ROOT, '.env');
const dryRun = process.argv.includes('--dry-run');

const CLIENT_ID = process.env.TRAKT_CLIENT_ID || (await readClientId());

async function readClientId() {
  try {
    const text = await fs.readFile(ENV_FILE, 'utf8');
    const m = text.match(/^TRAKT_CLIENT_ID\s*=\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

if (!CLIENT_ID) {
  console.error('TRAKT_CLIENT_ID is required (in .env or environment).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function traktImages(kind, id) {
  const res = await fetch(`https://api.trakt.tv/${kind}/${id}?extended=images`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': CLIENT_ID,
      'User-Agent': 'navfolio-trakt-sync/1.0',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const images = data?.images || {};
  const poster = images.poster?.[0];
  const fanart = images.fanart?.[0];
  const abs = (u) => (u ? (u.startsWith('http') ? u : `https://${u}`) : '');
  return { poster: abs(poster), fanart: abs(fanart) };
}

const fixture = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
const idByTitleYear = new Map();
const idBySlug = new Map();
for (const row of fixture.movies || []) {
  const m = row.movie;
  if (!m?.ids?.trakt) continue;
  idByTitleYear.set(`${m.title}|${m.year}`, { kind: 'movies', id: m.ids.trakt });
  if (m.ids.slug) idBySlug.set(m.ids.slug, { kind: 'movies', id: m.ids.trakt });
}
for (const row of fixture.episodes || []) {
  const s = row.show;
  if (!s?.ids?.trakt) continue;
  idByTitleYear.set(`${s.title}|${s.year}`, { kind: 'shows', id: s.ids.trakt });
  if (s.ids.slug) idBySlug.set(s.ids.slug, { kind: 'shows', id: s.ids.trakt });
}

const files = (await fs.readdir(CONTENT_DIR)).filter((f) => f.endsWith('.md'));
let changed = 0;
let unchanged = 0;
let failed = [];
const cache = new Map();

for (const file of files) {
  const full = path.join(CONTENT_DIR, file);
  const text = await fs.readFile(full, 'utf8');
  const title = (text.match(/^title:\s*"([^"]+)"/m) || [])[1]?.trim();
  const year = (text.match(/^year:\s*(\d{4})/m) || [])[1];
  const oldCover = (text.match(/^cover:\s*"([^"]+)"/m) || [])[1]?.trim();
  const oldAspect = (text.match(/^coverAspect:\s*"([^"]+)"/m) || [])[1]?.trim();

  const slug = (text.match(/externalUrl:\s*"https:\/\/trakt\.tv\/(?:movies|shows)\/([^"]+)"/m) ||
    [])[1];
  let ref = idByTitleYear.get(`${title}|${year}`) || idBySlug.get(slug);
  if (!ref && title) {
    const hit = [...idByTitleYear.entries()].find(([k]) => k.startsWith(`${title}|`));
    if (hit) ref = hit[1];
  }
  if (!ref) {
    failed.push(`${file}: no trakt id (${title} ${year})`);
    continue;
  }

  const cacheKey = `${ref.kind}:${ref.id}`;
  if (!cache.has(cacheKey)) {
    const imgs = await traktImages(ref.kind, ref.id);
    cache.set(cacheKey, {
      cover: imgs?.poster || imgs?.fanart || null,
      aspect: imgs?.poster ? 'portrait' : imgs?.fanart ? 'landscape' : null,
    });
    await sleep(120);
  }
  const { cover, aspect } = cache.get(cacheKey);
  if (!cover) {
    failed.push(`${file}: no image from Trakt API (${title})`);
    continue;
  }

  const nextCoverLine = `cover: "${cover}"`;
  const nextAspectLine = aspect ? `coverAspect: "${aspect}"` : null;
  let next = text;
  if (oldCover) next = next.replace(/^cover:\s*"[^"]*"/m, nextCoverLine);
  else next = next.replace(/^title:.*$/m, (m) => `${m}\n${nextCoverLine}`);
  if (oldAspect && nextAspectLine) {
    next = next.replace(/^coverAspect:\s*"[^"]*"/m, nextAspectLine);
  } else if (!oldAspect && nextAspectLine) {
    next = next.replace(/^cover:\s*"[^"]*"/m, (m) => `${m}\n${nextAspectLine}`);
  }

  if (next === text) {
    unchanged++;
  } else {
    changed++;
    if (!dryRun) await fs.writeFile(full, next, 'utf8');
  }
}

console.log(`files: ${files.length}`);
console.log(`changed: ${changed}${dryRun ? ' (dry-run, not written)' : ''}`);
console.log(`unchanged: ${unchanged}`);
console.log(`failed: ${failed.length}`);
for (const line of failed.slice(0, 30)) console.log(`  - ${line}`);
