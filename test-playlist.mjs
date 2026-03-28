#!/usr/bin/env node
/**
 * Test script to diagnose playlist write permissions.
 * Tries every method of updating a playlist to find what works.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".spotify-discover");
const TOKEN_PATH = join(CONFIG_DIR, "tokens.json");
const PLAYLIST_ID = "3VqK5ZkHgmrrA5T93U1JAm";

const tokens = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
const token = tokens.access_token;

async function tryRequest(label, method, endpoint, body) {
  console.log(`\n--- ${label} ---`);
  console.log(`  ${method} ${endpoint}`);
  try {
    const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    console.log(`  Status: ${res.status}`);
    if (!res.ok) console.log(`  Error: ${text}`);
    else console.log(`  OK${text ? `: ${text.slice(0, 100)}` : ""}`);
    return res.ok;
  } catch (err) {
    console.log(`  Exception: ${err.message}`);
    return false;
  }
}

// 1. Read playlist tracks (GET)
await tryRequest(
  "GET playlist tracks",
  "GET",
  `/playlists/${PLAYLIST_ID}/tracks?limit=5`,
);

// 2. Try POST to add a track
const testUri = "spotify:track:4iV5W9uYEdYUVa79Axb7Rh"; // a known Spotify track (Mr. Brightside)
await tryRequest(
  "POST add track",
  "POST",
  `/playlists/${PLAYLIST_ID}/tracks`,
  { uris: [testUri] },
);

// 3. Try PUT to replace tracks
await tryRequest(
  "PUT replace tracks via /tracks",
  "PUT",
  `/playlists/${PLAYLIST_ID}/tracks`,
  { uris: [testUri] },
);

// 4. Try DELETE to remove a track
await tryRequest(
  "DELETE remove track",
  "DELETE",
  `/playlists/${PLAYLIST_ID}/tracks`,
  { tracks: [{ uri: testUri }] },
);

// 5. Try PUT on /items endpoint
await tryRequest(
  "PUT replace via /items",
  "PUT",
  `/playlists/${PLAYLIST_ID}/items`,
  { uris: [testUri] },
);

// 6. Try creating a brand new playlist
const me = await fetch("https://api.spotify.com/v1/me", {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json());

await tryRequest(
  "POST create new playlist",
  "POST",
  `/users/${me.id}/playlists`,
  { name: "Test Playlist (delete me)", public: false },
);

console.log("\nDone. Check which methods returned OK vs 403.\n");
