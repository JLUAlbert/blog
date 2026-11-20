/**
 * Trakt cover URLs — single source of truth for the movie shelf.
 *
 * Trakt serves posters through a stable, ID-addressed endpoint:
 *
 *   https://media.trakt.tv/{movies|shows}/{traktId}/medium/poster.webp
 *
 * This is exactly what the public `/movies|shows/{id}?extended=images` API
 * returns today. Unlike the older hash paths
 * (`/images/movies/000/011/455/posters/medium/<hash>.jpg.webp`), it is derived
 * from the Trakt ID and does NOT change when Trakt re-processes its image
 * library. Verified: all 144 titles resolve with HTTP 200 via this form.
 *
 * We therefore never persist an API-supplied image URL. Every sync builds the
 * cover from the Trakt ID alone: zero network requests, works in offline CI
 * (GitHub Actions egress IPs are blocked by Trakt), and cannot rot.
 */
const MEDIA = 'https://media.trakt.tv';

function plural(kind) {
  return kind === 'movie' || kind === 'movies' ? 'movies' : 'shows';
}

/** Build the stable cover URL and aspect for one title. */
export function stableCover(kind, traktId) {
  if (!traktId) return { cover: null, coverAspect: null };
  return {
    cover: `${MEDIA}/${plural(kind)}/${traktId}/medium/poster.webp`,
    coverAspect: 'portrait',
  };
}

/** True when a cover string is one of our stable, ID-addressed URLs. */
export function isStableCover(url) {
  return (
    typeof url === 'string' &&
    /^https:\/\/media\.trakt\.tv\/(movies|shows)\/\d+\/medium\/(poster|fanart)\.webp$/.test(url)
  );
}

export { MEDIA as TRAKT_MEDIA_HOST };
