# Spotify Discovery Engine

## Project overview

A music discovery system that breaks the Spotify algorithmic echo chamber. Instead of asking an LLM to guess at recommendations, it uses **data-driven candidate generation** from Last.fm's similarity API, constrained to 750 critically-acclaimed albums (top 15 per year, 1977-2026), then lets Claude curate and sequence the final playlist.

## Architecture

### Data pipeline (run once / periodically)

1. **`fetch-best-albums.mjs`** — Scrapes besteveralbums.com RSS feeds for top 15 albums per year (1977-2026). Saves to `~/.spotify-discover/best-albums.json` (750 albums).
2. **`fetch-tracklists.mjs`** — Reads best-albums.json, searches Spotify for each album, saves full tracklists with Spotify URIs. Saves to `~/.spotify-discover/tracklists.json`. Skips already-fetched albums (safe to re-run for retries). Currently ~575/750 covered.

### Discovery engine (`discover.mjs`)

**Step 1/4 — Gather taste profile** (parallel):
- Spotify top artists/tracks across 3 time ranges (short/medium/long term), recently played
- Last.fm top artists + tracks with numeric play counts (the only signal Spotify doesn't expose)
- Loads tracklists.json from disk

**Step 2/4 — Scan saved library**:
- Followed artists, saved albums, liked tracks
- Decade distribution, genre counts

**Step 3/4 — Find candidates via Last.fm similarity**:
- Builds lookup of all ~7,500 tracks from tracklists.json
- Builds `knownTracks` set (Spotify top tracks, liked tracks, last.fm tracks, all tracks from saved albums)
- Gathers seed tracks from: last.fm top tracks (by play count), Spotify top tracks, liked tracks
- For each seed, calls `track.getSimilar` on Last.fm API
- Cross-references results against the tracklist lookup — only keeps matches that exist in the top 750 albums
- Caps at 3 matches per seed (prevents clustering) and 3 tracks per artist
- Stops when ~63 candidates are found

**Step 3b/4 — Claude curation pass**:
- Sends all ~60 candidates (with match scores and seed info) to Claude
- Claude selects 45, sequences them into a cohesive playlist
- Anti-clustering rules: no same artist/album/seed adjacent, spread across decades
- Claude is skeptical of low-match-score tracks (<10%) — keeps adventurous ones, drops generic ones
- Creates an arc: opening, build, shifts, satisfying close

**Step 4/4 — Update Spotify playlist**:
- Creates or updates "Discovery Engine" playlist with the curated track URIs

### Key files

| File | Purpose |
|------|---------|
| `discover.mjs` | Main discovery engine — all pipeline logic |
| `fetch-best-albums.mjs` | Scrapes besteveralbums.com RSS feeds |
| `fetch-tracklists.mjs` | Fetches Spotify tracklists for all 750 albums |
| `test-playlist.mjs` | Test/debug utility |
| `.env` | API keys (ANTHROPIC_API_KEY, LASTFM_API_KEY, LASTFM_API_SECRET) |

### Data files (`~/.spotify-discover/`)

| File | Purpose |
|------|---------|
| `best-albums.json` | 750 albums with artist, album, year, rank |
| `tracklists.json` | Full Spotify tracklists for each album (tracks with URIs) |
| `config.json` | Spotify client ID + secret |
| `tokens.json` | Spotify OAuth tokens (auto-refreshed) |

## Key design decisions

- **No Claude for candidate generation** — candidates come purely from Last.fm similarity data cross-referenced against the curated album list. Claude only curates/sequences.
- **3-per-seed cap** — prevents one seed track from dominating the playlist with too many similar results.
- **3-per-artist cap** — ensures artist diversity in candidates.
- **Match scores passed to Claude** — low-match tracks (<10%) are only kept if they're genuinely adventurous picks, not generic familiar songs.
- **Saved albums = known** — if the user saved an album to their Spotify library, all tracks from it are excluded from candidates.
- **Last.fm for play counts only** — last.fm mirrors Spotify listening data, but adds numeric play counts that Spotify doesn't expose. We don't fetch loved tracks or recent tracks (redundant with Spotify data).
- **Tracklists cached locally** — avoids 750 Spotify API calls on every run. fetch-tracklists.mjs is idempotent (skips already-fetched albums).

## CLI usage

```bash
node fetch-best-albums.mjs          # Fetch 750 albums (run once)
node fetch-tracklists.mjs           # Fetch Spotify tracklists (re-run to fill gaps)
node discover.mjs                   # Generate playlist
node discover.mjs --count 30        # Custom track count
node discover.mjs --diversity high  # low | medium | high (default: high)
node discover.mjs --auth            # Force Spotify re-auth
```

## Dependencies

- `dotenv` — loads .env file
- `open` — opens browser for Spotify OAuth
- Node.js built-in `http`, `fs`, `path`, `os`, `crypto` modules
- External APIs: Spotify Web API, Last.fm API, Anthropic Claude API
