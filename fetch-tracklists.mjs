#!/usr/bin/env node

/**
 * Fetch Tracklists from Spotify
 *
 * Reads my-albums.json (personal album list), looks up each album on Spotify to get its tracklist.
 * Results are saved to ~/.spotify-discover/tracklists.json
 *
 * Designed to be re-run safely — skips albums already fetched.
 *
 * Usage:
 *   node fetch-tracklists.mjs              # Fetch all missing tracklists
 *   node fetch-tracklists.mjs --force      # Re-fetch all (ignore cache)
 *   node fetch-tracklists.mjs --auth       # Force Spotify re-authentication
 */

import "dotenv/config";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".spotify-discover");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const TOKEN_PATH = join(CONFIG_DIR, "tokens.json");
const PROJECT_DIR = new URL(".", import.meta.url).pathname;
const MY_ALBUMS_PATH = join(PROJECT_DIR, "my-albums.json");
const TRACKLISTS_PATH = join(CONFIG_DIR, "tracklists.json");
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = ["user-read-private"].join(" ");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const forceAuth = args.includes("--auth");
const forceRefetch = args.includes("--force");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function saveJson(path, data) {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

function log(msg) {
  console.log(`  ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Spotify auth (reuses tokens from discover.mjs)
// ---------------------------------------------------------------------------

async function getConfig() {
  const config = await loadJson(CONFIG_PATH);
  if (config?.clientId && config?.clientSecret) return config;
  throw new Error("No Spotify config found. Run 'node discover.mjs' first to set up credentials.");
}

async function getAccessToken(config) {
  if (!forceAuth) {
    const tokens = await loadJson(TOKEN_PATH);
    if (tokens?.refresh_token) {
      const refreshed = await refreshToken(config, tokens.refresh_token);
      if (refreshed) return refreshed.access_token;
    }
  }

  // Fall back to full auth flow
  const tokens = await authorizeUser(config);
  return tokens.access_token;
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
    if (!tokens.refresh_token) tokens.refresh_token = refreshTokenStr;
    tokens.obtained_at = Date.now();
    await saveJson(TOKEN_PATH, tokens);
    return tokens;
  } catch {
    return null;
  }
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

  try {
    const open = (await import("open")).default;
    await open(authUrl.toString());
  } catch { /* URL already printed */ }

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }

      const c = url.searchParams.get("code");
      const s = url.searchParams.get("state");
      const err = url.searchParams.get("error");

      if (err) { res.writeHead(200); res.end("Auth denied."); server.close(); reject(new Error(err)); return; }
      if (s !== state) { res.writeHead(400); res.end("State mismatch."); server.close(); reject(new Error("State mismatch")); return; }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Connected. You can close this tab.</h2>");
      server.close();
      resolve(c);
    });
    server.listen(REDIRECT_PORT, "127.0.0.1");
    setTimeout(() => { server.close(); reject(new Error("Auth timeout")); }, 120_000);
  });

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });

  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
  const tokens = await tokenRes.json();
  tokens.obtained_at = Date.now();
  await saveJson(TOKEN_PATH, tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// Spotify API with rate limit handling + retry
// ---------------------------------------------------------------------------

async function spotifyGet(endpoint, accessToken, params = {}) {
  const url = new URL(`https://api.spotify.com/v1${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "5");
      log(`Rate limited, waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      if (attempt < 3) {
        await sleep(1000 * attempt);
        continue;
      }
      const text = await res.text();
      throw new Error(`Spotify ${endpoint} (${res.status}): ${text}`);
    }

    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Search Spotify for an album and get its tracks
// ---------------------------------------------------------------------------

async function fetchAlbumTracks(album, accessToken) {
  // Search for the album
  const query = `album:${album.album} artist:${album.artist}`;
  const results = await spotifyGet("/search", accessToken, {
    q: query,
    type: "album",
    limit: 5,
  });

  const albums = results.albums?.items || [];
  if (albums.length === 0) {
    // Try broader search
    const broad = await spotifyGet("/search", accessToken, {
      q: `${album.artist} ${album.album}`,
      type: "album",
      limit: 5,
    });
    albums.push(...(broad.albums?.items || []));
  }

  if (albums.length === 0) return null;

  // Find best match — prefer exact artist name match
  const match = albums.find((a) =>
    a.artists.some((ar) => ar.name.toLowerCase() === album.artist.toLowerCase())
  ) || albums[0];

  // Get full tracklist
  const trackData = await spotifyGet(`/albums/${match.id}/tracks`, accessToken, { limit: 50 });
  const tracks = (trackData.items || []).map((t) => ({
    name: t.name,
    artist: t.artists?.[0]?.name || album.artist,
    trackNumber: t.track_number,
    durationMs: t.duration_ms,
    uri: t.uri,
  }));

  return {
    spotifyId: match.id,
    spotifyName: match.name,
    spotifyArtist: match.artists?.[0]?.name,
    spotifyUri: match.uri,
    totalTracks: match.total_tracks,
    releaseDate: match.release_date,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nFetching tracklists from Spotify\n");

  // Load personal album list
  const myAlbumsData = await loadJson(MY_ALBUMS_PATH);

  const allAlbums = [];
  const seen = new Set();

  if (myAlbumsData?.albums?.length) {
    for (const a of myAlbumsData.albums) {
      const key = `${a.artist} - ${a.album}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allAlbums.push({ ...a, source: "personal" });
      }
    }
    log(`Loaded ${myAlbumsData.albums.length} albums from my-albums.json`);
  }

  if (allAlbums.length === 0) {
    console.error("No albums found. Add albums to my-albums.json in the project directory.");
    process.exit(1);
  }

  log(`Total: ${allAlbums.length} albums to process`);

  // Load existing tracklists (for resume support)
  let tracklists = {};
  if (!forceRefetch) {
    const existing = await loadJson(TRACKLISTS_PATH);
    if (existing?.albums) {
      tracklists = existing.albums;
      log(`Loaded ${Object.keys(tracklists).length} cached tracklists`);
    }
  }

  // Auth
  const config = await getConfig();
  const accessToken = await getAccessToken(config);
  log("Spotify authenticated\n");

  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  // Save progress every N albums
  const SAVE_INTERVAL = 25;

  for (let i = 0; i < allAlbums.length; i++) {
    const album = allAlbums[i];
    const key = `${album.artist} - ${album.album}`.toLowerCase();

    // Skip if already cached
    if (!forceRefetch && tracklists[key]) {
      skipped++;
      continue;
    }

    try {
      const result = await fetchAlbumTracks(album, accessToken);
      if (result) {
        tracklists[key] = {
          ...result,
          source: { artist: album.artist, album: album.album, year: album.year, rank: album.rank || null, origin: album.source || "unknown" },
        };
        fetched++;
        const trackCount = result.tracks.length;
        console.log(`  [${i + 1}/${allAlbums.length}] ${album.artist} - ${album.album} (${album.year}) — ${trackCount} tracks`);
      } else {
        failed++;
        failures.push(`${album.artist} - ${album.album} (${album.year})`);
        console.log(`  [${i + 1}/${allAlbums.length}] X ${album.artist} - ${album.album} (${album.year}) — not found`);
      }
    } catch (err) {
      failed++;
      failures.push(`${album.artist} - ${album.album} (${album.year}): ${err.message}`);
      console.log(`  [${i + 1}/${allAlbums.length}] X ${album.artist} - ${album.album} (${album.year}) — ${err.message}`);
    }

    // Save progress periodically
    if (fetched > 0 && fetched % SAVE_INTERVAL === 0) {
      await saveProgress(tracklists);
      log(`  (saved progress: ${Object.keys(tracklists).length} albums)\n`);
    }

    // Delay between requests to avoid rate limits
    await sleep(150);
  }

  // Final save
  await saveProgress(tracklists);

  // Summary
  const totalCached = Object.keys(tracklists).length;
  const totalTracks = Object.values(tracklists).reduce((sum, a) => sum + (a.tracks?.length || 0), 0);

  console.log(`\nDone: ${fetched} fetched, ${skipped} cached, ${failed} failed`);
  console.log(`Total: ${totalCached} albums, ${totalTracks} tracks`);
  console.log(`Saved: ${TRACKLISTS_PATH}`);

  if (failures.length > 0) {
    console.log(`\nFailed albums (re-run to retry):`);
    for (const f of failures.slice(0, 20)) {
      console.log(`  - ${f}`);
    }
    if (failures.length > 20) {
      console.log(`  ... and ${failures.length - 20} more`);
    }
  }

  console.log("");
}

async function saveProgress(tracklists) {
  const output = {
    generatedAt: new Date().toISOString(),
    totalAlbums: Object.keys(tracklists).length,
    totalTracks: Object.values(tracklists).reduce((sum, a) => sum + (a.tracks?.length || 0), 0),
    albums: tracklists,
  };
  await saveJson(TRACKLISTS_PATH, output);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
