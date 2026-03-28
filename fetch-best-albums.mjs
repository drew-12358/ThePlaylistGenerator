#!/usr/bin/env node

/**
 * Fetch Best Albums by Year
 *
 * Scrapes the top 15 albums per year from besteveralbums.com RSS feeds
 * for the past 50 years and saves to ~/.spotify-discover/best-albums.json
 *
 * Usage:
 *   node fetch-best-albums.mjs              # Fetch all 50 years
 *   node fetch-best-albums.mjs --from 2000  # Fetch from 2000 to present
 *   node fetch-best-albums.mjs --year 1985  # Fetch a single year
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".spotify-discover");
const OUTPUT_PATH = join(CONFIG_DIR, "best-albums.json");
const ALBUMS_PER_YEAR = 15;
const CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_START_YEAR = 1971; // 55+ years of critically acclaimed music

const FEED_URL = (year) =>
  `https://www.besteveralbums.com/feeds/BestEverAlbumsdotCom_BestAlbumsOf${year}.xml`;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const singleYear = parseInt(args[args.indexOf("--year") + 1]) || null;
const fromYear = parseInt(args[args.indexOf("--from") + 1]) || DEFAULT_START_YEAR;

// ---------------------------------------------------------------------------
// XML parsing (no dependencies — just regex on the simple RSS)
// ---------------------------------------------------------------------------

function parseAlbumsFromXml(xml, year) {
  const albums = [];
  const itemRegex = /<item>\s*<title>(.*?)<\/title>\s*<link>(.*?)<\/link>/gs;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && albums.length < ALBUMS_PER_YEAR) {
    const raw = match[1].trim();
    const link = match[2].trim();

    // Format: "1. Album Name - Artist Name"
    const parsed = raw.match(/^(\d+)\.\s+(.+?)\s+-\s+(.+)$/);
    if (!parsed) continue;

    albums.push({
      rank: parseInt(parsed[1]),
      album: parsed[2].trim(),
      artist: parsed[3].trim(),
      year,
      url: link,
    });
  }

  return albums;
}

// ---------------------------------------------------------------------------
// Fetch with retry + rate limiting
// ---------------------------------------------------------------------------

async function fetchYear(year) {
  const url = FEED_URL(year);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const xml = await res.text();
      const albums = parseAlbumsFromXml(xml, year);

      if (albums.length === 0) {
        console.log(`  ? ${year}: no albums found in feed`);
        return [];
      }

      console.log(`  ${year}: ${albums.length} albums (${albums[0].artist} - ${albums[0].album})`);
      return albums;
    } catch (err) {
      if (attempt === 3) {
        console.log(`  X ${year}: failed after 3 attempts (${err.message})`);
        return [];
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startYear = singleYear || fromYear;
  const endYear = singleYear || CURRENT_YEAR;
  const totalYears = endYear - startYear + 1;

  console.log(`\nFetching best ${ALBUMS_PER_YEAR} albums per year: ${startYear}-${endYear} (${totalYears} years)\n`);

  // Load existing data to allow incremental updates
  let existing = {};
  if (existsSync(OUTPUT_PATH)) {
    try {
      const data = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
      existing = data.byYear || {};
      console.log(`  Loaded existing data (${Object.keys(existing).length} years cached)\n`);
    } catch {
      // ignore corrupt file
    }
  }

  const byYear = { ...existing };
  let fetched = 0;
  let skipped = 0;

  for (let year = startYear; year <= endYear; year++) {
    // Skip years we already have (unless --year forces a single refresh)
    if (!singleYear && byYear[year] && byYear[year].length > 0) {
      skipped++;
      continue;
    }

    const albums = await fetchYear(year);
    if (albums.length > 0) {
      byYear[year] = albums;
    }
    fetched++;

    // Be polite: 500ms between requests
    if (year < endYear) await sleep(500);
  }

  // Build flat list sorted by year desc, then rank asc
  const allAlbums = Object.values(byYear)
    .flat()
    .sort((a, b) => b.year - a.year || a.rank - b.rank);

  const output = {
    generatedAt: new Date().toISOString(),
    source: "besteveralbums.com",
    yearRange: `${startYear}-${endYear}`,
    albumsPerYear: ALBUMS_PER_YEAR,
    totalAlbums: allAlbums.length,
    byYear,
    allAlbums,
  };

  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\nDone: ${fetched} fetched, ${skipped} cached`);
  console.log(`Total: ${allAlbums.length} albums across ${Object.keys(byYear).length} years`);
  console.log(`Saved: ${OUTPUT_PATH}\n`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
