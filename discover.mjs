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
 *   node discover.mjs              # Run discovery (creates/refreshes playlist)
 *   node discover.mjs --auth       # Force re-authentication
 *   node discover.mjs --count 30   # Number of tracks (default: 25)
 *   node discover.mjs --diversity high  # low | medium | high (default: high)
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
const PLAYLIST_NAME = "Discovery Engine";
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

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
const trackCount = parseInt(args[args.indexOf("--count") + 1]) || 50;
const diversity = args[args.indexOf("--diversity") + 1] || "high";

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

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  return res.json();
}

async function fetchLastfmUserData() {
  if (!LASTFM_API_KEY) {
    log("No Last.fm API key, skipping user listening data");
    return null;
  }

  log(`Fetching Last.fm data for user: ${LASTFM_USER}`);

  const [topArtists, topTracks] = await Promise.all([
    lastfmGet("user.getTopArtists", { user: LASTFM_USER, period: "overall", limit: 30 }),
    lastfmGet("user.getTopTracks", { user: LASTFM_USER, period: "overall", limit: 30 }),
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
  try {
    const data = JSON.parse(await readFile(tracklistsPath, "utf8"));
    return data.albums || {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Find candidates: last.fm similar tracks → cross-reference with tracklists
// ---------------------------------------------------------------------------

async function findCandidates(lastfmData, tasteProfile, libraryData, tracklists, claudeApiKey, targetCount = 60) {
  if (!LASTFM_API_KEY) {
    throw new Error("Last.fm API key required. Set LASTFM_API_KEY in your .env file.");
  }

  logStep("3/4", `Finding ~${targetCount} candidate tracks via Last.fm similarity...`);

  // Build a lookup: "artist - track" (lowercase) → { album info, spotify uri }
  const tracklistLookup = new Map();
  for (const [albumKey, albumData] of Object.entries(tracklists)) {
    if (!albumData.tracks?.length) continue;
    for (const track of albumData.tracks) {
      const key = `${track.artist} - ${track.name}`.toLowerCase();
      tracklistLookup.set(key, {
        artist: track.artist,
        track: track.name,
        album: albumData.spotifyName || albumData.source?.album,
        year: albumData.source?.year,
        rank: albumData.source?.rank,
        uri: track.uri,
        albumKey,
      });
    }
  }

  log(`Built lookup of ${tracklistLookup.size} tracks across ${Object.keys(tracklists).length} albums`);

  // Normalize track/album names for fuzzy matching — strips remaster tags, edition info, etc.
  const normalizeTrack = (str) => str.toLowerCase()
    .replace(/\s*[-–—]\s*(remaster(ed)?|deluxe|expanded|anniversary|bonus|mono|stereo|single version|album version|radio edit|explicit|clean).*$/i, "")
    .replace(/\s*\((remaster(ed)?|deluxe|expanded|\d+th anniversary|bonus|mono|stereo|single version|album version|radio edit|explicit|clean)[^)]*\)/gi, "")
    .replace(/\s*\[(remaster(ed)?|deluxe|expanded|\d+th anniversary|bonus|mono|stereo)[^\]]*\]/gi, "")
    .replace(/\s*[-–—]\s*\d{4}\s*(remaster(ed)?|version|mix)$/i, "")
    .trim();

  const trackKey = (artist, name) => `${normalizeTrack(artist)} - ${normalizeTrack(name)}`;

  // Build set of tracks user already knows (to exclude)
  const knownTracks = new Set();

  // Individual known tracks from Spotify top tracks, liked tracks, last.fm
  for (const t of tasteProfile.topTracks || []) {
    if (t.artist && t.name) knownTracks.add(trackKey(t.artist, t.name));
  }
  if (libraryData?.likedTracks) {
    for (const t of libraryData.likedTracks) {
      if (t.artist && t.name) knownTracks.add(trackKey(t.artist, t.name));
    }
  }
  if (lastfmData?.tracks) {
    for (const t of lastfmData.tracks) {
      if (t.artist && t.name) knownTracks.add(trackKey(t.artist, t.name));
    }
  }

  // Also exclude ALL tracks from albums the user has saved — if they saved the album, they know it
  const savedAlbumKeys = new Set();
  if (libraryData?.savedAlbums) {
    for (const a of libraryData.savedAlbums) {
      if (a.artist && a.name) savedAlbumKeys.add(`${a.artist} - ${a.name}`.toLowerCase());
    }
  }
  // Cross-reference saved albums against tracklists to exclude every track
  for (const [albumKey, albumData] of Object.entries(tracklists)) {
    const spotifyKey = albumData.spotifyArtist && albumData.spotifyName
      ? `${albumData.spotifyArtist} - ${albumData.spotifyName}`.toLowerCase()
      : null;
    if (savedAlbumKeys.has(albumKey) || (spotifyKey && savedAlbumKeys.has(spotifyKey))) {
      for (const t of albumData.tracks || []) {
        knownTracks.add(trackKey(t.artist, t.name));
      }
    }
  }

  log(`Excluding ${knownTracks.size} known tracks (${savedAlbumKeys.size} saved albums expanded)`);

  // Gather seed tracks from multiple sources, ordered by signal strength
  const seedTracks = [];
  const addedSeeds = new Set();

  const addSeed = (artist, track, playCount = 0, source = "spotify") => {
    if (!artist || !track) return;
    const key = `${artist} - ${track}`.toLowerCase();
    if (addedSeeds.has(key)) return;
    addedSeeds.add(key);
    seedTracks.push({ artist, track, playCount, source });
  };

  // Last.fm top tracks (strongest signal — actual play counts)
  if (lastfmData?.tracks?.length > 0) {
    for (const t of lastfmData.tracks) {
      addSeed(t.artist, t.name, t.playCount, "lastfm");
    }
  }

  // Spotify top tracks across all time ranges
  for (const t of tasteProfile.topTracks || []) {
    addSeed(t.artist, t.name, 0, "spotify");
  }

  // Liked/saved tracks from library (deliberate interest)
  if (libraryData?.likedTracks) {
    for (const t of libraryData.likedTracks.slice(0, 30)) {
      addSeed(t.artist, t.name, 0, "liked");
    }
  }

  log(`Gathered ${seedTracks.length} seed tracks`);

  // Analyze decade distribution of seeds and balance with exploration seeds
  // Target playlist: ~4 tracks 70s, 10 tracks 80s, 10 tracks 90s, 10 tracks 00s, 10 tracks 10s, 6 tracks 20s
  // Seeds should roughly mirror this ratio to produce balanced candidates
  // Exploration seed targets per decade — higher for decades with no listening history
  // The user's own seeds already cover 2010s/2020s, so these need fewer exploration seeds
  const DECADE_SEED_TARGETS = {
    "1970s": 4, "1980s": 6, "1990s": 5, "2000s": 4, "2010s": 2, "2020s": 3,
  };

  const seedDecades = new Map();
  for (const s of seedTracks) {
    const key = `${s.artist} - ${s.track}`.toLowerCase();
    const info = tracklistLookup.get(key);
    if (info?.year) {
      const decade = `${Math.floor(info.year / 10) * 10}s`;
      seedDecades.set(decade, (seedDecades.get(decade) || 0) + 1);
    }
  }

  const decadeGaps = [];
  for (const [decade, target] of Object.entries(DECADE_SEED_TARGETS)) {
    const current = seedDecades.get(decade) || 0;
    const needed = Math.max(0, target - current);
    if (needed > 0) decadeGaps.push({ decade, needed, current });
  }

  if (decadeGaps.length > 0) {
    log(`Seed decade balance: ${Object.entries(DECADE_SEED_TARGETS).map(([d]) => `${d}: ${seedDecades.get(d) || 0}`).join(", ")}`);
    log(`Adding exploration seeds for: ${decadeGaps.map((g) => `${g.decade} (+${g.needed})`).join(", ")}`);

    // Collect candidate albums for exploration, one per year per decade
    const explorationAlbums = [];
    for (const { decade, needed } of decadeGaps) {
      const decadeStart = parseInt(decade);
      const decadeEnd = decadeStart + 9;

      const decadeAlbums = [];
      for (const [albumKey, albumData] of Object.entries(tracklists)) {
        const year = albumData.source?.year;
        const rank = albumData.source?.rank;
        if (year >= decadeStart && year <= decadeEnd && rank && albumData.tracks?.length > 0) {
          decadeAlbums.push({ albumKey, albumData, year, rank });
        }
      }
      decadeAlbums.sort((a, b) => a.rank - b.rank || a.year - b.year);

      const usedYears = new Set();
      let added = 0;
      for (const da of decadeAlbums) {
        if (added >= needed) break;
        if (usedYears.has(da.year)) continue;
        usedYears.add(da.year);
        explorationAlbums.push(da);
        added++;
      }
      // Fill remaining from top-ranked if needed
      for (const da of decadeAlbums) {
        if (added >= needed) break;
        if (!explorationAlbums.includes(da)) {
          explorationAlbums.push(da);
          added++;
        }
      }
    }

    // Ask Claude to pick the best seed track from each exploration album (single batch call)
    const albumListForClaude = explorationAlbums.map((da, i) => {
      const tracks = da.albumData.tracks.map((t, j) => `  ${j + 1}. ${t.name}`).join("\n");
      return `Album ${i + 1}: ${da.albumData.spotifyArtist || da.albumData.source?.artist} - ${da.albumData.spotifyName || da.albumData.source?.album} (${da.year})\n${tracks}`;
    }).join("\n\n");

    const pickPrompt = `For each album below, pick the ONE track that would work best as a seed for Last.fm's track.getSimilar API. Choose the most iconic, distinctive, or genre-defining track — not an intro, interlude, or deep album cut.

${albumListForClaude}

Respond with ONLY a JSON object. The key "picks" maps to an array of track numbers (1-indexed), one per album in order.
Example: {"picks": [3, 5, 2, 7, ...]}`;

    const pickRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: pickPrompt }],
      }),
    });

    if (!pickRes.ok) {
      throw new Error(`Track pick API failed (${pickRes.status}): ${await pickRes.text()}`);
    }

    const pickData = await pickRes.json();
    const pickText = pickData.content?.[0]?.text || "";
    const pickMatch = pickText.match(/\[\s*(?:\d+\s*,\s*)*\d+\s*\]/);
    if (!pickMatch) {
      throw new Error(`Track pick returned no JSON array. Response: ${pickText.slice(0, 300)}`);
    }
    const picks = JSON.parse(pickMatch[0]);

    for (let i = 0; i < explorationAlbums.length; i++) {
      const da = explorationAlbums[i];
      const trackIdx = (picks[i] || 1) - 1; // Claude's pick (1-indexed) or fallback to track 1
      const tracks = da.albumData.tracks;
      const pick = tracks[Math.min(trackIdx, tracks.length - 1)];
      if (pick && !addedSeeds.has(`${pick.artist} - ${pick.name}`.toLowerCase())) {
        addSeed(pick.artist, pick.name, 0, `explore-${da.year}`);
      }
    }

    log(`Total seeds after exploration: ${seedTracks.length}`);
  }

  // Ask Claude to pick the best 20 diverse seeds from the full list
  const seedListForClaude = seedTracks.map((s, i) =>
    `${i + 1}. ${s.artist} - ${s.track} [${s.source}${s.playCount ? `, ${s.playCount} plays` : ""}]`
  ).join("\n");

  const seedPrompt = `You are selecting seed tracks for a music discovery algorithm. The seeds will be fed into Last.fm's track.getSimilar API to find new music.

Here are all ${seedTracks.length} candidate seeds from the user's listening history:

${seedListForClaude}

TASK: Pick exactly 30 seeds that will produce a decade-balanced playlist.

SELECTION RULES:
- Pick at least 15 seeds from the user's actual listening history (lastfm/spotify/liked sources). These anchor the playlist in their taste and ensure modern decades (2010s/2020s) are represented.
- Pick the remaining ~15 seeds from exploration tracks (tagged [explore-YEAR]) spread across underrepresented decades: 70s, 80s, 90s, 00s
- Don't pick more than 2 tracks from the same artist
- Spread across genres, moods, and energy levels
- Prefer tracks that are distinctive or genre-defining — they'll produce better similarity results

You MUST respond with ONLY a JSON object, no reasoning or explanation. Just the JSON.
{"seeds": [3, 7, 12, 15, ...]}`;

  const seedRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: seedPrompt }],
    }),
  });

  if (!seedRes.ok) {
    const err = await seedRes.text();
    throw new Error(`Seed selection API failed (${seedRes.status}): ${err}`);
  }

  const seedData = await seedRes.json();
  const seedText = seedData.content?.[0]?.text || "";
  const seedArrayMatch = seedText.match(/\[\s*(?:\d+\s*,\s*)*\d+\s*\]/);
  if (!seedArrayMatch) {
    throw new Error(`Seed selection returned no JSON array. Response: ${seedText.slice(0, 300)}`);
  }
  const seedIndices = JSON.parse(seedArrayMatch[0]);
  const selectedSeeds = seedIndices
    .filter((i) => i >= 1 && i <= seedTracks.length)
    .map((i) => seedTracks[i - 1]);

  log(`Claude selected ${selectedSeeds.length} diverse seeds:`);
  for (const s of selectedSeeds) {
    log(`  [${s.source}${s.playCount ? ` ${s.playCount} plays` : ""}] ${s.artist} - ${s.track}`);
  }

  // Process seeds until we have enough candidates
  // Cap at 3 matches per seed to ensure diversity across different taste signals
  const MAX_PER_SEED = 3;
  const matches = [];
  const seenTracks = new Set();
  const seenArtists = new Map(); // artist → count (cap per artist too)
  const MAX_PER_ARTIST = 3;
  let apiCalls = 0;
  let seedIndex = 0;

  while (matches.length < targetCount && seedIndex < selectedSeeds.length) {
    const seed = selectedSeeds[seedIndex];
    seedIndex++;

    // Find which album the seed is from (so we don't recommend more from the same album)
    const seedKey = `${seed.artist} - ${seed.track}`.toLowerCase();
    const seedAlbum = tracklistLookup.get(seedKey)?.album?.toLowerCase() || null;

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
        if (seedMatches >= MAX_PER_SEED) break;

        const simArtist = sim.artist?.name || "";
        const simTrack = sim.name || "";
        const key = `${simArtist} - ${simTrack}`.toLowerCase();
        const normalizedKey = trackKey(simArtist, simTrack);
        const artistLower = simArtist.toLowerCase();

        // Skip if already found, user already knows it, or artist is over-represented
        if (seenTracks.has(key) || knownTracks.has(normalizedKey)) continue;
        if ((seenArtists.get(artistLower) || 0) >= MAX_PER_ARTIST) continue;

        // Check if this track exists in our best-album tracklists
        if (tracklistLookup.has(key)) {
          // Skip tracks from the same album as the seed — user already knows that album
          const info = tracklistLookup.get(key);
          const matchAlbum = info.album?.toLowerCase();
          if (seedAlbum && matchAlbum === seedAlbum) continue;

          seenTracks.add(key);
          seenArtists.set(artistLower, (seenArtists.get(artistLower) || 0) + 1);
          matches.push({
            artist: info.artist,
            track: info.track,
            album: info.album,
            year: info.year,
            rank: info.rank,
            uri: info.uri,
            similarTo: `${seed.artist} - ${seed.track}`,
            seedPlayCount: seed.playCount,
            matchScore: parseFloat(sim.match) || 0,
          });
          seedMatches++;
        }
      }

      // Progress update every 10 seeds
      if (apiCalls % 10 === 0) {
        log(`  ${matches.length} candidates found after ${apiCalls} lookups (${selectedSeeds.length - seedIndex} seeds remaining)`);
      }

      // Small delay to be nice to the API
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      // Skip failed lookups, don't break the pipeline
    }
  }

  // If Claude's 20 seeds didn't produce enough, fall back to remaining seeds
  if (matches.length < targetCount && selectedSeeds !== seedTracks) {
    const usedSeedKeys = new Set(selectedSeeds.map((s) => `${s.artist} - ${s.track}`.toLowerCase()));
    const remainingSeeds = seedTracks.filter((s) => !usedSeedKeys.has(`${s.artist} - ${s.track}`.toLowerCase()));
    log(`  Only ${matches.length} candidates from curated seeds, trying ${remainingSeeds.length} remaining seeds...`);

    let remIndex = 0;
    while (matches.length < targetCount && remIndex < remainingSeeds.length) {
      const seed = remainingSeeds[remIndex];
      remIndex++;

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
          if (seedMatches >= MAX_PER_SEED) break;
          const simArtist = sim.artist?.name || "";
          const simTrack = sim.name || "";
          const key = `${simArtist} - ${simTrack}`.toLowerCase();
          const normalizedKey = trackKey(simArtist, simTrack);
          const artistLower = simArtist.toLowerCase();

          if (seenTracks.has(key) || knownTracks.has(normalizedKey)) continue;
          if ((seenArtists.get(artistLower) || 0) >= MAX_PER_ARTIST) continue;

          if (tracklistLookup.has(key)) {
            seenTracks.add(key);
            seenArtists.set(artistLower, (seenArtists.get(artistLower) || 0) + 1);
            const info = tracklistLookup.get(key);
            matches.push({
              artist: info.artist,
              track: info.track,
              album: info.album,
              year: info.year,
              rank: info.rank,
              uri: info.uri,
              similarTo: `${seed.artist} - ${seed.track}`,
              seedPlayCount: seed.playCount,
              matchScore: parseFloat(sim.match) || 0,
            });
            seedMatches++;
          }
        }

        if (apiCalls % 10 === 0) {
          log(`  ${matches.length} candidates found after ${apiCalls} lookups (${remainingSeeds.length - remIndex} fallback seeds remaining)`);
        }

        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        // Skip failed lookups
      }
    }
  }

  // Sort by match score (strongest similarity first)
  matches.sort((a, b) => b.matchScore - a.matchScore);

  log(`Found ${matches.length} candidate tracks from ${apiCalls} Last.fm lookups`);

  if (matches.length === 0) {
    throw new Error("No candidate tracks found. This can happen if tracklists.json is empty — run 'node fetch-tracklists.mjs' first.");
  }

  if (matches.length < targetCount) {
    log(`Note: only found ${matches.length} candidates (target was ${targetCount}). Proceeding with what we have.`);
  }

  return matches;
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
    const retryAfter = Math.min(parseInt(res.headers.get("retry-after") || "2"), 30);
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

  // Constraint-based ordering: build the sequence one track at a time,
  // always picking the track that's most "different" from the last placed track
  const remaining = [...tracks];
  const result = [];

  // Start with the first track
  result.push(remaining.shift());

  while (remaining.length > 0) {
    const last = result[result.length - 1];
    const lastArtist = last.artist?.toLowerCase();
    const lastAlbum = last.album?.toLowerCase();
    const lastSeed = last.similarTo;
    const lastDecade = last.year ? Math.floor(last.year / 10) * 10 : null;

    // Score each remaining track — higher = more different from last placed
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i];
      let score = 0;

      // Hard penalties for same artist/album/seed
      if (t.artist?.toLowerCase() !== lastArtist) score += 10;
      if (!lastAlbum || !t.album || t.album.toLowerCase() !== lastAlbum) score += 10;
      if (!lastSeed || t.similarTo !== lastSeed) score += 10;

      // Soft bonus for different decade
      const tDecade = t.year ? Math.floor(t.year / 10) * 10 : null;
      if (tDecade && lastDecade && tDecade !== lastDecade) score += 3;

      // Small bonus for being further back in the remaining list (preserves some of Claude's ordering)
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

