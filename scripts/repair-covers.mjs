/**
 * Cover normalizer / health check for the movie shelf.
 *
 * Every cover is derived from a Trakt ID via the stable endpoint in
 * trakt-cover.mjs, so normal operation is fully OFFLINE — no API calls, no
 * credentials, safe to run in GitHub Actions CI (whose egress IPs are blocked
 * by Trakt).
 *
 * It is intentionally idempotent: when trakt-sync.mjs has already emitted
 * stable URLs, a run changes nothing. It exists as a self-healing net for
 * hand-edited files, older hash-style URLs, or a future regression in the
 * generator, and runs after every sync via trakt-sync.yml.
 *
 * Usage:
 *   node scripts/repair-covers.mjs --check    # read-only: fail if any cover is not stable
 *   node scripts/repair-covers.mjs --dry-run # alias of --check
 *   node scripts/repair-covers.mjs           # rewrite non-stable covers (idempotent)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableCover, isStableCover } from './trakt-cover.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'src/content/movie');
const FIXTURE = path.join(ROOT, 'scripts/.trakt-fixture.json');
const checkOnly = process.argv.includes('--check') || process.argv.includes('--dry-run');

// Only needed when a cover actually has to be repaired: resolve a file to its
// Trakt ID using the same fixture the shelf sync reads. Title+year is primary;
// the externalUrl slug and a title-prefix fallback cover entries whose year
// differs between Trakt and the site.
let idMaps = null;
async function loadIdMaps() {
  if (idMaps) return idMaps;
  const byTitleYear = new Map();
  const bySlug = new Map();
  try {
    const fixture = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
    for (const row of fixture.movies || []) {
      const m = row.movie;
      if (!m?.ids?.trakt) continue;
      byTitleYear.set(`${m.title}|${m.year}`, { kind: 'movies', id: m.ids.trakt });
      if (m.ids.slug) bySlug.set(m.ids.slug, { kind: 'movies', id: m.ids.trakt });
    }
    for (const row of fixture.episodes || []) {
      const s = row.show;
      if (!s?.ids?.trakt) continue;
      byTitleYear.set(`${s.title}|${s.year}`, { kind: 'shows', id: s.ids.trakt });
      if (s.ids.slug) bySlug.set(s.ids.slug, { kind: 'shows', id: s.ids.trakt });
    }
  } catch {
    // Fixture is optional for the health check; unstable covers simply cannot
    // be auto-fixed without it and are reported below.
  }
  idMaps = { byTitleYear, bySlug };
  return idMaps;
}

const files = (await fs.readdir(CONTENT_DIR)).filter((f) => f.endsWith('.md'));
let stable = 0;
let normalized = 0;
const failed = [];

for (const file of files) {
  const full = path.join(CONTENT_DIR, file);
  const text = await fs.readFile(full, 'utf8');
  const oldCover = (text.match(/^cover:\s*"([^"]+)"/m) || [])[1]?.trim();
  const oldAspect = (text.match(/^coverAspect:\s*"([^"]+)"/m) || [])[1]?.trim();

  // Fast path: already a stable ID-addressed cover, nothing to look up.
  if (isStableCover(oldCover) && oldAspect === 'portrait') {
    stable++;
    continue;
  }

  const title = (text.match(/^title:\s*"([^"]+)"/m) || [])[1]?.trim();
  const year = (text.match(/^year:\s*(\d{4})/m) || [])[1];
  const slug = (text.match(/externalUrl:\s*"https:\/\/trakt\.tv\/(?:movies|shows)\/([^"]+)"/m) ||
    [])[1];
  const { byTitleYear, bySlug } = await loadIdMaps();
  let ref = byTitleYear.get(`${title}|${year}`) || bySlug.get(slug);
  if (!ref && title) {
    const hit = [...byTitleYear.entries()].find(([k]) => k.startsWith(`${title}|`));
    if (hit) ref = hit[1];
  }
  if (!ref) {
    failed.push(`${file}: cover not stable and no trakt id found (${title} ${year})`);
    continue;
  }

  const { cover, coverAspect } = stableCover(ref.kind, ref.id);
  normalized++;
  if (checkOnly) {
    failed.push(`${file}: cover not stable -> ${cover}`);
    continue;
  }

  let next = text;
  const coverLine = `cover: "${cover}"`;
  const aspectLine = `coverAspect: "${coverAspect}"`;
  if (oldCover) next = next.replace(/^cover:\s*"[^"]*"/m, coverLine);
  else next = next.replace(/^title:.*$/m, (m) => `${m}\n${coverLine}`);
  if (oldAspect) next = next.replace(/^coverAspect:\s*"[^"]*"/m, aspectLine);
  else next = next.replace(/^cover:\s*"[^"]*"/m, (m) => `${m}\n${aspectLine}`);
  await fs.writeFile(full, next, 'utf8');
}

console.log(`files: ${files.length}`);
console.log(`already stable: ${stable}`);
console.log(`normalized: ${normalized}${checkOnly ? ' (would be rewritten)' : ''}`);
console.log(`problems: ${failed.length}`);
for (const line of failed.slice(0, 30)) console.log(`  - ${line}`);

if (failed.length) process.exit(1);
