#!/usr/bin/env node

/**
 * Fetch Scrobbles from Last.fm
 *
 * Pages through user.getRecentTracks and caches every scrobble with its timestamp.
 * Re-running is incremental — it stops when it hits the newest scrobble already cached.
 *
 * Output: ~/.spotify-discover/scrobbles.json
 *   { user, lastFetchedTs, scrobbles: [{ artist, track, album, ts }] }
 *
 * The `ts` field is a Unix epoch (seconds), as returned by Last.fm.
 * "Now playing" entries (no timestamp) are skipped.
 *
 * Usage:
 *   node fetch-scrobbles.mjs              # Incremental (default)
 *   node fetch-scrobbles.mjs --full       # Refetch everything from scratch
 *   node fetch-scrobbles.mjs --max 50     # Cap pages fetched per run (default: unlimited)
 */

import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".spotify-discover");
const SCROBBLES_PATH = join(CONFIG_DIR, "scrobbles.json");

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USER = process.env.LASTFM_USER || "drew12341";
const PAGE_LIMIT = 200; // Last.fm max
const PAGE_DELAY_MS = 250;

const args = process.argv.slice(2);
const forceFull = args.includes("--full");
const maxPagesArg = parseInt(args[args.indexOf("--max") + 1]);
const maxPages = Number.isFinite(maxPagesArg) && maxPagesArg > 0 ? maxPagesArg : Infinity;

if (!LASTFM_API_KEY) {
  console.error("LASTFM_API_KEY missing from .env");
  process.exit(1);
}

async function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
}

async function loadJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function saveJson(path, data) {
  await ensureConfigDir();
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function fetchPage(page, fromTs) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", "user.getRecentTracks");
  url.searchParams.set("user", LASTFM_USER);
  url.searchParams.set("api_key", LASTFM_API_KEY);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("page", String(page));
  if (fromTs) url.searchParams.set("from", String(fromTs + 1));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Last.fm ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  return data.recenttracks;
}

function normalize(track) {
  // "Now playing" tracks have @attr.nowplaying = "true" and no date — skip them.
  if (track["@attr"]?.nowplaying === "true") return null;
  const ts = parseInt(track.date?.uts);
  if (!Number.isFinite(ts)) return null;
  const artist = track.artist?.["#text"] || track.artist?.name;
  const name = track.name;
  if (!artist || !name) return null;
  return {
    artist,
    track: name,
    album: track.album?.["#text"] || "",
    ts,
  };
}

async function main() {
  const existing = forceFull ? null : await loadJson(SCROBBLES_PATH);
  const lastTs = existing?.lastFetchedTs || 0;
  const cached = new Map();
  if (existing?.scrobbles) {
    for (const s of existing.scrobbles) cached.set(`${s.ts}:${s.artist}:${s.track}`, s);
  }

  console.log(`User: ${LASTFM_USER}`);
  console.log(`Mode: ${forceFull ? "full backfill" : (lastTs ? `incremental from ${new Date(lastTs * 1000).toISOString()}` : "first run (full)")}`);
  console.log(`Cached scrobbles: ${cached.size}`);

  let page = 1;
  let added = 0;
  let totalPages = null;

  while (page <= maxPages) {
    let recent;
    try {
      recent = await fetchPage(page, forceFull ? 0 : lastTs);
    } catch (err) {
      console.error(`  Page ${page} failed: ${err.message}`);
      break;
    }

    totalPages = parseInt(recent["@attr"]?.totalPages) || 1;
    const tracks = Array.isArray(recent.track) ? recent.track : (recent.track ? [recent.track] : []);
    if (tracks.length === 0) {
      console.log(`  Page ${page}: empty, stopping`);
      break;
    }

    let newOnPage = 0;
    let oldestOnPage = Infinity;
    for (const t of tracks) {
      const s = normalize(t);
      if (!s) continue;
      oldestOnPage = Math.min(oldestOnPage, s.ts);
      const key = `${s.ts}:${s.artist}:${s.track}`;
      if (!cached.has(key)) {
        cached.set(key, s);
        newOnPage++;
        added++;
      }
    }

    console.log(`  Page ${page}/${totalPages}: ${tracks.length} tracks, ${newOnPage} new (oldest on page: ${new Date(oldestOnPage * 1000).toISOString()})`);

    if (page >= totalPages) break;
    if (newOnPage === 0 && !forceFull) {
      console.log(`  No new scrobbles on this page — stopping`);
      break;
    }

    page++;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  // Sort newest-first for stable output
  const scrobbles = [...cached.values()].sort((a, b) => b.ts - a.ts);
  const newestTs = scrobbles[0]?.ts || lastTs;

  await saveJson(SCROBBLES_PATH, {
    user: LASTFM_USER,
    lastFetchedTs: newestTs,
    scrobbles,
  });

  console.log(`\nDone. ${added} new scrobbles. Total: ${scrobbles.length}.`);
  if (scrobbles.length > 0) {
    const oldest = scrobbles[scrobbles.length - 1].ts;
    const newest = scrobbles[0].ts;
    const days = (newest - oldest) / 86400;
    console.log(`Range: ${new Date(oldest * 1000).toISOString().slice(0, 10)} → ${new Date(newest * 1000).toISOString().slice(0, 10)} (${days.toFixed(0)} days)`);
  }
  console.log(`Saved: ${SCROBBLES_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