async function curatePlaylist(resolvedTracks, claudeApiKey, targetCount) {
  logStep("3b/4", `Curating ${targetCount} tracks from ${resolvedTracks.length} candidates into a cohesive playlist...`);

  const trackList = resolvedTracks.map((t, i) => {
    const matchPct = t.matchScore != null ? `${(t.matchScore * 100).toFixed(0)}%` : "?";
    const genres = t.genres?.length > 0 ? ` | genre: ${t.genres.join(", ")}` : "";
    return `${i + 1}. ${t.artist} — ${t.name} | album: ${t.album || "?"} (${t.year || "?"}) | match: ${matchPct} | seed: ${t.similarTo || t.seedInfo || "?"}${genres}`;
  }).join("\n");

  const prompt = `You are a playlist curator. You have ${resolvedTracks.length} candidate tracks. You MUST select EXACTLY ${targetCount} of them — no more, no less. You are CUTTING ${resolvedTracks.length - targetCount} tracks. Arrange the selected ${targetCount} in an order that flows well.

CANDIDATE TRACKS:
${trackList}

TASK: Select EXACTLY ${targetCount} tracks. You MUST cut ${resolvedTracks.length - targetCount} tracks. Return exactly ${targetCount} track numbers.

WHAT TO CUT:
- GENRE BALANCE: No single genre should exceed ~25% of the final playlist (~${Math.round(targetCount * 0.25)} tracks). If you see 15 hip-hop candidates, you must cut most of them. Same for any genre that dominates. The playlist should feel like a diverse music collection, not a genre playlist.
- DECADE BALANCE: Target approximately: 4 tracks from the 70s, 10 from the 80s, 10 from the 90s, 10 from the 00s, 10 from the 10s, 6 from the 20s. This is the most important rule — the playlist must span all decades.
- Tracks with match scores below 10% UNLESS they're genuinely adventurous or unexpected picks. A 5% deep cut from an interesting artist is worth keeping. A 0% classic rock radio staple everyone already knows is not.
- If an artist appears 3+ times, cut down to the best 2
- If multiple tracks share the same seed source, keep the strongest 1-2 and cut the rest
- Between two tracks that serve the same mood/energy/genre role, cut the weaker one

HOW TO ORDER THE ${targetCount} YOU KEEP:
- ANTI-CLUSTERING: NEVER place two tracks from the same artist, album, or seed next to each other. If you have 2 tracks from Artist X, place them at least 10 positions apart. Same for tracks from the same genre — don't put 3 hip-hop tracks in a row.
- Flow naturally — think energy, mood, tempo, genre transitions between adjacent tracks
- Create an arc: inviting opener, builds, shifts genre/mood a few times, satisfying closer
- Alternate decades — interleave older and newer tracks throughout

Respond with a JSON object containing a single key "tracks" whose value is an array of exactly ${targetCount} track numbers (1-indexed). Do NOT include any reasoning, just the JSON.

Example: {"tracks": [14, 3, 27, 8, 41, ...]}`;

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
  logStep("4/4", "Updating Discovery Engine playlist...");

  // Get current user
  const me = await spotifyGet("/me", accessToken);
  const userId = me.id;

  // Find existing playlist
  let playlistId = null;
  let offset = 0;
  const limit = 50;

  while (true) {
    const playlists = await spotifyGet("/me/playlists", accessToken, { limit, offset });
    const found = playlists.items?.find(
      (p) => p.name === PLAYLIST_NAME && p.owner?.id === userId
    );
    if (found) {
      playlistId = found.id;
      break;
    }
    if (!playlists.items || playlists.items.length < limit) break;
    offset += limit;
  }

  // Create if doesn't exist
  if (!playlistId) {
    log("Creating new playlist...");
    const created = await spotifyPost(`/users/${userId}/playlists`, accessToken, {
      name: PLAYLIST_NAME,
      description: `Fresh discoveries, curated by AI. Last updated: ${new Date().toLocaleDateString()}. Diversity: ${diversity}.`,
      public: false,
    });
    playlistId = created.id;
    log(`Created playlist: ${PLAYLIST_NAME}`);
  }

  // Replace all tracks in one call via PUT /playlists/{id}/items
  // (this is the only write method that works in Spotify Dev Mode)
  const uris = resolvedTracks.map((t) => t.uri);
  await spotifyPut(`/playlists/${playlistId}/items`, accessToken, { uris });

  return { playlistId, userId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n🎵 Spotify Discovery Engine\n");

  try {
    // 0. Setup
    const config = await getConfig();
    const claudeApiKey = await getClaudeApiKey();
    const tokens = await getSpotifyTokens(config);

    // 1. Gather taste profile, Last.fm play counts, and tracklists in parallel
    const [tasteProfile, lastfmData, tracklists] = await Promise.all([
      gatherTasteProfile(tokens.access_token),
      fetchLastfmUserData(),
      loadTracklists(),
    ]);

    if (Object.keys(tracklists).length === 0) {
      console.error("\nNo tracklist data found. Run 'node fetch-tracklists.mjs' first.");
      process.exit(1);
    }

    // 2. Scan saved library for broader genre picture
    const libraryData = await scanSavedLibrary(tokens.access_token, tasteProfile);

    // 3. Find ~60 candidate tracks via Last.fm similarity, cross-referenced with best-album tracklists
    const candidates = await findCandidates(lastfmData, tasteProfile, libraryData, tracklists, claudeApiKey, Math.round(trackCount * 1.4));

    // Candidates already have Spotify URIs from tracklists — format them for curation
    const candidateTracks = candidates.map((c) => ({
      uri: c.uri,
      name: c.track,
      artist: c.artist,
      album: c.album || null,
      year: c.year || null,
      matchScore: c.matchScore || 0,
      seedInfo: c.similarTo || null,
      why: `Similar to: ${c.similarTo} (match: ${(c.matchScore * 100).toFixed(0)}%)`,
      similarTo: c.similarTo,
    }));

    // Fetch genres from Last.fm for candidate artists
    if (LASTFM_API_KEY) {
      const uniqueArtists = [...new Set(candidateTracks.map((t) => t.artist))];
      log(`Fetching genres for ${uniqueArtists.length} candidate artists...`);
      const genreMap = new Map();
      // Batch in groups of 5 to avoid rate limits
      for (let i = 0; i < uniqueArtists.length; i += 5) {
        const batch = uniqueArtists.slice(i, i + 5);
        const results = await Promise.all(batch.map(async (artist) => {
          try {
            const data = await lastfmGet("artist.getTopTags", { artist, autocorrect: 1 });
            const tags = (data?.toptags?.tag || []).slice(0, 3).map((t) => t.name.toLowerCase());
            return { artist, tags };
          } catch { return { artist, tags: [] }; }
        }));
        for (const { artist, tags } of results) {
          if (tags.length > 0) genreMap.set(artist, tags);
        }
      }
      // Attach genres to candidates
      for (const t of candidateTracks) {
        t.genres = genreMap.get(t.artist) || [];
      }
      log(`Got genres for ${genreMap.size}/${uniqueArtists.length} artists`);
    }

    log(`${candidateTracks.length} candidates ready for curation`);

    // 4. Claude curates and sequences the final playlist
    const curatedTracks = await curatePlaylist(candidateTracks, claudeApiKey, trackCount);

    // 5. Update playlist
    const { playlistId } = await refreshPlaylist(curatedTracks, tokens.access_token);

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║                    Playlist Updated                     ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
    console.log(`  Playlist:  ${PLAYLIST_NAME}`);
    console.log(`  Tracks:    ${curatedTracks.length} (curated from ${candidateTracks.length} candidates)`);
    console.log(`  Diversity: ${diversity}`);
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
