#!/usr/bin/env node

/**
 * Spotify Discovery Engine
 *
 * Breaks the algorithmic echo chamber by:
 * 1. Reading your top artists/tracks + recently played from Spotify
 * 2. Sending that taste profile to Claude for genuinely diverse recommendations
 * 3. Searching Spotify for those recommendations
 * 4. Replacing a playlist's contents with the new tracks
 *
 * Usage:
 *   node discover.mjs                    # Chill playlist (default)
 *   node discover.mjs --mode hard        # Heavy playlist — DnB, metal, hardcore
 *   node discover.mjs --auth             # Force re-authentication
 *   node discover.mjs --count 30         # Number of tracks (default: 60)
 *   node discover.mjs --diversity high   # low | medium | high (default: high)
 *   node discover.mjs --like 3 --like 7  # Mark tracks 3 & 7 from last run as liked
 *   node discover.mjs --skip 12          # Mark track 12 as skipped (never again)
 *   node discover.mjs --unrate 5         # Remove rating from track 5
 */

import "dotenv/config";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".spotify-discover");
const TOKEN_PATH = join(CONFIG_DIR, "tokens.json");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const ARTIST_TAGS_CACHE_PATH = join(CONFIG_DIR, "artist-tags-cache.json");
const ARTIST_SIMILAR_CACHE_PATH = join(CONFIG_DIR, "artist-similar-cache.json");
const ARTIST_TOP_TRACKS_CACHE_PATH = join(CONFIG_DIR, "artist-top-tracks-cache.json");
const TRACK_URI_CACHE_PATH = join(CONFIG_DIR, "track-uri-cache.json");
const SKIPS_PATH = join(CONFIG_DIR, "skips.json");
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

// Per-mode config. `chill` is the default cross-genre discovery playlist;
// `hard` is a heavy/aggressive-music sibling that uses a genre allowlist
// against Last.fm artist tags and a different seed file + playlist name.
// Hard tags grouped by genre family — an artist must match 2+ DISTINCT groups
// to pass the filter. This prevents pop-leaning artists with a single heavy tag
// (e.g. Chase & Status = "drum and bass" + "dnb") from slipping through.
const HARD_TAG_GROUPS = {
  dnb: ["drum and bass", "dnb", "drum'n'bass", "liquid funk", "liquid drum and bass", "neurofunk", "jungle"],
  breakbeat: ["breakbeat", "breakcore"],
  dubstep: ["dubstep", "riddim"],
  metal: ["metal", "heavy metal", "groove metal", "nu metal", "nu-metal",
    "thrash metal", "death metal", "black metal", "doom metal", "sludge metal",
    "stoner metal", "progressive metal", "speed metal", "power metal"],
  metalcore: ["metalcore", "deathcore", "djent", "mathcore"],
  hardcore: ["hardcore", "hardcore punk", "post-hardcore", "crossover thrash", "punk"],
  industrial: ["industrial", "industrial metal", "industrial rock", "ebm", "aggrotech"],
  noise: ["noise", "noise rock", "grindcore", "powerviolence"],
};

// Flat set for quick membership check + reverse lookup to group name
const HARD_TAGS = new Set(Object.values(HARD_TAG_GROUPS).flat());

// Tags that settle the question on their own. A bare "metal" or "post-hardcore"
// is ambiguous — Rage Against The Machine and Quicksand carry those and still
// belong in chill. These do not: an artist tagged "nu metal" or "industrial
// metal" seeds exploration straight into Heavy's territory.
const DECISIVE_HARD_TAGS = new Set([
  "nu metal", "nu-metal", "industrial metal", "groove metal", "heavy metal",
  "thrash metal", "death metal", "black metal", "doom metal", "sludge metal",
  "speed metal", "power metal", "metalcore", "deathcore", "djent", "mathcore",
  "grindcore", "powerviolence", "industrial", "industrial rock", "ebm", "aggrotech",
]);
const HARD_TAG_TO_GROUP = new Map();
for (const [group, tags] of Object.entries(HARD_TAG_GROUPS)) {
  for (const tag of tags) HARD_TAG_TO_GROUP.set(tag, group);
}

const MODE_CONFIG = {
  chill: {
    playlistName: "Discovery Chill",
    seedFile: "my-seeds.json",
    albumsFile: "my-albums.json",
    genreAllowlist: null,
    // Heavy artists are excluded as SEEDS only — chill's output stays genre-open
    // (pop, funk, soul all welcome), it just doesn't explore into Heavy's territory.
    seedGenreBlocklist: HARD_TAGS,
    // Fraction of the candidate pool the artist-discovery pass may claim before
    // track.getSimilar runs. Chill is the exploration mode — wide swings across
    // the whole collection are wanted, including pop the seeds don't predict.
    artistDiscoveryBudget: 0.75,
    decadeTargets: { "70s": 0.08, "80s": 0.20, "90s": 0.20, "00s": 0.20, "10s": 0.20, "20s": 0.12 },
    description: "Fresh discoveries, curated by AI.",
    tagline: "a diverse music collection, not a genre playlist",
  },
  hard: {
    playlistName: "Discovery Heavy",
    seedFile: "my-seeds-hard.json",
    albumsFile: "my-albums.json",
    genreAllowlist: HARD_TAGS,
    // Hard mode leans entirely on artist discovery — the genre allowlist needs a
    // deep pool to filter against, and this is what already made it work.
    artistDiscoveryBudget: 1.0,
    decadeTargets: { "70s": 0, "80s": 0.05, "90s": 0.25, "00s": 0.25, "10s": 0.25, "20s": 0.20 },
    description: "Heavy cuts — DnB, metal, industrial, hardcore.",
    tagline: "heavy music only — DnB, metal, industrial, hardcore. Reject anything that doesn't hit hard",
  },
};

const SCOPES = [
  "user-top-read",
  "user-read-recently-played",
  "user-library-read",
  "user-follow-read",
  "playlist-read-private",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-read-private",
].join(" ");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const forceAuth = args.includes("--auth");
const trackCount = parseInt(args[args.indexOf("--count") + 1]) || 60;
const diversity = args[args.indexOf("--diversity") + 1] || "high";
const excludeRuns = args.includes("--exclude-runs")
  ? parseInt(args[args.indexOf("--exclude-runs") + 1]) || 0
  : 3;
const minConsumed = args.includes("--min-consumed")
  ? parseFloat(args[args.indexOf("--min-consumed") + 1]) || 0
  : 0;
const maxAgeDays = args.includes("--max-age-days")
  ? parseFloat(args[args.indexOf("--max-age-days") + 1]) || Infinity
  : 7;
const modeArg = args[args.indexOf("--mode") + 1];
const mode = (modeArg && MODE_CONFIG[modeArg]) ? modeArg : "chill";
const MODE = MODE_CONFIG[mode];
const PLAYLIST_NAME = MODE.playlistName;

// Collect all --like / --skip / --unrate flags. Each takes a 1-indexed position
// from the most recent run of this mode. They mutate feedback.json and then
// continue into the main discovery flow.
function collectMulti(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const n = parseInt(args[i + 1]);
      if (!isNaN(n)) out.push(n);
    }
  }
  return out;
}
const likeArgs = collectMulti("--like");
const skipArgs = collectMulti("--skip");
const unrateArgs = collectMulti("--unrate");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
}

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function saveJson(path, data) {
  await ensureConfigDir();
  await writeFile(path, JSON.stringify(data, null, 2));
}

function log(msg) {
  console.log(`  ${msg}`);
}

