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
const trackCount = parseInt(args[args.indexOf("--count") + 1]) || 35;
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

async function getLastfmTopTracks(tag, limit = 15) {
  const data = await lastfmGet("tag.getTopTracks", { tag, limit });
  return (data?.tracks?.track || []).map((t) => ({
    name: t.name,
    artist: t.artist?.name,
  }));
}

async function fetchLastfmUserData() {
  if (!LASTFM_API_KEY) {
    log("No Last.fm API key, skipping user listening data");
    return null;
  }

  log(`Fetching Last.fm data for user: ${LASTFM_USER}`);

  const [topArtists, topTracks, lovedTracks, recentTracks] = await Promise.all([
    lastfmGet("user.getTopArtists", { user: LASTFM_USER, period: "overall", limit: 30 }),
    lastfmGet("user.getTopTracks", { user: LASTFM_USER, period: "overall", limit: 30 }),
    lastfmGet("user.getLovedTracks", { user: LASTFM_USER, limit: 30 }),
    lastfmGet("user.getRecentTracks", { user: LASTFM_USER, limit: 50 }),
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

  const loved = (lovedTracks?.lovedtracks?.track || []).map((t) => ({
    name: t.name,
    artist: t.artist?.name,
  }));

  const recent = (recentTracks?.recenttracks?.track || []).map((t) => ({
    name: t.name,
    artist: t.artist?.["#text"] || t.artist?.name,
  }));

  const hasData = artists.length > 0 || tracks.length > 0 || loved.length > 0;

  if (!hasData) {
    log("Last.fm account has no scrobble data yet — falling back to Spotify data");
    return null;
  }

  log(`Last.fm: ${artists.length} top artists, ${tracks.length} top tracks, ${loved.length} loved tracks, ${recent.length} recent`);
  return { artists, tracks, loved, recent };
}

async function fetchQualityReferences(genres) {
  if (!LASTFM_API_KEY) {
    log("No Last.fm API key, skipping quality references");
    return null;
  }

  // Pick up to 8 genres to look up
  const genresToQuery = genres.slice(0, 8);
  log(`Fetching Last.fm top tracks for: ${genresToQuery.join(", ")}`);

  const results = {};
  // Fetch in parallel batches of 4
  for (let i = 0; i < genresToQuery.length; i += 4) {
    const batch = genresToQuery.slice(i, i + 4);
    const batchResults = await Promise.all(
      batch.map(async (genre) => {
        const tracks = await getLastfmTopTracks(genre, 15);
        return { genre, tracks };
      })
    );
    for (const { genre, tracks } of batchResults) {
      if (tracks.length > 0) results[genre] = tracks;
    }
  }

  const totalTracks = Object.values(results).reduce((sum, t) => sum + t.length, 0);
  log(`Got ${totalTracks} quality reference tracks across ${Object.keys(results).length} genres`);
  return results;
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

async function spotifyGet(endpoint, accessToken, params = {}) {
  const url = new URL(`https://api.spotify.com/v1${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "2");
    log(`Rate limited, waiting ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return spotifyGet(endpoint, accessToken, params);
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
  logStep("1/6", "Reading your Spotify taste profile...");

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
  logStep("2/6", "Scanning your saved library for broader taste signals...");

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
// Claude gap analysis
// ---------------------------------------------------------------------------

async function analyzeGaps(tasteProfile, libraryData, claudeApiKey, lastfmData) {
  logStep("3/6", "Analyzing taste gaps with Claude...");

  // --- Build rich library section ---
  const libraryParts = [];

  if (libraryData) {
    if (Object.keys(libraryData.libraryGenres).length > 0) {
      libraryParts.push(`SAVED LIBRARY GENRES (broader than recent listening):
${Object.entries(libraryData.libraryGenres).slice(0, 30).map(([g, c]) => `  ${g}: ${c}`).join("\n")}`);
    }

    if (libraryData.libraryArtists?.length > 0) {
      const notInRecent = libraryData.libraryArtists.filter(
        (a) => !tasteProfile.topArtists.some((ta) => ta.name === a) && !tasteProfile.recentArtistNames.includes(a)
      );
      libraryParts.push(`LIBRARY ARTISTS NOT IN RECENT LISTENING: ${notInRecent.slice(0, 25).join(", ")}`);
    }

    if (libraryData.followedArtists?.length > 0) {
      const withGenres = libraryData.followedArtists.filter((a) => a.genres.length > 0);
      const withoutGenres = libraryData.followedArtists.filter((a) => a.genres.length === 0);
      let followedStr = "";
      if (withGenres.length > 0) {
        followedStr += withGenres.slice(0, 30).map((a) => `  ${a.name} (${a.genres.slice(0, 3).join(", ")})`).join("\n");
      }
      if (withoutGenres.length > 0) {
        if (followedStr) followedStr += "\n";
        followedStr += `  ${withoutGenres.slice(0, 30).map((a) => a.name).join(", ")}`;
      }
      libraryParts.push(`DELIBERATELY FOLLOWED ARTISTS (intentional interest, not algorithmic):\n${followedStr}`);
    }

    if (libraryData.likedTracks?.length > 0) {
      libraryParts.push(`LIKED/SAVED TRACKS (user deliberately hearted these — strongest Spotify quality signal):
${libraryData.likedTracks.slice(0, 25).map((t) => `  ${t.artist} - ${t.name}`).join("\n")}`);
    }

    if (libraryData.savedAlbums?.length > 0) {
      libraryParts.push(`SAVED ALBUMS (shows deliberate album-level interest):
${libraryData.savedAlbums.slice(0, 20).map((a) => `  ${a.artist} — ${a.name} (${a.releaseDate || "unknown"})`).join("\n")}`);
    }

    if (libraryData.decadeCounts && Object.keys(libraryData.decadeCounts).length > 0) {
      const decades = Object.entries(libraryData.decadeCounts).sort((a, b) => a[0].localeCompare(b[0]));
      libraryParts.push(`DECADE DISTRIBUTION OF SAVED ALBUMS: ${decades.map(([d, c]) => `${d}: ${c}`).join(", ")}`);
    }

  }

  // --- Build taste trajectory section ---
  const trajectoryParts = [];
  if (tasteProfile.longTermOnlyArtists?.length > 0) {
    trajectoryParts.push(`FADING INTERESTS (in long-term top artists but NOT short-term — possible abandoned tastes):
${tasteProfile.longTermOnlyArtists.slice(0, 10).map((a) => `  ${a.name} (${a.genres.slice(0, 3).join(", ")})`).join("\n")}`);
  }
  if (tasteProfile.shortTermOnlyArtists?.length > 0) {
    trajectoryParts.push(`NEW/TRENDING INTERESTS (in short-term top artists but NOT long-term — recent discoveries):
${tasteProfile.shortTermOnlyArtists.slice(0, 10).map((a) => `  ${a.name} (${a.genres.slice(0, 3).join(", ")})`).join("\n")}`);
  }

  // --- Build Last.fm section ---
  let lastfmSection = "";
  if (lastfmData) {
    const lfmParts = [];
    if (lastfmData.artists.length > 0) {
      lfmParts.push(`LAST.FM TOP ARTISTS (with actual play counts — this is the most reliable taste signal):
${lastfmData.artists.slice(0, 20).map((a) => `  ${a.name}: ${a.playCount} plays`).join("\n")}`);
    }
    if (lastfmData.tracks.length > 0) {
      lfmParts.push(`LAST.FM TOP TRACKS (with play counts):
${lastfmData.tracks.slice(0, 20).map((t) => `  ${t.artist} - ${t.name}: ${t.playCount} plays`).join("\n")}`);
    }
    if (lastfmData.loved.length > 0) {
      lfmParts.push(`LAST.FM LOVED TRACKS (user explicitly marked these as favourites — strongest quality signal):
${lastfmData.loved.slice(0, 20).map((t) => `  ${t.artist} - ${t.name}`).join("\n")}`);
    }
    if (lfmParts.length > 0) {
      lastfmSection = "\n\n" + lfmParts.join("\n\n");
    }
  }

  const librarySection = libraryParts.length > 0 ? "\n" + libraryParts.join("\n\n") : "";
  const trajectorySection = trajectoryParts.length > 0 ? "\n\nTASTE TRAJECTORY:\n" + trajectoryParts.join("\n\n") : "";

  const prompt = `You are analyzing a Spotify user's taste profile to identify gaps between their true tastes and what Spotify's algorithm has been feeding them.

RECENT LISTENING DATA (what Spotify's algorithm shows):
Top artists (with time range): ${tasteProfile.topArtists.map((a) => `${a.name} [${a.sources.join("+")}] (${a.genres.join(", ")})`).join("; ")}

Top tracks: ${tasteProfile.topTracks.map((t) => `${t.artist} - ${t.name} [${t.releaseDate || "?"}] (${t.sources.join("+")})`).join("; ")}

Recently played artists: ${tasteProfile.recentArtistNames.join(", ")}

All genres across profile: ${tasteProfile.allGenres.join(", ")}
${trajectorySection}
${librarySection}
${lastfmSection}

TASK: You are generating interview questions to help personalize music recommendations. Analyze the FULL taste profile above — artists, tracks, play counts, followed artists, saved albums, decade distribution, taste trajectory, and Last.fm data (if available) — to identify:
1. 3-5 specific, interesting gaps or tensions in their listening (e.g. an artist they follow but never play, a decade they save albums from but don't stream, a genre trajectory that shifted, production styles they seem drawn to)
2. Genres or patterns that appear overrepresented in recent listening (possible algorithmic echo chamber)
3. For each gap, write a unique, specific conversational question referencing concrete details from their profile (they'll answer y/n/sometimes)

IMPORTANT:
- Be specific and creative. Don't ask generic questions like "do you still enjoy [genre]?" — instead reference specific tracks, albums, followed artists, eras, production styles, or connections you notice.
- USE THE TASTE TRAJECTORY: if an artist is fading (long-term only) or new (short-term only), that's interesting — ask about it specifically.
- USE FOLLOWED ARTISTS: if they follow someone they don't listen to, that's a signal worth exploring.
- USE DECADE DATA: if their saved albums span the 70s-2020s but they only stream 2020s, ask about that.
- Look at the TRACKS and ARTISTS, not just genre labels. Two users with "rock" in their genres could have wildly different tastes.
- Find unexpected connections — e.g. if someone listens to both ambient electronic and post-rock, ask about the shared atmospheric quality rather than either genre label.

Respond with ONLY valid JSON, no other text:
{
  "gaps": [
    { "area": "genre or style name", "question": "Short question about this area" }
  ],
  "biases": ["One sentence about each detected bias"],
  "summary": "One sentence summary of the profile analysis"
}`;

  console.log("\n--- GAP ANALYSIS PROMPT ---\n");
  console.log(prompt);
  console.log("\n--- END PROMPT ---\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16384,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      log(`Gap analysis failed (${res.status}), continuing without interview...`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const jsonStr = text.replace(/```json\s*|```\s*/g, "").trim();
    const analysis = JSON.parse(jsonStr);

    log(`Identified ${analysis.gaps?.length || 0} taste gaps`);
    return analysis;
  } catch (err) {
    log(`Gap analysis error: ${err.message}, continuing without interview...`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Taste interview
// ---------------------------------------------------------------------------

async function conductTasteInterview(analysis) {
  logStep("4/6", "Quick taste check...");

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  if (analysis?.summary) {
    console.log(`\n  Claude's analysis: ${analysis.summary}\n`);
  }

  if (analysis?.biases?.length) {
    for (const bias of analysis.biases) {
      console.log(`  ⚠ ${bias}`);
    }
    console.log("");
  }

  // Two simple freeform questions — more useful than y/n gap questions
  const feedback = (await ask("  Anything you loved or hated from recent discoveries? (optional): ")).trim() || null;
  const mood = (await ask("  What vibe are you after? (optional, e.g. 'boundary-pushing pop', 'late night driving'): ")).trim() || null;
  console.log("");

  rl.close();

  return {
    feedback,
    mood,
    biases: analysis?.biases || [],
    summary: analysis?.summary || null,
  };
}

// ---------------------------------------------------------------------------
// Claude recommendation engine
// ---------------------------------------------------------------------------

async function getRecommendations(tasteProfile, claudeApiKey, interviewResults, libraryData, qualityRefs, lastfmData) {
  logStep("5/6", "Asking Claude for genuinely diverse recommendations...");

  const diversityInstructions = {
    low: "Suggest artists that are somewhat related but not the most obvious choices. Include a few from adjacent genres.",
    medium:
      "Push beyond the obvious. At least half should be from different genres, decades, or scenes than the user typically listens to. Include some wildcards.",
    high: "Be bold. Most recommendations should come from genres, decades, countries, or scenes the user has NOT been listening to. Find connections through production style, energy, instrumentation, lyrical themes, or emotional quality rather than genre labels. Include artists from non-English-speaking markets. Surprise them.",
  };

  // Build rich library section for recommendations
  const recLibParts = [];
  if (libraryData) {
    recLibParts.push(`SAVED LIBRARY GENRES: ${Object.entries(libraryData.libraryGenres).slice(0, 20).map(([g, c]) => `${g} (${c})`).join(", ")}`);

    const notInRecent = libraryData.libraryArtists?.filter(
      (a) => !tasteProfile.topArtists.some((ta) => ta.name === a) && !tasteProfile.recentArtistNames.includes(a)
    ) || [];
    if (notInRecent.length > 0) {
      recLibParts.push(`LIBRARY ARTISTS NOT IN RECENT LISTENING: ${notInRecent.slice(0, 20).join(", ")}`);
    }

    if (libraryData.followedArtists?.length > 0) {
      recLibParts.push(`DELIBERATELY FOLLOWED ARTISTS: ${libraryData.followedArtists.slice(0, 25).map((a) => a.genres.length > 0 ? `${a.name} (${a.genres.slice(0, 2).join(", ")})` : a.name).join(", ")}`);
    }

    if (libraryData.savedAlbums?.length > 0) {
      recLibParts.push(`SAVED ALBUMS: ${libraryData.savedAlbums.slice(0, 15).map((a) => `${a.artist} — ${a.name} (${a.releaseDate || "?"})`).join("; ")}`);
    }

    if (libraryData.decadeCounts && Object.keys(libraryData.decadeCounts).length > 0) {
      const decades = Object.entries(libraryData.decadeCounts).sort((a, b) => a[0].localeCompare(b[0]));
      recLibParts.push(`DECADE DISTRIBUTION: ${decades.map(([d, c]) => `${d}: ${c}`).join(", ")}`);
    }

  }

  // Last.fm data (when available — has play counts which Spotify doesn't expose)
  if (lastfmData) {
    if (lastfmData.artists.length > 0) {
      recLibParts.push(`LAST.FM TOP ARTISTS (with real play counts):\n${lastfmData.artists.slice(0, 15).map((a) => `  ${a.name}: ${a.playCount} plays`).join("\n")}`);
    }
    if (lastfmData.tracks.length > 0) {
      recLibParts.push(`LAST.FM TOP TRACKS (with real play counts):\n${lastfmData.tracks.slice(0, 15).map((t) => `  ${t.artist} - ${t.name}: ${t.playCount} plays`).join("\n")}`);
    }
    if (lastfmData.loved.length > 0) {
      recLibParts.push(`LAST.FM LOVED TRACKS (explicitly marked as favourites — strongest signal of what this user considers quality):\n${lastfmData.loved.slice(0, 15).map((t) => `  ${t.artist} - ${t.name}`).join("\n")}`);
    }
  }

  const prompt = `You are a music discovery engine designed to break people out of algorithmic echo chambers.

Here is the user's current Spotify taste profile:

TOP ARTISTS (with time range — short=last 4 weeks, medium=~6 months, long=~1 year):
${tasteProfile.topArtists.map((a) => `${a.name} [${a.sources.join("+")}] (${a.genres.join(", ")})`).join("; ")}

TOP TRACKS (with release date and time range):
${tasteProfile.topTracks.map((t) => `${t.artist} - ${t.name} [${t.releaseDate || "?"}] (${t.sources.join("+")})`).join("; ")}

RECENTLY PLAYED ARTISTS: ${tasteProfile.recentArtistNames.join(", ")}

ALL GENRES: ${tasteProfile.allGenres.join(", ")}

${tasteProfile.longTermOnlyArtists?.length > 0 ? `FADING INTERESTS (long-term only, not in recent listening):
${tasteProfile.longTermOnlyArtists.slice(0, 10).map((a) => `${a.name} (${a.genres.slice(0, 3).join(", ")})`).join("; ")}` : ""}

${tasteProfile.shortTermOnlyArtists?.length > 0 ? `NEW/TRENDING (short-term only, recent discoveries):
${tasteProfile.shortTermOnlyArtists.slice(0, 10).map((a) => `${a.name} (${a.genres.slice(0, 3).join(", ")})`).join("; ")}` : ""}

DIVERSITY LEVEL: ${diversity}
${diversityInstructions[diversity] || diversityInstructions.high}

${recLibParts.length > 0 ? `SAVED LIBRARY ANALYSIS:\n${recLibParts.join("\n")}` : ""}

${interviewResults ? `USER INPUT:
- Taste analysis: ${interviewResults.summary || "N/A"}
- Algorithmic biases detected: ${interviewResults.biases?.join("; ") || "None"}
${interviewResults.feedback ? `- User feedback on recent discoveries: "${interviewResults.feedback}" — USE THIS TO GUIDE RECOMMENDATIONS. If they loved something, find more like it. If they hated something, avoid that direction.` : ""}
${interviewResults.mood ? `- Requested vibe: "${interviewResults.mood}" — weight recommendations toward this mood/feel.` : ""}

Use the taste trajectory (fading vs new interests), followed artists, saved albums, and user-created playlists to understand their TRUE breadth.
Counteract the algorithmic biases detected above.
Prioritise underrepresented decades/genres from their library.` : ""}

${qualityRefs && Object.keys(qualityRefs).length > 0 ? `QUALITY REFERENCE — TOP TRACKS BY GENRE (from Last.fm, ranked by dedicated listeners):
${Object.entries(qualityRefs).map(([genre, tracks]) => `  ${genre}: ${tracks.map((t) => `${t.artist} - ${t.name}`).join("; ")}`).join("\n")}

Use these as a quality benchmark — these are tracks that dedicated music listeners rate highly. You can recommend tracks from this list if they fit, or use them as a reference point for the calibre of music to suggest. Do NOT just copy this list — use it to understand what "quality" means in each genre, then find similar-calibre tracks the user hasn't heard.` : ""}

TASK: Recommend exactly ${trackCount} tracks that this person would likely enjoy but has almost certainly NOT heard yet.

CRITICAL RULES:
- QUALITY ABOVE ALL: Every track must be genuinely great music — critically acclaimed, fan-favourite deep cuts, or boundary-pushing within its genre. Do not recommend filler, generic tracks, or safe algorithmic picks. Think "what would a knowledgeable music obsessive recommend?" not "what would an algorithm suggest."
- NEVER recommend any artist already in their profile above
- Popularity is irrelevant — an obscure track is fine IF it's exceptional. A popular track is fine IF it's genuinely great, not just well-known
- Favour tracks that are interesting, surprising, or ambitious — songs that do something unexpected with production, arrangement, genre fusion, or songwriting
- Each recommendation should be a real, specific track that exists on Spotify
- Spread recommendations across multiple different artists (no more than 2 tracks per artist)
- Include at least 3-4 tracks from non-English-language music
- Include at least 2-3 tracks from before the year 2000
- Think about what QUALITIES make their current music appealing (energy, complexity, production style, mood) and find those qualities in unexpected places

Respond with ONLY a JSON array of objects, no other text. Each object should have:
- "artist": exact artist name as it appears on Spotify
- "track": exact track name as it appears on Spotify
- "why": one sentence explaining the connection to their taste (this helps the user understand why they might like it)

Example format:
[{"artist": "Artist Name", "track": "Track Name", "why": "Similar driving energy to X but from the Brazilian funk scene"}]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 16384,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";

  // Parse JSON from response (handle potential markdown fences)
  const jsonStr = text.replace(/```json\s*|```\s*/g, "").trim();
  let recommendations;
  try {
    recommendations = JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse Claude response:", text.slice(0, 500));
    throw new Error("Claude returned invalid JSON");
  }

  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    throw new Error("Claude returned empty recommendations");
  }

  log(`Got ${recommendations.length} recommendations`);
  return recommendations;
}

// ---------------------------------------------------------------------------
// Search Spotify for recommended tracks
// ---------------------------------------------------------------------------

async function resolveTracksOnSpotify(recommendations, accessToken) {
  logStep("5b/6", "Searching Spotify for recommended tracks...");

  const resolved = [];
  const notFound = [];

  for (const rec of recommendations) {
    // Search with artist + track name
    const query = `track:${rec.track} artist:${rec.artist}`;
    try {
      const results = await spotifyGet("/search", accessToken, {
        q: query,
        type: "track",
        limit: 3,
      });

      const tracks = results.tracks?.items || [];
      if (tracks.length > 0) {
        // Find best match — prefer exact artist match
        const match =
          tracks.find((t) =>
            t.artists.some((a) => a.name.toLowerCase() === rec.artist.toLowerCase())
          ) || tracks[0];

        resolved.push({
          uri: match.uri,
          name: match.name,
          artist: match.artists[0]?.name,
          why: rec.why,
        });
      } else {
        // Try broader search
        const broadResults = await spotifyGet("/search", accessToken, {
          q: `${rec.artist} ${rec.track}`,
          type: "track",
          limit: 3,
        });
        const broadTracks = broadResults.tracks?.items || [];
        if (broadTracks.length > 0) {
          resolved.push({
            uri: broadTracks[0].uri,
            name: broadTracks[0].name,
            artist: broadTracks[0].artists[0]?.name,
            why: rec.why,
          });
        } else {
          notFound.push(`${rec.artist} - ${rec.track}`);
        }
      }
    } catch (err) {
      notFound.push(`${rec.artist} - ${rec.track} (error: ${err.message})`);
    }

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  log(`Resolved ${resolved.length}/${recommendations.length} tracks on Spotify`);
  if (notFound.length > 0) {
    log(`Could not find: ${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? ` (+${notFound.length - 5} more)` : ""}`);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Create / update playlist
// ---------------------------------------------------------------------------

async function refreshPlaylist(resolvedTracks, accessToken) {
  logStep("6/6", "Updating Discovery Engine playlist...");

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

    // 1. Gather taste profile from Spotify + Last.fm in parallel
    const [tasteProfile, lastfmData] = await Promise.all([
      gatherTasteProfile(tokens.access_token),
      fetchLastfmUserData(),
    ]);

    // 2. Scan saved library for broader genre picture
    const libraryData = await scanSavedLibrary(tokens.access_token, tasteProfile);

    // 3. Analyze gaps with Claude
    const gapAnalysis = await analyzeGaps(tasteProfile, libraryData, claudeApiKey, lastfmData);

    // 4. Taste interview
    const interviewResults = await conductTasteInterview(gapAnalysis);

    // 4b. Fetch quality references from Last.fm for underrepresented genres
    const gapGenres = gapAnalysis?.gaps?.map((g) => g.area) || [];
    const allProfileGenres = tasteProfile.allGenres.slice(0, 5);
    const genresToLookup = [...new Set([...gapGenres, ...allProfileGenres])];
    const qualityRefs = await fetchQualityReferences(genresToLookup);

    // 5. Get Claude recommendations (enhanced with interview + library data + quality refs)
    const recommendations = await getRecommendations(tasteProfile, claudeApiKey, interviewResults, libraryData, qualityRefs, lastfmData);

    // 5b. Resolve on Spotify
    const resolvedTracks = await resolveTracksOnSpotify(recommendations, tokens.access_token);

    if (resolvedTracks.length === 0) {
      console.error("\nNo tracks could be resolved on Spotify. Try again.");
      process.exit(1);
    }

    // 6. Update playlist
    const { playlistId } = await refreshPlaylist(resolvedTracks, tokens.access_token);

    // Summary
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║                    ✓ Playlist Updated                   ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
    console.log(`  Playlist: ${PLAYLIST_NAME}`);
    console.log(`  Tracks:   ${resolvedTracks.length}`);
    console.log(`  Diversity: ${diversity}`);
    console.log(`  Open:     https://open.spotify.com/playlist/${playlistId}\n`);

    console.log("  What's in there:\n");
    resolvedTracks.forEach((t, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${t.artist} — ${t.name}`);
      console.log(`      → ${t.why}`);
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