function logStep(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Artist alias groups — treats collaborations/alter-egos as one artist for caps
// ---------------------------------------------------------------------------

const ARTIST_ALIAS_GROUPS = [
  ["kanye west", "kids see ghosts", "¥$", "ye"],
  ["white zombie", "rob zombie"],
];

// Build reverse lookup: artist name → canonical (first entry in group)
const artistAliasMap = new Map();
for (const group of ARTIST_ALIAS_GROUPS) {
  const canonical = group[0];
  for (const alias of group) {
    artistAliasMap.set(alias, canonical);
  }
}

function resolveArtistAlias(artistLower) {
  return artistAliasMap.get(artistLower) || artistLower;
}

// ---------------------------------------------------------------------------
// Last.fm API helper
// ---------------------------------------------------------------------------

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USER = process.env.LASTFM_USER || "drew12341";

async function lastfmGet(method, params = {}) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", LASTFM_API_KEY);
  url.searchParams.set("format", "json");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  // These calls run in long serial loops. Without a timeout a single stalled
  // connection blocks the whole pipeline indefinitely, so bound each attempt
  // and retry once rather than hanging forever.
  const attempt = async () => {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return res.json();
  };

  try {
    return await attempt();
  } catch {
    try {
      return await attempt();
    } catch {
      log(`  Last.fm ${method} timed out, skipping`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Feedback loop — user-rated tracks from past runs influence future seeds
// ---------------------------------------------------------------------------

function feedbackPath() {
  const projectDir = new URL(".", import.meta.url).pathname;
  return join(projectDir, `feedback${mode === "chill" ? "" : `-${mode}`}.json`);
}

async function loadFeedback() {
  const data = await loadJson(feedbackPath());
  return data || { liked: [], skipped: [] };
}

async function saveFeedback(fb) {
  await writeFile(feedbackPath(), JSON.stringify(fb, null, 2));
}

function fuzzyKey(artist, track) {
  return `${artist} - ${track}`.toLowerCase()
    .replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, "");
}

function dedupeFeedback(arr) {
  const seen = new Set();
  return arr.filter((t) => {
    const k = fuzzyKey(t.artist, t.track);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Apply --like / --skip / --unrate flags against the most recent run's track
// list (filtered to the current mode). Returns true if feedback.json was
// mutated so the caller knows to log.
async function applyRatingFlags(runHistory) {
  if (likeArgs.length === 0 && skipArgs.length === 0 && unrateArgs.length === 0) return false;

  // Find most recent run for this mode (runs are tagged with mode on write)
  const modeRuns = runHistory.runs.filter((r) => (r.mode || "chill") === mode);
  const lastRun = modeRuns[modeRuns.length - 1];
  if (!lastRun?.tracks?.length) {
    log("No previous run to rate against — skipping --like/--skip/--unrate");
    return false;
  }

  const fb = await loadFeedback();
  const resolve = (n) => lastRun.tracks[n - 1];

  for (const n of likeArgs) {
    const t = resolve(n);
    if (!t) { log(`--like ${n}: no track at that position`); continue; }
    fb.liked.push({ artist: t.artist, track: t.track });
    log(`Liked #${n}: ${t.artist} — ${t.track}`);
  }
  for (const n of skipArgs) {
    const t = resolve(n);
    if (!t) { log(`--skip ${n}: no track at that position`); continue; }
    fb.skipped.push({ artist: t.artist, track: t.track });
    log(`Skipped #${n}: ${t.artist} — ${t.track}`);
  }
  for (const n of unrateArgs) {
    const t = resolve(n);
    if (!t) continue;
    const k = fuzzyKey(t.artist, t.track);
    fb.liked = fb.liked.filter((x) => fuzzyKey(x.artist, x.track) !== k);
    fb.skipped = fb.skipped.filter((x) => fuzzyKey(x.artist, x.track) !== k);
    log(`Unrated #${n}: ${t.artist} — ${t.track}`);
  }

  fb.liked = dedupeFeedback(fb.liked);
  fb.skipped = dedupeFeedback(fb.skipped);
  await saveFeedback(fb);
  return true;
}

// ---------------------------------------------------------------------------
// Last.fm artist tag fetch — supplies genre info for filtering + curation
// Disk-backed cache at ~/.spotify-discover/artist-tags-cache.json (30-day TTL)
// ---------------------------------------------------------------------------

const artistTagCache = new Map(); // key → string[]
let _artistTagDiskCache = {}; // raw disk object, written back on save

async function loadArtistTagCache() {
  try {
    _artistTagDiskCache = JSON.parse(await readFile(ARTIST_TAGS_CACHE_PATH, "utf8"));
    const now = Date.now();
    let loaded = 0;
    for (const [k, v] of Object.entries(_artistTagDiskCache)) {
      if (v.fetchedAt && now - v.fetchedAt < CACHE_TTL_MS) {
        artistTagCache.set(k, v.tags);
        loaded++;
      }
    }
    if (loaded > 0) log(`Loaded ${loaded} artist tags from disk cache`);
  } catch {
    _artistTagDiskCache = {};
  }
}

async function saveArtistTagCache() {
  for (const [k, tags] of artistTagCache.entries()) {
    if (!_artistTagDiskCache[k] || !_artistTagDiskCache[k].fetchedAt) {
      _artistTagDiskCache[k] = { tags, fetchedAt: Date.now() };
    }
  }
  try {
    await writeFile(ARTIST_TAGS_CACHE_PATH, JSON.stringify(_artistTagDiskCache), "utf8");
  } catch { /* non-fatal */ }
}

async function fetchArtistTags(artistName) {
  const key = artistName.toLowerCase();
  if (artistTagCache.has(key)) return artistTagCache.get(key);

  const data = await lastfmGet("artist.getTopTags", { artist: artistName });
  const tags = (data?.toptags?.tag || [])
    .filter((t) => parseInt(t.count) >= 10)
    .map((t) => t.name.toLowerCase());
  artistTagCache.set(key, tags);
  return tags;
}

async function fetchArtistTagsBatch(artistNames) {
  const unique = [...new Set(artistNames.map((a) => a.toLowerCase()))];
  const uncached = unique.filter((a) => !artistTagCache.has(a));
  if (uncached.length === 0) { log(`Genre tags: all ${unique.length} artists served from cache`); return; }

  log(`Fetching genre tags for ${uncached.length} artists (${unique.length - uncached.length} cached)...`);
  let done = 0;
  for (const a of uncached) {
    try { await fetchArtistTags(a); } catch { artistTagCache.set(a, []); }
    done++;
    if (done % 20 === 0) log(`  ${done}/${uncached.length} artists tagged`);
    await new Promise((r) => setTimeout(r, 150));
  }
  await saveArtistTagCache();
}

// ---------------------------------------------------------------------------
// Last.fm artist.getSimilar — disk-backed cache (30-day TTL)
// ---------------------------------------------------------------------------

const artistSimilarCache = new Map(); // artistLower → artist[]
let _artistSimilarDiskCache = {};

async function loadArtistSimilarCache() {
  try {
    _artistSimilarDiskCache = JSON.parse(await readFile(ARTIST_SIMILAR_CACHE_PATH, "utf8"));
    const now = Date.now();
    let loaded = 0;
    for (const [k, v] of Object.entries(_artistSimilarDiskCache)) {
      if (v.fetchedAt && now - v.fetchedAt < CACHE_TTL_MS) {
        artistSimilarCache.set(k, v.artists);
        loaded++;
      }
    }
    if (loaded > 0) log(`Loaded ${loaded} artist-similar entries from disk cache`);
  } catch {
    _artistSimilarDiskCache = {};
  }
}

async function saveArtistSimilarCache() {
  for (const [k, artists] of artistSimilarCache.entries()) {
    if (!_artistSimilarDiskCache[k] || !_artistSimilarDiskCache[k].fetchedAt) {
      _artistSimilarDiskCache[k] = { artists, fetchedAt: Date.now() };
    }
  }
  try {
    await writeFile(ARTIST_SIMILAR_CACHE_PATH, JSON.stringify(_artistSimilarDiskCache), "utf8");
  } catch { /* non-fatal */ }
}

// Artist top-tracks cache. Drives both deep-cut selection and signature-hit
// rejection, so it is hit constantly — without a disk cache every run re-fetches
// the lot, which is minutes of serial Last.fm calls.
const artistTopTracksCache = new Map(); // key → string[]
let _artistTopTracksDiskCache = {};

async function loadArtistTopTracksCache() {
  try {
    _artistTopTracksDiskCache = JSON.parse(await readFile(ARTIST_TOP_TRACKS_CACHE_PATH, "utf8"));
    const now = Date.now();
    let loaded = 0;
    for (const [k, v] of Object.entries(_artistTopTracksDiskCache)) {
      if (v.fetchedAt && now - v.fetchedAt < CACHE_TTL_MS) {
        artistTopTracksCache.set(k, v.tracks);
        loaded++;
      }
    }
    if (loaded > 0) log(`Loaded ${loaded} artist top-tracks from disk cache`);
  } catch {
    _artistTopTracksDiskCache = {};
  }
}

async function saveArtistTopTracksCache() {
  for (const [k, tracks] of artistTopTracksCache.entries()) {
    if (!_artistTopTracksDiskCache[k] || !_artistTopTracksDiskCache[k].fetchedAt) {
      _artistTopTracksDiskCache[k] = { tracks, fetchedAt: Date.now() };
    }
  }
  try {
    await writeFile(ARTIST_TOP_TRACKS_CACHE_PATH, JSON.stringify(_artistTopTracksDiskCache), "utf8");
  } catch { /* non-fatal */ }
}

async function getArtistTopTrackNames(artistName) {
  const key = artistName.toLowerCase();
  if (artistTopTracksCache.has(key)) return artistTopTracksCache.get(key);
  let list = [];
  try {
    const res = await lastfmGet("artist.getTopTracks", { artist: artistName, limit: 50 });
    list = (res?.toptracks?.track || []).map((t) => t.name);
  } catch {
    list = [];
  }
  artistTopTracksCache.set(key, list);
  return list;
}

// ---------------------------------------------------------------------------
// Track URI cache — artist+track → Spotify URI.
//
// Resolving Last.fm candidates to URIs costs one /search call each, and the same
// tracks recur across runs. Without this, a run burns ~85 searches re-resolving
// what it already knew, which is what triggers Spotify's rate limiter.
//
// No TTL: a track's URI never changes, so entries are valid indefinitely.
// ---------------------------------------------------------------------------

const trackUriCache = new Map(); // fuzzyKey → { uri, name, artist, album, year, popularity }

async function loadTrackUriCache() {
  try {
    const raw = JSON.parse(await readFile(TRACK_URI_CACHE_PATH, "utf8"));
    for (const [k, v] of Object.entries(raw)) trackUriCache.set(k, v);
    log(`Loaded ${trackUriCache.size} track URIs from disk cache`);
  } catch {
    // no cache yet
  }

  // Seed from tracklists.json — already holds full Spotify tracklists with URIs
  // for every album in the collection, so the cache starts warm instead of empty.
  let seeded = 0;
  try {
    const data = JSON.parse(await readFile(join(CONFIG_DIR, "tracklists.json"), "utf8"));
    for (const album of Object.values(data.albums || {})) {
      const year = album.releaseDate ? parseInt(album.releaseDate.slice(0, 4)) : null;
      for (const t of album.tracks || []) {
        if (!t.uri || !t.artist || !t.name) continue;
        const k = fuzzyKey(t.artist, t.name);
        if (trackUriCache.has(k)) continue;
        trackUriCache.set(k, {
          uri: t.uri,
          name: t.name,
          artist: t.artist,
          album: album.spotifyName || null,
          year,
          popularity: null, // album endpoint returns simplified tracks
        });
        seeded++;
      }
    }
  } catch {
    // no tracklists file — cache just starts colder
  }
  if (seeded > 0) log(`Pre-populated ${seeded} track URIs from tracklists.json`);
}

async function saveTrackUriCache() {
  try {
    await writeFile(TRACK_URI_CACHE_PATH, JSON.stringify(Object.fromEntries(trackUriCache)), "utf8");
  } catch { /* non-fatal */ }
}

async function getArtistSimilar(artistName, limit = 15) {
  const key = artistName.toLowerCase();
  if (artistSimilarCache.has(key)) return artistSimilarCache.get(key);
  const data = await lastfmGet("artist.getSimilar", { artist: artistName, limit });
  const artists = data?.similarartists?.artist || [];
  artistSimilarCache.set(key, artists);
  return artists;
}

function tagsMatchAllowlist(tags, allowlist, minDistinctGroups = 1) {
  if (!allowlist) return true;
  const matchedGroups = new Set();
  for (const tag of tags) {
    if (allowlist.has(tag)) {
      const group = HARD_TAG_TO_GROUP.get(tag) || tag;
      matchedGroups.add(group);
      if (matchedGroups.size >= minDistinctGroups) return true;
    }
  }
  return false;
}

async function fetchLastfmUserData() {
  if (!LASTFM_API_KEY) {
    log("No Last.fm API key, skipping user listening data");
    return null;
  }

  log(`Fetching Last.fm data for user: ${LASTFM_USER}`);

  const [topArtists, topTracks] = await Promise.all([
    lastfmGet("user.getTopArtists", { user: LASTFM_USER, period: "overall", limit: 50 }),
    lastfmGet("user.getTopTracks", { user: LASTFM_USER, period: "overall", limit: 200 }),
  ]);

  const artists = (topArtists?.topartists?.artist || []).map((a) => ({
    name: a.name,
    playCount: parseInt(a.playcount) || 0,
  }));

  const tracks = (topTracks?.toptracks?.track || []).map((t) => ({
    name: t.name,
    artist: t.artist?.name,
    playCount: parseInt(t.playcount) || 0,
  }));

  const hasData = artists.length > 0 || tracks.length > 0;

  if (!hasData) {
    log("Last.fm account has no scrobble data yet — falling back to Spotify data");
    return null;
  }

  log(`Last.fm: ${artists.length} top artists, ${tracks.length} top tracks`);
  return { artists, tracks };
}

async function loadTracklists() {
  const tracklistsPath = join(homedir(), ".spotify-discover", "tracklists.json");
  const projectDir = new URL(".", import.meta.url).pathname;
  const myAlbumsPath = join(projectDir, MODE.albumsFile);

  let allTracklists;
  try {
    const data = JSON.parse(await readFile(tracklistsPath, "utf8"));
    allTracklists = data.albums || {};
  } catch {
    return {};
  }

  // Filter to only albums in my-albums.json (if it exists)
  try {
    const myData = JSON.parse(await readFile(myAlbumsPath, "utf8"));
    const myAlbums = myData.albums || [];
    if (myAlbums.length === 0) return allTracklists;

    // Build set of "artist - album" keys from personal list
    const myKeys = new Set(myAlbums.map(a => `${a.artist} - ${a.album}`.toLowerCase()));

    const filtered = {};
    for (const [key, value] of Object.entries(allTracklists)) {
      if (myKeys.has(key)) {
        filtered[key] = value;
      }
    }

    log(`Filtered tracklists to ${Object.keys(filtered).length}/${Object.keys(allTracklists).length} albums (from my-albums.json)`);
    return filtered;
  } catch {
    // No my-albums.json, use all tracklists
    return allTracklists;
  }
}

// ---------------------------------------------------------------------------
// Bucket affinity — biases seeds toward what the user listens to at this
// time-of-day / day-of-week. Source: ~/.spotify-discover/scrobbles.json
// (populated by fetch-scrobbles.mjs).
// ---------------------------------------------------------------------------

const SCROBBLES_PATH = join(CONFIG_DIR, "scrobbles.json");

function bucketOf(date) {
  const dow = date.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const h = date.getHours();
  const band = h < 6 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return `${isWeekend ? "weekend" : "weekday"}-${band}`;
}

async function buildBucketAffinity(now = new Date()) {
  const data = await loadJson(SCROBBLES_PATH);
  const currentBucket = bucketOf(now);
  const affinity = new Map(); // fuzzyKey -> scrobble count in current bucket
  if (!data?.scrobbles?.length) {
    return { currentBucket, affinity, totalInBucket: 0, totalScrobbles: 0 };
  }
  let totalInBucket = 0;
  for (const s of data.scrobbles) {
    if (bucketOf(new Date(s.ts * 1000)) !== currentBucket) continue;
    totalInBucket++;
    const k = fuzzyKey(s.artist, s.track);
    affinity.set(k, (affinity.get(k) || 0) + 1);
  }
  return { currentBucket, affinity, totalInBucket, totalScrobbles: data.scrobbles.length };
}

// How much of the last playlist actually got used, so a refresh can be held
// back until the user has worked through it.
//
// Spotify's API does not report skips, so "skipped" cannot be read directly.
// It can be inferred from position: if track 40 scrobbled, tracks 1-39 were
// played or passed over — either way the listener got that far. Shuffle breaks
// that assumption, so distinct-tracks-played is measured too and the more
// generous of the two wins.
async function lastRunConsumption(runHistory) {
  const modeRuns = (runHistory?.runs || []).filter((r) => (r.mode || "chill") === mode);
  const last = modeRuns[modeRuns.length - 1];
  if (!last?.tracks?.length) return null;

  const runTs = last.id ? Date.parse(last.id) / 1000 : null;
  if (!runTs || Number.isNaN(runTs)) return null;

  const data = await loadJson(SCROBBLES_PATH);
  if (!data?.scrobbles?.length) return null;

  const since = new Set(
    data.scrobbles.filter((sc) => sc.ts > runTs).map((sc) => fuzzyKey(sc.artist, sc.track))
  );

  // A skipped track counts as consumed — the listener reached it and rejected it.
  const measuredSkips = await loadMeasuredSkips();

  let played = 0;
  let skipped = 0;
  let reached = 0;
  last.tracks.forEach((t, i) => {
    const k = fuzzyKey(t.artist, t.track);
    if (since.has(k)) {
      played++;
      reached = i + 1;
    } else if (measuredSkips.has(k)) {
      skipped++;
      reached = i + 1;
    }
  });

  // Count only tracks with evidence. Positional inference ("track 42 played, so
  // 1-42 were consumed") over-counted badly under shuffle: 17 plays reaching
  // position 42 scored 70% when true consumption was 28%. `reached` is kept for
  // the log line only.
  const total = last.tracks.length;
  const consumed = played + skipped;
  const ageDays = (Date.now() / 1000 - runTs) / 86400;
  return { pct: consumed / total, played, skipped, reached, consumed, total, ageDays, runDate: last.date };
}

// Infer dislikes without asking the user to rate anything. Spotify's API does
// not expose skips, but a track that was served in a past playlist and never
// once appears in the scrobble history was never played through. Requires the
// track to have been offered `minRuns` times before counting it as a dislike,
// so a single unlucky run (playlist never played at all) doesn't poison it.
async function inferSkippedTracks(runHistory, minRuns = 2) {
  const data = await loadJson(SCROBBLES_PATH);
  if (!data?.scrobbles?.length) return { keys: new Set(), offeredCounts: new Map(), labels: new Map() };

  const scrobbled = new Set(data.scrobbles.map((s) => fuzzyKey(s.artist, s.track)));

  // Only consider runs old enough to have been listened to, and only this mode.
  const modeRuns = (runHistory?.runs || []).filter((r) => (r.mode || "chill") === mode);

  const offeredCounts = new Map();
  const labels = new Map();
  for (const run of modeRuns) {
    // A run's tracks can only count as "not played" if scrobbles exist after it.
    const runTs = run.timestamp ? Date.parse(run.timestamp) / 1000 : null;
    if (runTs && data.lastFetchedTs && data.lastFetchedTs <= runTs) continue;

    for (const t of run.tracks || []) {
      const k = fuzzyKey(t.artist, t.track);
      offeredCounts.set(k, (offeredCounts.get(k) || 0) + 1);
      if (!labels.has(k)) labels.set(k, `${t.artist} — ${t.track}`);
    }
  }

  // A measured skip is direct evidence, so one is enough. Absence of a scrobble
  // is only circumstantial — it needs `minRuns` offers before it counts.
  const measuredSkips = await loadMeasuredSkips();

  const keys = new Set();
  let measured = 0;
  for (const [k, n] of offeredCounts) {
    if (measuredSkips.has(k)) { keys.add(k); measured++; continue; }
    if (n >= minRuns && !scrobbled.has(k)) keys.add(k);
  }
  return { keys, offeredCounts, labels, measured };
}

// ---------------------------------------------------------------------------
// Find seeds: recent listening that matches your album collection
// ---------------------------------------------------------------------------

async function findSeeds(accessToken, tracklists, lastfmData, feedback, bucketInfo = null) {
  logStep("1/4", `Finding seeds from your recent listening... [mode: ${mode}]`);

  // Build lookup of tracks in our album collection
  const albumTrackLookup = new Map();
  for (const [albumKey, albumData] of Object.entries(tracklists)) {
    if (!albumData.tracks?.length) continue;
    for (const track of albumData.tracks) {
      const key = `${track.artist} - ${track.name}`.toLowerCase()
        .replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, "");
      albumTrackLookup.set(key, {
        artist: track.artist,
        track: track.name,
        album: albumData.spotifyName || albumKey,
        uri: track.uri,
      });
    }
  }

  // Last.fm play-count lookup: authoritative signal of what user actually loves.
  // Keyed fuzzy so "Remastered" variants still match.
  const playCountLookup = new Map();
  for (const t of lastfmData?.tracks || []) {
    if (!t.artist || !t.name) continue;
    playCountLookup.set(fuzzyKey(t.artist, t.name), t.playCount || 0);
  }

  // Get recent listening from Spotify
  const [recentlyPlayed, topTracksShort, topTracksMedium] = await Promise.all([
    spotifyGet("/me/player/recently-played", accessToken, { limit: 50 }),
    spotifyGet("/me/top/tracks", accessToken, { time_range: "short_term", limit: 50 }),
    spotifyGet("/me/top/tracks", accessToken, { time_range: "medium_term", limit: 50 }),
  ]);

  // Collect unique tracks from recent listening
  const recentTracks = new Map();
  const addTrack = (t, source) => {
    const key = `${t.artists?.[0]?.name} - ${t.name}`.toLowerCase()
      .replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, "");
    if (!recentTracks.has(key)) {
      recentTracks.set(key, { artist: t.artists?.[0]?.name, track: t.name, source });
    }
  };

  for (const item of recentlyPlayed.items || []) addTrack(item.track, "recent");
  for (const t of topTracksShort.items || []) addTrack(t, "top-short");
  for (const t of topTracksMedium.items || []) addTrack(t, "top-medium");

  // Match recent tracks against album collection → these become seeds
  const seeds = [];
  const addedKeys = new Set();
  for (const [key, track] of recentTracks) {
    if (albumTrackLookup.has(key)) {
      addedKeys.add(key);
      seeds.push({
        ...track,
        ...albumTrackLookup.get(key),
        source: track.source,
        playCount: playCountLookup.get(key) || 0,
      });
    }
  }

  log(`Found ${recentTracks.size} recent tracks, ${seeds.length} match your album collection`);

  // Feedback-liked tracks: always seeded with high priority — these are tracks
  // the user explicitly said "more like this" about
  if (feedback?.liked?.length > 0) {
    let added = 0;
    for (const l of feedback.liked) {
      const k = fuzzyKey(l.artist, l.track);
      if (addedKeys.has(k)) continue;
      addedKeys.add(k);
      seeds.push({
        artist: l.artist,
        track: l.track,
        source: "feedback-liked",
        playCount: 0, // pseudo-low so it gets extra discovery slots (inverted weighting)
      });
      added++;
    }
    if (added > 0) log(`Added ${added} feedback-liked seeds (high priority)`);
  }

  // Load emerging favourites from mode-specific seed file
  const projectDir = new URL(".", import.meta.url).pathname;
  const mySeedsPath = join(projectDir, MODE.seedFile);
  try {
    const seedData = JSON.parse(await readFile(mySeedsPath, "utf8"));
    // Randomly sample ~60% of favourites per run to vary the seed pool
    const pool = [...(seedData.tracks || [])];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const sampleSize = Math.max(1, Math.ceil(pool.length * 0.6));
    let added = 0;
    for (const s of pool.slice(0, sampleSize)) {
      const key = `${s.artist} - ${s.track}`.toLowerCase()
        .replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, "");
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        seeds.push({
          artist: s.artist,
          track: s.track,
          source: "favourite",
          playCount: playCountLookup.get(key) || 0,
        });
        added++;
      }
    }
    log(`Added ${added} emerging favourites from ${MODE.seedFile} (sampled ${sampleSize}/${pool.length})`);
  } catch {
    // No seed file, that's fine
  }

  const historySeeds = seeds.length;

  // --- Direct sampling from all-time albums ---
  // Check run history for tuned split ratio (mode-scoped), default 70/30 history/albums
  const runHistory = await loadRunHistory();
  const modeRuns = runHistory.runs.filter((r) => (r.mode || "chill") === mode);
  const lastRun = modeRuns[modeRuns.length - 1];
  const albumSeedPct = lastRun?.analysis?.recommendedAlbumSeedPct ?? 0.30;

  // Collect all album tracks not already seeded
  const albumPool = [];
  for (const [albumKey, albumData] of Object.entries(tracklists)) {
    if (!albumData.tracks?.length) continue;
    for (const track of albumData.tracks) {
      const key = `${track.artist} - ${track.name}`.toLowerCase()
        .replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, "");
      if (!addedKeys.has(key)) {
        albumPool.push({
          artist: track.artist,
          track: track.name,
          album: albumData.spotifyName || albumKey,
          uri: track.uri,
          key,
        });
      }
    }
  }

  // Calculate how many album seeds to add based on the split ratio
  // Total seeds = historySeeds / (1 - albumSeedPct), so albumSeeds = total * albumSeedPct
  const targetTotal = Math.ceil(historySeeds / (1 - albumSeedPct));
  const albumSeedTarget = targetTotal - historySeeds;

  if (albumPool.length > 0 && albumSeedTarget > 0) {
    // Pick one representative track per album, then shuffle and take albumSeedTarget
    const albumGroups = new Map();
    for (const t of albumPool) {
      const albumLower = t.album?.toLowerCase() || t.key;
      if (!albumGroups.has(albumLower)) albumGroups.set(albumLower, []);
      albumGroups.get(albumLower).push(t);
    }

    // Pick one random track per album
    const albumReps = [];
    for (const [, tracks] of albumGroups) {
      const pick = tracks[Math.floor(Math.random() * tracks.length)];
      albumReps.push(pick);
    }

    // Shuffle and take what we need
    for (let i = albumReps.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [albumReps[i], albumReps[j]] = [albumReps[j], albumReps[i]];
    }

    let added = 0;
    for (const t of albumReps) {
      if (added >= albumSeedTarget) break;
      addedKeys.add(t.key);
      seeds.push({
        artist: t.artist,
        track: t.track,
        album: t.album,
        uri: t.uri,
        source: "all-time-album",
        playCount: playCountLookup.get(t.key) || 0,
      });
      added++;
    }

    log(`Added ${added} seeds from all-time albums (${(albumSeedPct * 100).toFixed(0)}% target, ${albumPool.length} tracks in pool across ${albumGroups.size} albums)`);
  }

  log(`Total seeds: ${seeds.length} (${historySeeds} history/favourites + ${seeds.length - historySeeds} all-time albums)`);

  // Drop seeds belonging to the other mode's territory. Chill's album list holds
  // plenty of heavy artists, and artist.getSimilar on those walks straight into
  // nu-metal and industrial — material that belongs in Heavy, not here. Filtering
  // at the seed stage stops the exploration heading that way at all, rather than
  // generating those candidates and discarding them afterwards.
  if (MODE.seedGenreBlocklist) {
    const seedArtists = [...new Set(seeds.map((s) => s.artist))];
    await fetchArtistTagsBatch(seedArtists);

    const blocked = [];
    const kept = seeds.filter((s) => {
      const tags = artistTagCache.get(s.artist.toLowerCase()) || [];
      // Either one unambiguous heavy tag, or two distinct heavy groups — so a
      // lone "metal" on an otherwise non-heavy artist doesn't disqualify them.
      const decisive = tags.some((t) => DECISIVE_HARD_TAGS.has(t));
      if (decisive || tagsMatchAllowlist(tags, MODE.seedGenreBlocklist, 2)) {
        blocked.push(s.artist);
        return false;
      }
      return true;
    });

    if (blocked.length > 0) {
      const names = [...new Set(blocked)];
      log(`Dropped ${blocked.length} heavy seeds from ${mode}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, +${names.length - 8} more` : ""}`);
      seeds.length = 0;
      seeds.push(...kept);
    }
  }

  // Tag every seed with bucketAffinity (scrobble count in current time bucket)
  if (bucketInfo?.affinity) {
    for (const s of seeds) {
      s.bucketAffinity = bucketInfo.affinity.get(fuzzyKey(s.artist, s.track)) || 0;
    }
    const matched = seeds.filter((s) => s.bucketAffinity > 0).length;
    log(`Bucket affinity (${bucketInfo.currentBucket}, ${bucketInfo.totalInBucket} scrobbles): ${matched}/${seeds.length} seeds matched`);
  } else {
    for (const s of seeds) s.bucketAffinity = 0;
  }

  // Recency-bias seed ordering: seeds used in last 3 runs go last,
  // so fresh seeds query Last.fm first and aren't truncated by targetCount.
  // Within fresh seeds, bucket-matched seeds query first (so the current
  // listening context shapes recommendations even if the candidate cap is hit).
  const recentSeedUse = new Set();
  for (const run of runHistory.runs.slice(-3)) {
    for (const t of run.tracks || []) {
      if (t.seed) recentSeedUse.add(t.seed.toLowerCase());
    }
  }
  const fresh = [], used = [];
  for (const s of seeds) {
    const seedKey = `${s.artist} - ${s.track}`.toLowerCase();
    (recentSeedUse.has(seedKey) ? used : fresh).push(s);
  }
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  // Sort fresh by bucket affinity desc, with shuffling inside each affinity tier
  // so seeds with the same score don't always appear in the same order.
  shuffle(fresh);
  fresh.sort((a, b) => (b.bucketAffinity || 0) - (a.bucketAffinity || 0));
  const reordered = [...fresh, ...shuffle(used)];
  if (used.length > 0) {
    log(`Seed rotation: ${fresh.length} fresh first, ${used.length} recently-used last`);
  }
  return reordered;
}

// ---------------------------------------------------------------------------
// Get recently played tracks for exclusion (don't recommend what they just heard)
// ---------------------------------------------------------------------------

// Measured skip detection.
//
// Spotify exposes no skip flag, but /me/player/recently-played carries played_at
// per item and duration_ms per track. The gap between consecutive plays is how
// long the earlier track actually ran, so a track that ran well short of its
// length was skipped.
//
// Two things this cannot see: the last track before a session ends (the gap
// then measures idle time, not playback), and skips under ~30s, which Spotify
// omits from the endpoint entirely. Observations accumulate on disk because the
// endpoint only returns the last 50 plays.
const SKIP_FRACTION = 0.6;      // ran less than this proportion => skipped
const SESSION_SLACK_S = 120;    // tolerated pause before a gap is unmeasurable

async function recordSkips(items) {
  const store = (await loadJson(SKIPS_PATH)) || {};
  let newSkips = 0, newPlays = 0;

  // items are newest-first, so items[i + 1] is the track that played before items[i]
  for (let i = 0; i < items.length - 1; i++) {
    const earlier = items[i + 1];
    const durS = (earlier.track?.duration_ms || 0) / 1000;
    if (!durS) continue;

    const gapS = (Date.parse(items[i].played_at) - Date.parse(earlier.played_at)) / 1000;
    if (gapS <= 0) continue;
    if (gapS > durS + SESSION_SLACK_S) continue; // session break or long pause

    const key = fuzzyKey(earlier.track.artists?.[0]?.name || "", earlier.track.name || "");
    const ts = earlier.played_at;
    const rec = store[key] || { plays: 0, skips: 0, lastTs: null, lastFraction: null };
    if (rec.lastTs === ts) continue; // already recorded this play

    const fraction = Math.min(gapS / durS, 1);
    if (fraction < SKIP_FRACTION) { rec.skips++; newSkips++; }
    else { rec.plays++; newPlays++; }
    rec.lastTs = ts;
    rec.lastFraction = Math.round(fraction * 100) / 100;
    store[key] = rec;
  }

  if (newSkips || newPlays) {
    await saveJson(SKIPS_PATH, store);
    log(`Skip detection: ${newSkips} skipped, ${newPlays} played through (${Object.keys(store).length} tracked)`);
  }
  return store;
}

// Tracks measured as skipped and never once played through.
async function loadMeasuredSkips() {
  const store = (await loadJson(SKIPS_PATH)) || {};
  const keys = new Set();
  for (const [k, v] of Object.entries(store)) {
    if (v.skips > 0 && v.plays === 0) keys.add(k);
  }
  return keys;
}

async function getRecentlyPlayed(accessToken) {
  // Soft filter: only the last 50 actually-played tracks, so we don't
  // recommend something the user just heard. Top-tracks lists are not
  // excluded — known-but-not-overplayed tracks are welcome ("hey you
  // might like this"). Heavily-played tracks are filtered separately
  // via the Last.fm play-count threshold in findCandidates.
  const recentlyPlayed = await spotifyGet("/me/player/recently-played", accessToken, { limit: 50 });

  // Same payload already carries what skip detection needs — no extra call.
  await recordSkips(recentlyPlayed.items || []);

  const played = new Set();
  for (const item of recentlyPlayed.items || []) {
    const track = item.track;
    played.add(`${track.artists?.[0]?.name} - ${track.name}`.toLowerCase()
      .replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, ""));
  }

  log(`Recently played: ${played.size} tracks (will skip these to avoid immediate repeats)`);
  return played;
}

// ---------------------------------------------------------------------------
// Find candidates: seed tracks → Last.fm getSimilar → search Spotify
// ---------------------------------------------------------------------------

async function findCandidates(seeds, recentlyPlayed, accessToken, targetCount = 70, excludeRunCount = 3, feedback = null, lastfmData = null) {
  if (!LASTFM_API_KEY) {
    throw new Error("Last.fm API key required. Set LASTFM_API_KEY in your .env file.");
  }

  logStep("2/4", `Finding ~${targetCount} candidate tracks via Last.fm similarity... [mode: ${mode}]`);

  log(`Processing ${seeds.length} seeds`);

  // Per-seed slot allocation is INVERTED: least-played seeds get MORE
  // recommendation slots, pushing Last.fm similarity toward unexplored taste
  // corners. This maximizes discovery instead of reinforcing familiar territory.
  // Additionally, seeds in the top quartile by bucket-affinity (matching the
  // current weekday/time-band) get +1 extra slot so the playlist reflects
  // what the user actually listens to in this context.
  const baseSeed = Math.max(3, Math.ceil(targetCount / seeds.length));
  const sortedByPlays = [...seeds].sort((a, b) => (a.playCount || 0) - (b.playCount || 0));
  const seedSlots = new Map();

  // Identify bucket-affinity top quartile (only among seeds that have any affinity > 0)
  const withAffinity = seeds.filter((s) => (s.bucketAffinity || 0) > 0);
  const sortedByAffinity = [...withAffinity].sort((a, b) => (b.bucketAffinity || 0) - (a.bucketAffinity || 0));
  const affinityTopQuartileCount = Math.ceil(sortedByAffinity.length * 0.25);
  const bucketBoosted = new Set(
    sortedByAffinity.slice(0, affinityTopQuartileCount).map((s) => fuzzyKey(s.artist, s.track))
  );

  for (let i = 0; i < sortedByPlays.length; i++) {
    const pct = i / sortedByPlays.length;
    let slots = baseSeed;
    if (pct < 0.25) slots = baseSeed + 2;
    else if (pct < 0.50) slots = baseSeed + 1;
    else if (pct >= 0.75) slots = Math.max(2, baseSeed - 1);
    const seedKey = fuzzyKey(sortedByPlays[i].artist, sortedByPlays[i].track);
    if (bucketBoosted.has(seedKey)) slots += 1;
    seedSlots.set(seedKey, slots);
  }
  if (bucketBoosted.size > 0) {
    log(`Bucket-boosted seeds (+1 slot): ${bucketBoosted.size}`);
  }

  const MAX_PER_ARTIST = 3;
  const candidates = [];
  const seenTracks = new Set();
  const seenArtists = new Map();

  // Artists the user demonstrably already likes — from their own album list and
  // from anything they've actually scrobbled. For these, the obvious hit is the
  // last thing they want ("I really like Rage Against The Machine, but I've
  // heard Killing In The Name 100,000 times"). Deeper catalogue cuts instead.
  const familiarArtists = new Set();
  for (const a of lastfmData?.artists || []) {
    if ((a.playCount || 0) > 0) familiarArtists.add(a.name.toLowerCase());
  }
  try {
    const projectDir = new URL(".", import.meta.url).pathname;
    const myData = JSON.parse(await readFile(join(projectDir, MODE.albumsFile), "utf8"));
    for (const al of myData.albums || []) familiarArtists.add(al.artist.toLowerCase());
  } catch {
    // no album list — fall back to scrobble data alone
  }

  // The album list plus a 5-month Last.fm history misses decades of listening,
  // which mislabels long-known artists as new and serves them their biggest hit.
  // The Spotify library covers that gap: follows, saved albums, liked tracks and
  // top artists on long_term all mean "already known".
  {
    const before = familiarArtists.size;
    const addArtists = (arr) => {
      for (const a of arr || []) if (a?.name) familiarArtists.add(a.name.toLowerCase());
    };
    const results = await Promise.all([
      spotifyGet("/me/following", accessToken, { type: "artist", limit: 50 }).catch(() => null),
      spotifyGet("/me/albums", accessToken, { limit: 50 }).catch(() => null),
      spotifyGet("/me/tracks", accessToken, { limit: 50 }).catch(() => null),
      ...["long_term", "medium_term", "short_term"].map((r) =>
        spotifyGet("/me/top/artists", accessToken, { time_range: r, limit: 50 }).catch(() => null)
      ),
    ]);

    const [following, albums, tracks, ...topArtistPages] = results;
    addArtists(following?.artists?.items);
    for (const it of albums?.items || []) addArtists(it.album?.artists);
    for (const it of tracks?.items || []) addArtists(it.track?.artists);
    for (const page of topArtistPages) addArtists(page?.items);

    log(`Familiar artists: +${familiarArtists.size - before} from Spotify library`);
  }

  log(`Familiar artists (deep cuts only): ${familiarArtists.size}`);

  const getTopTracksFor = getArtistTopTrackNames;

  // How many of a familiar artist's biggest tracks to treat as burned-in.
  const HIT_DEPTH = 5;
  async function isSignatureHit(artistName, trackName) {
    if (!familiarArtists.has(artistName.toLowerCase())) return false;
    const top = await getTopTracksFor(artistName);
    if (top.length === 0) return false;
    const key = fuzzyKey(artistName, trackName);
    return top.slice(0, HIT_DEPTH).some((n) => fuzzyKey(artistName, n) === key);
  }
  let apiCalls = 0;

  // Build seed track set so we never recommend a seed track back
  const seedTrackKeys = new Set(seeds.map((s) => fuzzyKey(s.artist, s.track)));

  // Build exclusion set from previously-recommended tracks (last N runs of this mode)
  const excludeKeys = new Set();
  if (excludeRunCount > 0) {
    const runHistory = await loadRunHistory();
    const recentRuns = runHistory.runs
      .filter((r) => (r.mode || "chill") === mode)
      .slice(-excludeRunCount);
    for (const run of recentRuns) {
      for (const t of run.tracks || []) {
        excludeKeys.add(fuzzyKey(t.artist, t.track));
      }
    }
    if (excludeKeys.size > 0) {
      log(`Excluding ${excludeKeys.size} tracks from last ${recentRuns.length} runs (mode: ${mode})`);
    }
  }

  // Feedback-skipped tracks never come back
  if (feedback?.skipped?.length > 0) {
    for (const s of feedback.skipped) excludeKeys.add(fuzzyKey(s.artist, s.track));
    log(`Excluding ${feedback.skipped.length} feedback-skipped tracks`);
  }

  // Inferred dislikes — served two or more times, never scrobbled once.
  // This is the automatic equivalent of --skip: no rating required from the user.
  {
    const runHistory = await loadRunHistory();
    const inferred = await inferSkippedTracks(runHistory, 2);
    let added = 0;
    for (const k of inferred.keys) {
      if (!excludeKeys.has(k)) { excludeKeys.add(k); added++; }
    }
    if (inferred.keys.size > 0) {
      const sample = [...inferred.keys].slice(0, 5).map((k) => inferred.labels.get(k) || k);
      log(`Excluding ${inferred.keys.size} inferred dislikes (${inferred.measured} measured skips, rest offered 2+ times and never played): ${sample.join("; ")}${inferred.keys.size > 5 ? "; …" : ""}`);
    }
  }

  // Exclude heavily-played tracks. The threshold is relative to this account's
  // actual scrobble depth — a fixed 50 excluded nothing, because the most-played
  // track here has ~11 plays. Anything in the top slice of play counts is
  // burned-in for this listener regardless of the absolute number.
  if (lastfmData?.tracks?.length > 0) {
    const counts = lastfmData.tracks
      .map((t) => t.playCount || 0)
      .filter((n) => n > 0)
      .sort((a, b) => b - a);

    if (counts.length > 0) {
      // Top 10% of play counts, floored at 3 so a thin history can't exclude
      // everything it has ever seen twice.
      const cutIdx = Math.floor(counts.length * 0.1);
      const threshold = Math.max(3, counts[cutIdx] ?? 3);

      let overplayedCount = 0;
      for (const t of lastfmData.tracks) {
        if ((t.playCount || 0) < threshold) continue;
        const key = fuzzyKey(t.artist, t.name);
        if (!excludeKeys.has(key)) {
          excludeKeys.add(key);
          overplayedCount++;
        }
      }
      log(`Excluding ${overplayedCount} heavily-played tracks (Last.fm plays >= ${threshold}, adaptive)`);
    }
  }

  log(`Total exclusion set: ${excludeKeys.size} tracks`);

  log(`Weighted per-seed slots: base ${baseSeed} (discovery-weighted: low-play seeds +2, high-play seeds -1)`);

  // Pass 0: artist.getSimilar → artist.getTopTracks.
  // Reaches artists the user does not own at all, rather than track.getSimilar's
  // popularity-biased "you liked Man in the Box, here's Black". Runs before
  // track.getSimilar so the pool leads with discovered artists.
  //
  // `artistDiscoveryBudget` caps how much of the pool this pass may claim.
  // Hard mode takes the whole thing (its genre allowlist needs the depth);
  // chill blends, so track-level similarity still contributes.
  if (MODE.artistDiscoveryBudget > 0) {
    const artistPassCap = Math.round(targetCount * MODE.artistDiscoveryBudget);
    const uniqueSeedArtists = [...new Set(seeds.map((s) => s.artist))];
    const seenSimilarArtists = new Set();
    log(`  Artist-discovery pass: ${uniqueSeedArtists.length} unique seed artists...`);

    // Fetch every seed artist's related list up front, then round-robin across
    // them. Draining one seed artist at a time let the first few eat the whole
    // budget, so the pool inherited a single genre. Lapping across all of them
    // spreads discovery over the user's full taste instead.
    const relatedBySeed = new Map();
    for (const seedArtist of uniqueSeedArtists) {
      try {
        const cached = artistSimilarCache.has(seedArtist.toLowerCase());
        const related = await getArtistSimilar(seedArtist, 30);
        if (!cached) { apiCalls++; await new Promise((r) => setTimeout(r, 200)); }
        if (related?.length) relatedBySeed.set(seedArtist, related);
      } catch {
        // skip failed lookups
      }
    }

    // Lap N takes each seed artist's Nth-most-similar artist. Later laps sit
    // further from the centre of the user's taste, so breadth grows with depth.
    const maxLaps = 12;
    outer:
    for (let lap = 0; lap < maxLaps; lap++) {
      for (const [seedArtist, related] of relatedBySeed) {
        if (candidates.length >= artistPassCap) break outer;

        const ra = related[lap];
        if (!ra) continue;

        const artistLower = ra.name.toLowerCase();
        if (artistLower === seedArtist.toLowerCase()) continue;
        if (seenSimilarArtists.has(artistLower)) continue;
        if ((seenArtists.get(resolveArtistAlias(artistLower)) || 0) >= MAX_PER_ARTIST) continue;

        seenSimilarArtists.add(artistLower);

        const allTop = await getTopTracksFor(ra.name);
        apiCalls++;
        if (allTop.length === 0) continue;

        // Familiar artist → skip their signature tracks and draw from the
        // catalogue behind them. Unfamiliar artist → lead with what they're
        // known for, which is the right introduction.
        const familiar = familiarArtists.has(artistLower);
        const pickFrom = familiar ? allTop.slice(HIT_DEPTH, HIT_DEPTH + 15) : allTop.slice(0, 8);
        if (pickFrom.length === 0) continue;

        let added = 0;
        for (const name of pickFrom) {
          if (added >= 2) break;
          const key = `${ra.name} - ${name}`.toLowerCase();
          const normalizedKey = fuzzyKey(ra.name, name);

          if (seedTrackKeys.has(normalizedKey)) continue;
          if (excludeKeys.has(normalizedKey)) continue;
          if (seenTracks.has(key)) continue;
          if (recentlyPlayed.has(key)) continue;
          if ((seenArtists.get(resolveArtistAlias(artistLower)) || 0) >= MAX_PER_ARTIST) continue;

          seenTracks.add(key);
          seenArtists.set(resolveArtistAlias(artistLower), (seenArtists.get(resolveArtistAlias(artistLower)) || 0) + 1);
          candidates.push({
            artist: ra.name,
            track: name,
            similarTo: `${seedArtist} (artist-similar, lap ${lap + 1}${familiar ? ", deep cut" : ""})`,
            matchScore: parseFloat(ra.match) || 0.3,
            seedSource: seeds.find((s) => s.artist === seedArtist)?.source || "artist-similar",
          });
          added++;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    log(`  Artist-discovery pass: ${candidates.length} candidates so far (${seenSimilarArtists.size} similar artists explored)`);
    await saveArtistSimilarCache();
    await saveArtistTopTracksCache();
  }

  // First pass: query all seeds via track.getSimilar
  for (const seed of seeds) {
    if (candidates.length >= targetCount) break;

    const seedKey = fuzzyKey(seed.artist, seed.track);
    const maxForThisSeed = seedSlots.get(seedKey) ?? baseSeed;

    try {
      const data = await lastfmGet("track.getSimilar", {
        artist: seed.artist,
        track: seed.track,
        limit: 50,
      });

      apiCalls++;
      const similarTracks = data?.similartracks?.track || [];
      let seedMatches = 0;

      for (const sim of similarTracks) {
        if (seedMatches >= maxForThisSeed) break;

        const simArtist = sim.artist?.name || "";
        const simTrack = sim.name || "";
        const key = `${simArtist} - ${simTrack}`.toLowerCase();
        const artistLower = simArtist.toLowerCase();
        const normalizedKey = key.replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, "");

        // Skip same artist as seed — Last.fm often returns same-artist tracks
        if (artistLower === seed.artist.toLowerCase()) continue;
        // Skip seed tracks appearing as recommendations
        if (seedTrackKeys.has(normalizedKey)) continue;
        // Skip tracks recommended in recent runs
        if (excludeKeys.has(normalizedKey)) continue;
        // Skip duplicates, recently played, or over-represented artists
        if (seenTracks.has(key)) continue;
        if (recentlyPlayed.has(key)) continue;
        if ((seenArtists.get(resolveArtistAlias(artistLower)) || 0) >= MAX_PER_ARTIST) continue;
        // An artist the user already likes, offering the track they've worn out
        if (await isSignatureHit(simArtist, simTrack)) continue;

        seenTracks.add(key);
        seenArtists.set(resolveArtistAlias(artistLower), (seenArtists.get(resolveArtistAlias(artistLower)) || 0) + 1);
        candidates.push({
          artist: simArtist,
          track: simTrack,
          similarTo: `${seed.artist} - ${seed.track}`,
          matchScore: parseFloat(sim.match) || 0,
          seedSource: seed.source,
        });
        seedMatches++;
      }

      if (apiCalls % 10 === 0) {
        log(`  ${candidates.length} candidates found after ${apiCalls} lookups`);
      }

      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // Skip failed lookups
    }
  }

  // Second pass: if we still need more, use the best candidates as secondary seeds
  if (candidates.length < targetCount) {
    const secondarySeeds = candidates
      .filter((c) => c.matchScore > 0.1)
      .slice(0, 20);
    log(`  Need more — chaining ${secondarySeeds.length} candidates as secondary seeds...`);

    for (const sec of secondarySeeds) {
      if (candidates.length >= targetCount) break;

      try {
        const data = await lastfmGet("track.getSimilar", {
          artist: sec.artist,
          track: sec.track,
          limit: 50,
        });

        apiCalls++;
        const similarTracks = data?.similartracks?.track || [];
        let seedMatches = 0;

        for (const sim of similarTracks) {
          if (seedMatches >= 3) break;
          const simArtist = sim.artist?.name || "";
          const simTrack = sim.name || "";
          const key = `${simArtist} - ${simTrack}`.toLowerCase();
          const artistLower = simArtist.toLowerCase();
          const normalizedKey = key.replace(/\s*[-–—]\s*(remaster|remastered|deluxe|bonus|remix|live|mono|stereo|radio|single|album|edit|\d{4}).*$/i, "");

          // Skip same artist as seed
          if (artistLower === sec.artist.toLowerCase()) continue;
          // Skip seed tracks
          if (seedTrackKeys.has(normalizedKey)) continue;
          if (seenTracks.has(key)) continue;
          if (recentlyPlayed.has(key)) continue;
          if ((seenArtists.get(resolveArtistAlias(artistLower)) || 0) >= MAX_PER_ARTIST) continue;

          seenTracks.add(key);
          seenArtists.set(resolveArtistAlias(artistLower), (seenArtists.get(resolveArtistAlias(artistLower)) || 0) + 1);
          candidates.push({
            artist: simArtist,
            track: simTrack,
            similarTo: `${sec.artist} - ${sec.track} (via ${sec.similarTo})`,
            matchScore: parseFloat(sim.match) || 0,
            seedSource: sec.seedSource,
          });
          seedMatches++;
        }

        await new Promise((r) => setTimeout(r, 200));
      } catch {
        // Skip failed lookups
      }
    }
  }

  log(`Found ${candidates.length} candidates from ${apiCalls} Last.fm lookups`);

  // Fourth pass: Spotify Recommendations API — different algorithm than Last.fm's
  // collaborative filtering, surfaces tracks from Spotify's audio-feature graph.
  // Uses low-play-count seeds and caps popularity to push toward genuine discovery.
  if (candidates.length < targetCount) {
    const discoverySeeds = seeds
      .filter((s) => s.uri)
      .sort((a, b) => (a.playCount || 0) - (b.playCount || 0))
      .slice(0, 5);

    if (discoverySeeds.length > 0) {
      log(`  Spotify recs pass: querying with ${discoverySeeds.length} low-play seeds (max popularity 60)...`);
      const seedTrackIds = discoverySeeds.map((s) => s.uri.split(":").pop()).join(",");
      try {
        const recs = await spotifyGet("/recommendations", accessToken, {
          seed_tracks: seedTrackIds,
          limit: 30,
          max_popularity: 60,
        });

        let spotifyRecsAdded = 0;
        for (const t of recs.tracks || []) {
          if (candidates.length >= targetCount) break;
          const artist = t.artists?.[0]?.name || "";
          const track = t.name || "";
          const key = `${artist} - ${track}`.toLowerCase();
          const normalizedKey = fuzzyKey(artist, track);
          const artistLower = artist.toLowerCase();

          if (seedTrackKeys.has(normalizedKey)) continue;
          if (excludeKeys.has(normalizedKey)) continue;
          if (seenTracks.has(key)) continue;
          if (recentlyPlayed.has(key)) continue;
          if ((seenArtists.get(resolveArtistAlias(artistLower)) || 0) >= MAX_PER_ARTIST) continue;

          seenTracks.add(key);
          seenArtists.set(resolveArtistAlias(artistLower), (seenArtists.get(resolveArtistAlias(artistLower)) || 0) + 1);
          candidates.push({
            artist,
            track,
            similarTo: `Spotify recs (${discoverySeeds[0].artist})`,
            matchScore: 0.5,
            seedSource: "spotify-recs",
            spotifyUri: t.uri,
            spotifyPopularity: t.popularity,
          });
          spotifyRecsAdded++;
        }
        if (spotifyRecsAdded > 0) log(`  Added ${spotifyRecsAdded} candidates from Spotify Recommendations API`);
      } catch (err) {
        log(`  Spotify recs failed: ${err.message}`);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error("No candidates found. Check your seeds and Last.fm API key.");
  }

  // Fetch artist tags for genre filtering + curation context
  await fetchArtistTagsBatch(candidates.map((c) => c.artist));
  for (const c of candidates) {
    c.genres = artistTagCache.get(c.artist.toLowerCase()) || [];
  }

  // Hard-mode genre allowlist filter: candidate must have at least one tag
  // that matches the hard-music allowlist, else cut. No allowlist = pass.
  if (MODE.genreAllowlist) {
    const before = candidates.length;
    const filtered = candidates.filter((c) => tagsMatchAllowlist(c.genres, MODE.genreAllowlist));
    const cut = before - filtered.length;
    log(`Genre filter [${mode}]: kept ${filtered.length}/${before} candidates (cut ${cut} that didn't match hard tags)`);
    candidates.length = 0;
    candidates.push(...filtered);
    if (candidates.length === 0) {
      throw new Error(`No candidates survived the hard-mode genre filter. Check seeds in ${MODE.seedFile} — they need to trace back to heavy music.`);
    }
  }

  // Cap candidates before Spotify search to avoid rate limits.
  // Sort by match score descending, keep the best 150 (enough for Claude to curate 60 from).
  const SPOTIFY_SEARCH_CAP = 150;
  if (candidates.length > SPOTIFY_SEARCH_CAP) {
    candidates.sort((a, b) => b.matchScore - a.matchScore);
    const cut = candidates.length - SPOTIFY_SEARCH_CAP;
    candidates.length = SPOTIFY_SEARCH_CAP;
    log(`Capped to top ${SPOTIFY_SEARCH_CAP} candidates by match score (dropped ${cut} lower-scoring)`);
  }

  // Resolve candidates on Spotify to get URIs
  logStep("3/4", `Searching Spotify for ${candidates.length} candidate tracks...`);

  const resolved = [];
  const resolvedUris = new Set(); // dedup by Spotify URI
  let notFound = 0;
  let cacheHits = 0;
  let searched = 0;
  let rateLimited = 0;

  for (const c of candidates) {
    // Spotify recs candidates already have a URI — skip search
    if (c.spotifyUri) {
      if (resolvedUris.has(c.spotifyUri)) continue;
      resolvedUris.add(c.spotifyUri);
      resolved.push({
        uri: c.spotifyUri,
        name: c.track,
        artist: c.artist,
        album: null,
        year: null,
        similarTo: c.similarTo,
        matchScore: c.matchScore,
        seedSource: c.seedSource,
        genres: c.genres || [],
        popularity: c.spotifyPopularity ?? null,
        why: `Similar to: ${c.similarTo} (match: ${(c.matchScore * 100).toFixed(0)}%)`,
      });
      continue;
    }

    const cacheKey = fuzzyKey(c.artist, c.track);
    const hit = trackUriCache.get(cacheKey);
    if (hit) {
      cacheHits++;
      if (resolvedUris.has(hit.uri)) continue;
      resolvedUris.add(hit.uri);
      resolved.push({
        uri: hit.uri,
        name: hit.name,
        artist: hit.artist,
        album: hit.album,
        year: hit.year,
        similarTo: c.similarTo,
        matchScore: c.matchScore,
        seedSource: c.seedSource,
        genres: c.genres || [],
        popularity: hit.popularity ?? null,
        why: `Similar to: ${c.similarTo} (match: ${(c.matchScore * 100).toFixed(0)}%)`,
      });
      continue;
    }

    const query = `track:${c.track} artist:${c.artist}`;
    try {
      const results = await spotifyGet("/search", accessToken, {
        q: query,
        type: "track",
        limit: 3,
      });
      searched++;

      const tracks = results.tracks?.items || [];
      if (tracks.length > 0) {
        const match = tracks.find((t) =>
          t.artists.some((a) => a.name.toLowerCase() === c.artist.toLowerCase())
        ) || tracks[0];

        const entry = {
          uri: match.uri,
          name: match.name,
          artist: match.artists[0]?.name,
          album: match.album?.name || null,
          year: match.album?.release_date ? parseInt(match.album.release_date.slice(0, 4)) : null,
          popularity: match.popularity ?? null,
        };
        trackUriCache.set(cacheKey, entry);

        // Dedup by URI — same track can appear from different seeds
        if (resolvedUris.has(match.uri)) continue;
        resolvedUris.add(match.uri);

        resolved.push({
          ...entry,
          similarTo: c.similarTo,
          matchScore: c.matchScore,
          seedSource: c.seedSource,
          genres: c.genres || [],
          why: `Similar to: ${c.similarTo} (match: ${(c.matchScore * 100).toFixed(0)}%)`,
        });
      } else {
        notFound++;
      }
    } catch (err) {
      // A throttled search is not "this track doesn't exist". Swallowing the
      // difference produced a run that resolved 0/84 and only failed later, at
      // curation, with a misleading error.
      if (/rate limit/i.test(err.message)) {
        rateLimited++;
        if (rateLimited >= 5) {
          await saveTrackUriCache();
          throw new Error(
            `Spotify is rate limiting: ${rateLimited} searches refused, ${resolved.length}/${candidates.length} resolved. ` +
            `Cached what resolved — re-run later and it will pick up from the cache.`
          );
        }
      } else {
        notFound++;
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  await saveTrackUriCache();
  log(`Resolved ${resolved.length}/${candidates.length} on Spotify (${cacheHits} from cache, ${searched} searched, ${notFound} not found)`);
  // Signature-hit checks run after the artist pass saved, so persist again to
  // capture everything this run learned.
  await saveArtistTopTracksCache();
  return resolved;
}

// ---------------------------------------------------------------------------
// Config (Client ID + Secret)
// ---------------------------------------------------------------------------

async function getConfig() {
  let config = await loadJson(CONFIG_PATH);
  if (config?.clientId && config?.clientSecret) return config;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║           Spotify Discovery Engine — Setup              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log("You need a Spotify Developer app. Here's how:\n");
  console.log("  1. Go to https://developer.spotify.com/dashboard");
  console.log("  2. Log in with your Spotify Premium account");
  console.log('  3. Click "Create app"');
  console.log('  4. Name it anything (e.g. "Discovery Engine")');
  console.log(`  5. Set Redirect URI to: ${REDIRECT_URI}`);
  console.log('  6. Select "Web API" when asked which APIs');
  console.log("  7. Copy your Client ID and Client Secret\n");

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const clientId = (await ask("Client ID: ")).trim();
  const clientSecret = (await ask("Client Secret: ")).trim();
  rl.close();

  if (!clientId || !clientSecret) {
    console.error("Both Client ID and Client Secret are required.");
    process.exit(1);
  }

  config = { clientId, clientSecret };
  await saveJson(CONFIG_PATH, config);
  console.log(`\nConfig saved to ${CONFIG_PATH}`);
  return config;
}

// ---------------------------------------------------------------------------
// Claude API config
// ---------------------------------------------------------------------------

async function getClaudeApiKey() {
  const config = await loadJson(CONFIG_PATH);
  if (config?.claudeApiKey) return config.claudeApiKey;

  // Check env var
  if (process.env.ANTHROPIC_API_KEY) {
    const updated = { ...config, claudeApiKey: process.env.ANTHROPIC_API_KEY };
    await saveJson(CONFIG_PATH, updated);
    return process.env.ANTHROPIC_API_KEY;
  }

  console.log("\nClaude API key needed for music recommendations.");
  console.log("Get one at: https://console.anthropic.com/\n");

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const key = (await ask("Anthropic API Key: ")).trim();
  rl.close();

  if (!key) {
    console.error("API key is required.");
    process.exit(1);
  }

  const updated = { ...(config || {}), claudeApiKey: key };
  await saveJson(CONFIG_PATH, updated);
  return key;
}

// ---------------------------------------------------------------------------
// Spotify Auth (Authorization Code Flow)
// ---------------------------------------------------------------------------

async function getSpotifyTokens(config) {
  if (!forceAuth) {
    const tokens = await loadJson(TOKEN_PATH);
    if (tokens?.refresh_token) {
      // Try refresh
      const refreshed = await refreshToken(config, tokens.refresh_token);
      if (refreshed) return refreshed;
    }
  }

  // Full auth flow
  return await authorizeUser(config);
}

async function authorizeUser(config) {
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);

  // No browser on CI. Fail immediately instead of burning the 2-minute callback
  // timeout and reporting a vague authorization error.
  if (process.env.CI) {
    throw new Error(
      "Spotify refresh token is invalid and no browser is available on CI. " +
      "Re-run `node discover.mjs --auth` locally, update the SPOTIFY_TOKENS secret, then clear the Actions cache."
    );
  }

  console.log("\nOpening browser for Spotify authorization...");
  console.log("If it doesn't open, visit this URL:\n");
  console.log(`  ${authUrl.toString()}\n`);

  // Dynamic import of 'open' — falls back to just printing the URL
  try {
    const open = (await import("open")).default;
    await open(authUrl.toString());
  } catch {
    // URL already printed above
  }

  // Wait for callback
  const code = await waitForCallback(state);

  // Exchange code for tokens
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = await tokenRes.json();
  tokens.obtained_at = Date.now();
  await saveJson(TOKEN_PATH, tokens);
  return tokens;
}

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Authorization denied.</h2><p>You can close this tab.</p>");
        server.close();
        reject(new Error(`Auth denied: ${error}`));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>State mismatch.</h2>");
        server.close();
        reject(new Error("State mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#1DB954">
          <div style="text-align:center">
            <h1>✓ Connected</h1>
            <p style="color:#999">You can close this tab and return to the terminal.</p>
          </div>
        </body></html>
      `);
      server.close();
      resolve(code);
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      log(`Waiting for authorization on port ${REDIRECT_PORT}...`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timed out (2 min)"));
    }, 120_000);
  });
}

async function refreshToken(config, refreshTokenStr) {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshTokenStr,
      }),
    });

    if (!res.ok) return null;

    const tokens = await res.json();
    // Keep the refresh token if a new one wasn't issued
    if (!tokens.refresh_token) tokens.refresh_token = refreshTokenStr;
    tokens.obtained_at = Date.now();
    await saveJson(TOKEN_PATH, tokens);
    return tokens;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Spotify API helpers
// ---------------------------------------------------------------------------

async function spotifyGet(endpoint, accessToken, params = {}, _retries = 0) {
  const url = new URL(`https://api.spotify.com/v1${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    if (_retries >= 5) throw new Error(`Spotify rate limit on ${endpoint} after ${_retries} retries`);
    // Honour what Spotify actually asks for. Capping at 30s meant retrying long
    // before the window cleared, which extends the throttle instead of riding it
    // out. Only cap high enough to avoid an unbounded stall.
    const retryAfter = Math.min(parseInt(res.headers.get("retry-after") || "2"), 300);
    log(`Rate limited, waiting ${retryAfter}s... (attempt ${_retries + 1}/5)`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return spotifyGet(endpoint, accessToken, params, _retries + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API ${endpoint} failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function spotifyPost(endpoint, accessToken, body) {
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify POST ${endpoint} failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function spotifyPut(endpoint, accessToken, body) {
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify PUT ${endpoint} failed (${res.status}): ${text}`);
  }

  // PUT endpoints often return 200/201 with no body
  const contentType = res.headers.get("content-type");
  if (contentType?.includes("json")) return res.json();
  return null;
}

// ---------------------------------------------------------------------------
// Gather taste profile
// ---------------------------------------------------------------------------

async function gatherTasteProfile(accessToken) {
  logStep("1/4", "Reading your Spotify taste profile...");

  // Pull all three time ranges for both artists and tracks, plus recently played
  const [
    topArtistsShort, topArtistsMedium, topArtistsLong,
    topTracksShort, topTracksMedium, topTracksLong,
    recentlyPlayed,
  ] = await Promise.all([
    spotifyGet("/me/top/artists", accessToken, { time_range: "short_term", limit: 20 }),
    spotifyGet("/me/top/artists", accessToken, { time_range: "medium_term", limit: 20 }),
    spotifyGet("/me/top/artists", accessToken, { time_range: "long_term", limit: 20 }),
    spotifyGet("/me/top/tracks", accessToken, { time_range: "short_term", limit: 20 }),
    spotifyGet("/me/top/tracks", accessToken, { time_range: "medium_term", limit: 20 }),
    spotifyGet("/me/top/tracks", accessToken, { time_range: "long_term", limit: 20 }),
    spotifyGet("/me/player/recently-played", accessToken, { limit: 50 }),
  ]);

  // Dedupe artists, tagging by time range
  const artistMap = new Map();
  const addArtist = (a, source) => {
    if (artistMap.has(a.name)) {
      artistMap.get(a.name).sources.push(source);
    } else {
      artistMap.set(a.name, { name: a.name, genres: a.genres || [], sources: [source] });
    }
  };
  topArtistsShort.items?.forEach((a) => addArtist(a, "short_term"));
  topArtistsMedium.items?.forEach((a) => addArtist(a, "medium_term"));
  topArtistsLong.items?.forEach((a) => addArtist(a, "long_term"));

  // Dedupe tracks, tagging by time range + capturing release date
  const trackMap = new Map();
  const addTrack = (t, source) => {
    const key = `${t.artists?.[0]?.name} - ${t.name}`;
    if (trackMap.has(key)) {
      trackMap.get(key).sources.push(source);
    } else {
      trackMap.set(key, {
        name: t.name,
        artist: t.artists?.[0]?.name,
        album: t.album?.name,
        releaseDate: t.album?.release_date || null,
        explicit: t.explicit || false,
        sources: [source],
      });
    }
  };
  topTracksShort.items?.forEach((t) => addTrack(t, "short_term"));
  topTracksMedium.items?.forEach((t) => addTrack(t, "medium_term"));
  topTracksLong.items?.forEach((t) => addTrack(t, "long_term"));

  // Recently played — extract unique artists and tracks
  const recentArtists = new Set();
  recentlyPlayed.items?.forEach((item) => {
    const t = item.track;
    addTrack(t, "recent");
    t.artists?.forEach((a) => recentArtists.add(a.name));
  });

  // Identify artists that appear only in long_term (fading interests or algorithmic dropoff)
  const longTermOnly = Array.from(artistMap.values()).filter(
    (a) => a.sources.includes("long_term") && !a.sources.includes("short_term") && !a.sources.includes("medium_term")
  );

  // Identify artists only in short_term (new/trending in their listening)
  const shortTermOnly = Array.from(artistMap.values()).filter(
    (a) => a.sources.includes("short_term") && !a.sources.includes("long_term")
  );

  const profile = {
    topArtists: Array.from(artistMap.values()),
    topTracks: Array.from(trackMap.values()).slice(0, 30),
    recentArtistNames: Array.from(recentArtists).slice(0, 20),
    allGenres: [...new Set(Array.from(artistMap.values()).flatMap((a) => a.genres))],
    longTermOnlyArtists: longTermOnly.map((a) => ({ name: a.name, genres: a.genres })),
    shortTermOnlyArtists: shortTermOnly.map((a) => ({ name: a.name, genres: a.genres })),
  };

  log(`Found ${profile.topArtists.length} top artists, ${profile.topTracks.length} top tracks`);
  log(`Fading interests (long-term only): ${profile.longTermOnlyArtists.length} artists`);
  log(`New interests (short-term only): ${profile.shortTermOnlyArtists.length} artists`);
  log(`Genres: ${profile.allGenres.slice(0, 8).join(", ")}${profile.allGenres.length > 8 ? "..." : ""}`);

  return profile;
}

// ---------------------------------------------------------------------------
// Scan saved library for broader genre picture
// ---------------------------------------------------------------------------

async function scanSavedLibrary(accessToken, tasteProfile) {
  logStep("2/4", "Scanning your saved library for broader taste signals...");

  // Build genre lookup from top artists (the only source that reliably returns genres in Dev Mode)
  const genreLookup = new Map();
  for (const artist of tasteProfile.topArtists) {
    if (artist.genres?.length > 0) {
      genreLookup.set(artist.name.toLowerCase(), artist.genres);
    }
  }

  // Pull saved tracks, saved albums, and followed artists in parallel
  const [savedTracks, savedAlbums, followedArtists] = await Promise.all([
    spotifyGet("/me/tracks", accessToken, { limit: 50, offset: 0 }),
    spotifyGet("/me/albums", accessToken, { limit: 50, offset: 0 }),
    spotifyGet("/me/following", accessToken, { type: "artist", limit: 50 }).catch(() => ({ artists: { items: [] } })),
  ]);

  // --- Followed artists (deliberate interest, not algorithmic) ---
  // Dev Mode strips genres from /artists/{id} and /me/following, so cross-reference with top artists
  const followedArtistList = [];
  for (const artist of followedArtists.artists?.items || []) {
    const genres = genreLookup.get(artist.name.toLowerCase()) || [];
    followedArtistList.push({ name: artist.name, genres });
  }

  // --- Saved albums with release dates and timestamps ---
  const savedAlbumList = [];
  const albumGenreCount = {};
  for (const item of savedAlbums.items || []) {
    const album = item.album;
    if (!album) continue;
    savedAlbumList.push({
      name: album.name,
      artist: album.artists?.[0]?.name,
      releaseDate: album.release_date,
      addedAt: item.added_at,
      albumType: album.album_type,
    });
    for (const genre of album.genres || []) {
      albumGenreCount[genre] = (albumGenreCount[genre] || 0) + 1;
    }
  }
  // If many saved albums, sample from middle and end
  const totalAlbums = savedAlbums.total || 0;
  if (totalAlbums > 100) {
    const extraAlbumBatches = await Promise.all([
      spotifyGet("/me/albums", accessToken, { limit: 50, offset: Math.floor(totalAlbums / 2) }),
      spotifyGet("/me/albums", accessToken, { limit: 50, offset: Math.max(0, totalAlbums - 50) }),
    ]);
    for (const batch of extraAlbumBatches) {
      for (const item of batch.items || []) {
        const album = item.album;
        if (!album) continue;
        savedAlbumList.push({
          name: album.name,
          artist: album.artists?.[0]?.name,
          releaseDate: album.release_date,
          addedAt: item.added_at,
          albumType: album.album_type,
        });
      }
    }
  }

  // --- Saved tracks (existing logic) ---
  const genreCount = {};
  const artistNames = new Set();

  // Add followed artist genres to genre count
  for (const artist of followedArtistList) {
    artistNames.add(artist.name);
    for (const genre of artist.genres) {
      genreCount[genre] = (genreCount[genre] || 0) + 1;
    }
  }

  // Saved/liked tracks — these are the user's equivalent of "loved" tracks
  const totalSaved = savedTracks.total || 0;
  const savedArtistNames = new Set();
  const likedTracksList = [];
  const extractSavedTracks = (items) => {
    for (const item of items) {
      const t = item.track;
      if (!t?.name) continue;
      for (const artist of t.artists || []) {
        if (artist.name) savedArtistNames.add(artist.name);
      }
      likedTracksList.push({
        name: t.name,
        artist: t.artists?.[0]?.name,
        addedAt: item.added_at,
      });
    }
  };
  extractSavedTracks(savedTracks.items || []);

  // If library is large, sample from middle and end too
  if (totalSaved > 100) {
    const extraBatches = await Promise.all([
      spotifyGet("/me/tracks", accessToken, { limit: 50, offset: Math.floor(totalSaved / 2) }),
      spotifyGet("/me/tracks", accessToken, { limit: 50, offset: Math.max(0, totalSaved - 50) }),
    ]);
    for (const batch of extraBatches) {
      extractSavedTracks(batch.items || []);
    }
  }

  // Merge artist names from all sources
  for (const name of savedArtistNames) artistNames.add(name);

  // Merge album genres into main genre count
  for (const [genre, count] of Object.entries(albumGenreCount)) {
    genreCount[genre] = (genreCount[genre] || 0) + count;
  }

  const sortedGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]);

  // Extract decade distribution from saved albums
  const decadeCounts = {};
  for (const album of savedAlbumList) {
    if (album.releaseDate) {
      const year = parseInt(album.releaseDate.slice(0, 4));
      if (year) {
        const decade = `${Math.floor(year / 10) * 10}s`;
        decadeCounts[decade] = (decadeCounts[decade] || 0) + 1;
      }
    }
  }

  if (sortedGenres.length === 0 && artistNames.size === 0) {
    log("No library data found, skipping library scan");
    return null;
  }

  log(`Found ${followedArtistList.length} followed artists, ${savedAlbumList.length} saved albums, ${savedArtistNames.size} saved track artists`);
  log(`Library genres: ${sortedGenres.slice(0, 8).map(([g]) => g).join(", ")}${sortedGenres.length > 8 ? "..." : ""}`);
  if (Object.keys(decadeCounts).length > 0) {
    log(`Decade spread: ${Object.entries(decadeCounts).sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => `${d}: ${c}`).join(", ")}`);
  }

  return {
    libraryGenres: Object.fromEntries(sortedGenres),
    libraryArtists: Array.from(artistNames),
    followedArtists: followedArtistList,
    savedAlbums: savedAlbumList,
    likedTracks: likedTracksList,
    decadeCounts,
    totalSampled: followedArtistList.length + savedAlbumList.length + savedArtistNames.size,
  };
}

// ---------------------------------------------------------------------------
// (getRecommendations removed — findCandidates generates candidates purely from data)

// ---------------------------------------------------------------------------
// Anti-clustering: spread same-artist/album/seed tracks apart
// ---------------------------------------------------------------------------

function antiCluster(tracks) {
  if (tracks.length <= 2) return tracks;

  const WINDOW = 5; // Check last N tracks for clustering, not just the previous one
  const remaining = [...tracks];
  const result = [];

  result.push(remaining.shift());

  while (remaining.length > 0) {
    // Gather attributes from the last WINDOW tracks
    const window = result.slice(-WINDOW);
    const windowArtists = new Set(window.map((t) => resolveArtistAlias(t.artist?.toLowerCase())));
    const windowAlbums = new Set(window.map((t) => t.album?.toLowerCase()).filter(Boolean));
    const windowSeeds = new Set(window.map((t) => t.similarTo).filter(Boolean));
    const lastDecade = window[window.length - 1]?.year ? Math.floor(window[window.length - 1].year / 10) * 10 : null;

    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i];
      const tArtist = resolveArtistAlias(t.artist?.toLowerCase());
      const tAlbum = t.album?.toLowerCase();
      const tDecade = t.year ? Math.floor(t.year / 10) * 10 : null;
      let score = 0;

      // Heavy penalty if this artist appeared anywhere in the window
      if (!windowArtists.has(tArtist)) score += 15;
      // Penalty if this album appeared in the window
      if (!tAlbum || !windowAlbums.has(tAlbum)) score += 10;
      // Penalty if this seed appeared in the window
      if (!t.similarTo || !windowSeeds.has(t.similarTo)) score += 10;

      // Soft bonus for different decade from the immediately previous track
      if (tDecade && lastDecade && tDecade !== lastDecade) score += 3;

      // Small bonus to preserve some of Claude's ordering
      score += Math.min(i * 0.1, 2);

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    result.push(remaining.splice(bestIdx, 1)[0]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Curate and sequence the playlist
// ---------------------------------------------------------------------------

async function curatePlaylist(resolvedTracks, claudeApiKey, targetCount, runHistory) {
  logStep("3b/4", `Curating ${targetCount} tracks from ${resolvedTracks.length} candidates into a cohesive playlist...`);

  const feedbackSection = buildFeedbackSection(runHistory);
  if (feedbackSection) log("Injecting feedback from previous run into curation prompt");

  const RECENT_SOURCES = new Set(["recent", "top-short", "top-medium", "favourite"]);
  const trackList = resolvedTracks.map((t, i) => {
    const matchPct = t.matchScore != null ? `${(t.matchScore * 100).toFixed(0)}%` : "?";
    const genres = t.genres?.length > 0 ? ` | genre: ${t.genres.join(", ")}` : "";
    const vibe = RECENT_SOURCES.has(t.seedSource) ? "recent" : "library";
    const pop = t.popularity != null ? ` | popularity: ${t.popularity}` : "";
    return `${i + 1}. ${t.artist} — ${t.name} | album: ${t.album || "?"} (${t.year || "?"}) | match: ${matchPct} | seed: ${t.similarTo || t.seedInfo || "?"} | vibe: ${vibe}${pop}${genres}`;
  }).join("\n");

  const dt = MODE.decadeTargets;
  const decadeLine = Object.entries(dt)
    .filter(([, pct]) => pct > 0)
    .map(([d, pct]) => `${Math.round(targetCount * pct)} from the ${d}`)
    .join(", ");

  const genreRuleLine = MODE.genreAllowlist
    ? `GENRE: Every candidate has already been filtered to heavy music (DnB, metal, industrial, hardcore, etc.). Keep it that way — the playlist should hit hard throughout. Prefer variety within heavy music (e.g. don't stack 15 thrash metal tracks — mix in DnB, industrial, hardcore). No single sub-genre should exceed ~30%.`
    : `GENRE BALANCE: No single genre should exceed ~25% of the final playlist (~${Math.round(targetCount * 0.25)} tracks). If you see 15 hip-hop candidates, you must cut most of them. Same for any genre that dominates. The playlist should feel like ${MODE.tagline}.`;

  const prompt = `You are a playlist curator. You have ${resolvedTracks.length} candidate tracks. You MUST select EXACTLY ${targetCount} of them — no more, no less. You are CUTTING ${resolvedTracks.length - targetCount} tracks. Arrange the selected ${targetCount} in an order that flows well.

MODE: ${mode} — ${MODE.tagline}

CANDIDATE TRACKS:
${trackList}

TASK: Select EXACTLY ${targetCount} tracks. You MUST cut ${resolvedTracks.length - targetCount} tracks. Return exactly ${targetCount} track numbers.

WHAT TO CUT:
- ${genreRuleLine}
- DECADE BALANCE: Target approximately: ${decadeLine}. This is important — respect the per-mode decade weighting.
- Tracks with match scores below 10% UNLESS they're genuinely adventurous or unexpected picks. A 5% deep cut from an interesting artist is worth keeping. A 0% classic rock radio staple everyone already knows is not.
- If an artist appears 3+ times, cut down to the best 2
- If multiple tracks share the same seed source, keep the strongest 1-2 and cut the rest
- Between two tracks that serve the same mood/energy/genre role, cut the weaker one
- VIBE PRIORITY: When choosing between two tracks of similar quality, prefer candidates marked "vibe: recent" — these trace back to the user's current listening and capture their current mood. Aim for ~60% of the final playlist to come from recent-listening seeds
- NOVELTY PRIORITY: This is a DISCOVERY playlist — the user wants to find tracks they've NEVER heard before. Tracks with Spotify popularity > 70 are likely already known to the user. Strongly prefer tracks with popularity 20-60 — these are quality tracks the user hasn't encountered. Only keep high-popularity tracks (>70) if they're genuinely from an obscure or unexpected artist. When in doubt, cut the familiar-sounding track and keep the surprising one

HOW TO ORDER THE ${targetCount} YOU KEEP:
- ANTI-CLUSTERING: NEVER place two tracks from the same artist, album, or seed next to each other. If you have 2 tracks from Artist X, place them at least 10 positions apart. Same for tracks from the same genre — don't put 3 hip-hop tracks in a row.
- Flow naturally — think energy, mood, tempo, genre transitions between adjacent tracks
- Create an arc: inviting opener, builds, shifts genre/mood a few times, satisfying closer
- Alternate decades — interleave older and newer tracks throughout

Respond with a JSON object containing a single key "tracks" whose value is an array of exactly ${targetCount} track numbers (1-indexed). Do NOT include any reasoning, just the JSON.

Example: {"tracks": [14, 3, 27, 8, 41, ...]}${feedbackSection}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Curation API failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";

  // Extract the JSON array from Claude's response
  const arrayMatch = text.match(/\[\s*(?:\d+\s*,\s*)*\d+\s*\]/);
  if (!arrayMatch) {
    throw new Error(`Curation returned no track list. Response: ${text.slice(0, 300)}`);
  }

  const order = JSON.parse(arrayMatch[0]);
  if (order.length === 0) {
    throw new Error("Curation returned empty track list");
  }

  // Map the ordered indices back to resolved tracks (1-indexed → 0-indexed)
  const curated = [];
  for (const idx of order) {
    if (curated.length >= targetCount) break;
    const track = resolvedTracks[idx - 1];
    if (track && !curated.includes(track)) {
      curated.push(track);
    }
  }

  const result = antiCluster(curated);
  log(`Curated ${result.length} tracks into sequenced playlist`);
  return result;
}

// (resolveTracksOnSpotify removed — candidates come with Spotify URIs from tracklists.json)

// ---------------------------------------------------------------------------
// Create / update playlist
// ---------------------------------------------------------------------------

async function refreshPlaylist(resolvedTracks, accessToken) {
  logStep("4/4", `Updating ${PLAYLIST_NAME} playlist...`);

  // Get current user
  const me = await spotifyGet("/me", accessToken);
  const userId = me.id;

  // Find existing playlist — case/whitespace insensitive match against any
  // playlist the user owns. If the name is close-but-not-exact, log it so the
  // user can see what went wrong.
  const targetName = PLAYLIST_NAME.trim().toLowerCase();
  let playlistId = null;
  let offset = 0;
  const limit = 50;
  const ownedNames = [];

  while (true) {
    const playlists = await spotifyGet("/me/playlists", accessToken, { limit, offset });
    for (const p of playlists.items || []) {
      if (p.owner?.id !== userId) continue;
      ownedNames.push(p.name);
      if (p.name.trim().toLowerCase() === targetName) {
        playlistId = p.id;
        if (p.name !== PLAYLIST_NAME) log(`Matched existing playlist with different casing: "${p.name}"`);
        break;
      }
    }
    if (playlistId) break;
    if (!playlists.items || playlists.items.length < limit) break;
    offset += limit;
  }

  if (!playlistId) {
    const close = ownedNames.filter((n) => n.toLowerCase().includes("discovery") || n.toLowerCase().includes("heavy") || n.toLowerCase().includes("chill"));
    if (close.length > 0) {
      log(`Did not find "${PLAYLIST_NAME}". Similar playlists you own: ${close.map((n) => `"${n}"`).join(", ")}`);
    } else {
      log(`Did not find "${PLAYLIST_NAME}" among ${ownedNames.length} owned playlists. Will try to create.`);
    }
  }

  // Create if doesn't exist
  if (!playlistId) {
    log("Creating new playlist...");
    const created = await spotifyPost(`/users/${userId}/playlists`, accessToken, {
      name: PLAYLIST_NAME,
      description: `${MODE.description} Last updated: ${new Date().toLocaleDateString()}.`,
      public: false,
    });
    playlistId = created.id;
    log(`Created playlist: ${PLAYLIST_NAME}`);
  }

  // Replace all tracks in one call via PUT /playlists/{id}/items
  const uris = resolvedTracks.map((t) => t.uri);
  log(`Writing ${uris.length} tracks to playlist ${playlistId}...`);
  log(`First 3 URIs: ${uris.slice(0, 3).join(", ")}`);
  const putResult = await spotifyPut(`/playlists/${playlistId}/items`, accessToken, { uris });
  log(`PUT result: ${JSON.stringify(putResult)}`);

  return { playlistId, userId };
}

// ---------------------------------------------------------------------------
// Run history — feedback loop inspired by karpathy/autoresearch
// ---------------------------------------------------------------------------

const RUN_HISTORY_PATH = join(CONFIG_DIR, "run-history.json");

async function loadRunHistory() {
  return (await loadJson(RUN_HISTORY_PATH)) || { runs: [] };
}

async function saveRunHistory(history) {
  await saveJson(RUN_HISTORY_PATH, history);
}

function analyzePlaylist(curatedTracks, candidateCount, seeds) {
  const seedCount = seeds.length;
  const decades = {};
  const genres = {};
  const artistCounts = new Map();
  let totalMatchScore = 0;
  let matchCount = 0;

  for (const t of curatedTracks) {
    // Decade distribution
    if (t.year) {
      const decade = `${Math.floor(t.year / 10) * 10}s`;
      decades[decade] = (decades[decade] || 0) + 1;
    }

    // Artist counts (using alias resolution)
    const canonical = resolveArtistAlias(t.artist?.toLowerCase());
    artistCounts.set(canonical, (artistCounts.get(canonical) || 0) + 1);

    // Genre distribution
    if (t.genres) {
      for (const g of t.genres) {
        genres[g] = (genres[g] || 0) + 1;
      }
    }

    // Match score
    if (t.matchScore != null) {
      totalMatchScore += t.matchScore;
      matchCount++;
    }
  }

  // Find artist repeat violations (>2 tracks from same canonical artist)
  const artistViolations = [];
  for (const [artist, count] of artistCounts) {
    if (count > 2) artistViolations.push(`${artist} (${count})`);
  }

  // Find clustering issues — same artist within 5 positions
  const clusterIssues = [];
  for (let i = 0; i < curatedTracks.length; i++) {
    const a = resolveArtistAlias(curatedTracks[i].artist?.toLowerCase());
    for (let j = i + 1; j < Math.min(i + 5, curatedTracks.length); j++) {
      const b = resolveArtistAlias(curatedTracks[j].artist?.toLowerCase());
      if (a === b) {
        clusterIssues.push(`${curatedTracks[i].artist} at positions ${i + 1} and ${j + 1}`);
      }
    }
  }

  // Decade targets derived from mode config (in tracks, not percent)
  const total = curatedTracks.length;
  const decadeTargets = {};
  for (const [d, pct] of Object.entries(MODE.decadeTargets)) {
    decadeTargets[d] = Math.round(total * pct);
  }
  const decadeDeviations = {};
  for (const [decade, target] of Object.entries(decadeTargets)) {
    const actual = decades[decade] || 0;
    if (Math.abs(actual - target) > 2) {
      decadeDeviations[decade] = { actual, target, diff: actual - target };
    }
  }

  // Genre concentration
  const genreOverload = {};
  for (const [genre, count] of Object.entries(genres)) {
    const pct = count / total;
    if (pct > 0.25) genreOverload[genre] = `${(pct * 100).toFixed(0)}%`;
  }

  return {
    decadeDistribution: decades,
    genreDistribution: genres,
    artistRepeatViolations: artistViolations,
    clusterIssues,
    decadeDeviations,
    genreOverload,
    avgMatchScore: matchCount > 0 ? totalMatchScore / matchCount : 0,
    seedCount,
    candidateCount,
    finalCount: curatedTracks.length,
    seedSplit: {
      history: seeds.filter((s) => s.source !== "all-time-album").length,
      albums: seeds.filter((s) => s.source === "all-time-album").length,
      albumPct: seeds.length > 0
        ? seeds.filter((s) => s.source === "all-time-album").length / seeds.length
        : 0,
    },
    // Feed this back — future runs will read it to adjust the split
    recommendedAlbumSeedPct: 0.30,
  };
}

function buildFeedbackSection(history) {
  // Only pull previous-run feedback from the same mode — mixing chill/hard
  // analysis would produce misleading guidance.
  const modeRuns = history.runs.filter((r) => (r.mode || "chill") === mode);
  if (modeRuns.length === 0) return "";

  const lastRun = modeRuns[modeRuns.length - 1];
  const analysis = lastRun.analysis;
  if (!analysis) return "";

  const issues = [];

  if (analysis.artistRepeatViolations?.length > 0) {
    issues.push(`- Last run had artist over-representation: ${analysis.artistRepeatViolations.join(", ")}`);
  }
  if (analysis.clusterIssues?.length > 0) {
    issues.push(`- Last run had artist clustering: ${analysis.clusterIssues.slice(0, 3).join("; ")}`);
  }
  if (Object.keys(analysis.decadeDeviations || {}).length > 0) {
    const devs = Object.entries(analysis.decadeDeviations)
      .map(([d, v]) => `${d}=${v.actual} (target ${v.target})`)
      .join(", ");
    issues.push(`- Decade distribution was skewed: ${devs}`);
  }
  if (Object.keys(analysis.genreOverload || {}).length > 0) {
    const overloads = Object.entries(analysis.genreOverload)
      .map(([g, pct]) => `"${g}" at ${pct}`)
      .join(", ");
    issues.push(`- Genre concentration exceeded 25%: ${overloads}`);
  }

  // Always include seed split info if available
  if (analysis.seedSplit) {
    const { history, albums, albumPct } = analysis.seedSplit;
    issues.push(`- Seed split: ${history} from listening history, ${albums} from all-time albums (${(albumPct * 100).toFixed(0)}% albums). Target is ~30% albums.`);
  }

  if (issues.length === 0) return "";

  return `\n\nPREVIOUS RUN ISSUES (from automated analysis of ${lastRun.date} run):
${issues.join("\n")}

Prioritize fixing these patterns in your selection and ordering.`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🎵 Spotify Discovery Engine [mode: ${mode}]\n`);

  try {
    // 0. Setup
    const config = await getConfig();
    const claudeApiKey = await getClaudeApiKey();
    const tokens = await getSpotifyTokens(config);

    // 0b. Apply --like / --skip / --unrate flags against the last run, if any
    const runHistoryEarly = await loadRunHistory();
    await applyRatingFlags(runHistoryEarly);

    // 0c. Load disk caches (artist tags + similar artists)
    await Promise.all([loadArtistTagCache(), loadArtistSimilarCache(), loadArtistTopTracksCache(), loadTrackUriCache()]);

    // 1. Find seeds: recent listening that matches your album collection
    const tracklists = await loadTracklists();
    if (Object.keys(tracklists).length === 0) {
      console.error(`\nNo tracklist data found for mode '${mode}'. Check ${MODE.albumsFile} and run 'node fetch-tracklists.mjs'.`);
      process.exit(1);
    }

    const feedback = await loadFeedback();
    if (feedback.liked.length > 0 || feedback.skipped.length > 0) {
      log(`Feedback loaded: ${feedback.liked.length} liked, ${feedback.skipped.length} skipped`);
    }

    const [lastfmData, recentlyPlayed, bucketInfo] = await Promise.all([
      fetchLastfmUserData(),
      getRecentlyPlayed(tokens.access_token),
      buildBucketAffinity(),
    ]);

    if (bucketInfo.totalScrobbles === 0) {
      log("No scrobbles.json found — bucket affinity disabled. Run 'node fetch-scrobbles.mjs' to enable.");
    } else {
      log(`Bucket: ${bucketInfo.currentBucket} (${bucketInfo.totalInBucket}/${bucketInfo.totalScrobbles} scrobbles in this bucket)`);
    }

    // Hold off refreshing until the last playlist has actually been worked
    // through. Exits 0, not 1 — a deliberate skip is not a failure, and a
    // scheduled run should not report red for it.
    if (minConsumed > 0) {
      const used = await lastRunConsumption(await loadRunHistory());
      if (used && used.ageDays >= maxAgeDays) {
        log(`Last playlist is ${used.ageDays.toFixed(1)} days old (>= ${maxAgeDays}) — refreshing regardless of ${(used.pct * 100).toFixed(0)}% consumed`);
      } else if (used && used.pct < minConsumed) {
        console.log(
          `\nSkipping refresh: ${(used.pct * 100).toFixed(0)}% of the last ${PLAYLIST_NAME} ` +
          `playlist consumed (${used.consumed}/${used.total}), below the ${(minConsumed * 100).toFixed(0)}% threshold.`
        );
        console.log(`  ${used.played} played, ${used.skipped} skipped, reached position ${used.reached} of ${used.total} (run of ${used.runDate}).`);
        console.log(`  Run without --min-consumed to refresh anyway.\n`);
        process.exit(0);
      }
      if (used) {
        log(`Last playlist ${(used.pct * 100).toFixed(0)}% consumed (${used.consumed}/${used.total}) — refreshing`);
      } else {
        log(`No consumption data for ${mode} yet — refreshing`);
      }
    }


    const seeds = await findSeeds(tokens.access_token, tracklists, lastfmData, feedback, bucketInfo);

    if (seeds.length === 0) {
      console.error(`\nNo seeds found for mode '${mode}'.`);
      if (mode === "hard") {
        console.error(`Create ${MODE.seedFile} with some heavy-music tracks, or listen to heavy tracks from your album collection.`);
      } else {
        console.error("Try listening to some tracks from your my-albums.json albums, then run again.");
      }
      process.exit(1);
    }

    // 2-3. Find candidates via Last.fm similarity → resolve on Spotify
    // Hard mode needs a larger raw pool because the genre filter is strict — use 6× target
    // so track.getSimilar processes all seeds rather than stopping early.
    const rawTarget = MODE.genreAllowlist ? Math.round(trackCount * 6) : Math.round(trackCount * 1.4);
    const candidateTracks = await findCandidates(seeds, recentlyPlayed, tokens.access_token, rawTarget, excludeRuns, feedback, lastfmData);

    log(`${candidateTracks.length} candidates ready for curation`);

    // 4. Load run history for feedback loop (fresh, after flag mutations)
    const runHistory = await loadRunHistory();

    // 5. Claude curates and sequences the final playlist
    const curatedTracks = await curatePlaylist(candidateTracks, claudeApiKey, trackCount, runHistory);

    // 6. Update playlist
    const { playlistId } = await refreshPlaylist(curatedTracks, tokens.access_token);

    // 7. Analyze and log this run
    const analysis = analyzePlaylist(curatedTracks, candidateTracks.length, seeds);
    runHistory.runs.push({
      id: new Date().toISOString(),
      date: new Date().toISOString().slice(0, 10),
      mode,
      analysis,
      tracks: curatedTracks.map((t) => ({
        artist: t.artist,
        track: t.name,
        album: t.album,
        year: t.year,
        seed: t.similarTo,
        matchScore: t.matchScore,
        // Recorded so run history can rebuild the URI cache if it is ever lost.
        uri: t.uri,
        popularity: t.popularity ?? null,
      })),
    });
    // Keep last 20 runs
    if (runHistory.runs.length > 20) runHistory.runs = runHistory.runs.slice(-20);
    await saveRunHistory(runHistory);
    log("Run logged to ~/.spotify-discover/run-history.json");

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║                    Playlist Updated                     ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
    console.log(`  Playlist:  ${PLAYLIST_NAME}`);
    console.log(`  Tracks:    ${curatedTracks.length} (curated from ${candidateTracks.length} candidates)`);
    console.log(`  Open:      https://open.spotify.com/playlist/${playlistId}\n`);

    // Count unique albums and decade spread
    const uniqueAlbums = new Set(curatedTracks.map((t) => t.album).filter(Boolean));
    const decades = {};
    for (const t of curatedTracks) {
      if (t.year) {
        const decade = `${Math.floor(t.year / 10) * 10}s`;
        decades[decade] = (decades[decade] || 0) + 1;
      }
    }
    if (uniqueAlbums.size > 0) console.log(`  Albums:    ${uniqueAlbums.size} different albums`);
    if (Object.keys(decades).length > 0) {
      const decadeStr = Object.entries(decades).sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => `${d}: ${c}`).join(", ");
      console.log(`  Decades:   ${decadeStr}`);
    }
    console.log("");

    console.log("  What's in there:\n");
    curatedTracks.forEach((t, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${t.artist} — ${t.name}`);
      if (t.album) {
        console.log(`      From: ${t.album} (${t.year || "?"})`);
      }
      console.log(`      ${t.why}`);
    });

    console.log("");
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (err.message.includes("401") || err.message.includes("expired")) {
      console.log("Try: node discover.mjs --auth");
    }
    process.exit(1);
  }
}

main();
