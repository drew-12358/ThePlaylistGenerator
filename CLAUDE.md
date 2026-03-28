# Spotify Discovery Engine

## Project overview


The key insight: your Spotify listening history seeds Last.fm's similarity engine, but candidates are only accepted if they appear on one of the top 15 albums of any year from 1971-2026. This guarantees every recommendation is critically acclaimed while still being connected to your taste.

## Architecture

### Data pipeline (run once / periodically)

1. **`fetch-best-albums.mjs`** — Scrapes besteveralbums.com RSS feeds for top 15 albums per year (1971-2026). Saves to `~/.spotify-discover/best-albums.json` (~825 albums).
2. **`fetch-tracklists.mjs`** — Reads best-albums.json, searches Spotify for each album, saves full tracklists with Spotify URIs to `~/.spotify-discover/tracklists.json`. Idempotent — skips already-fetched albums, safe to re-run to fill gaps from rate limits.

### Discovery engine (`discover.mjs`)

**Step 1/4 — Gather taste profile** (parallel):
- Spotify top artists/tracks across 3 time ranges (short/medium/long term), recently played
- Last.fm top artists + tracks with numeric play counts (the only signal Spotify doesn't expose)
- Load tracklists.json from disk (~10,000 tracks across ~825 albums)

**Step 2/4 — Scan saved library**:
- Followed artists, saved albums, liked tracks
- Decade distribution, genre counts
- Builds `knownTracks` set using fuzzy matching (strips "Remastered", "Deluxe Edition", etc.)

**Step 3/4 — Find candidates via Last.fm similarity**:
1. Gathers seed tracks from: last.fm top tracks (by play count), Spotify top tracks, liked tracks (~67 seeds)
2. Checks decade balance of seeds — if skewed (e.g. no 70s/80s seeds), adds **exploration seeds** from top-ranked albums in underrepresented decades
3. Claude picks best seed track from each exploration album (single batch call — chooses iconic tracks, not random mid-album cuts)
4. Claude selects 30 diverse seeds from the full pool (~85), keeping at least 15 from listening history
5. For each seed, calls `track.getSimilar` on Last.fm API, cross-references against cached tracklists
6. Rules: 3 matches per seed, 3 tracks per artist, skip known tracks (fuzzy), skip same-album-as-seed
7. Fetches genre tags from Last.fm `artist.getTopTags` for all candidate artists

**Step 3b/4 — Claude curation pass**:
- Sends all ~70 candidates (with match scores, seed info, album, year, genre tags) to Claude
- Claude selects 50 and sequences them into a cohesive playlist
- Rules: decade balance (~4 from 70s, 10 from 80s/90s/00s/10s, 6 from 20s), genre cap at ~25%, max 2 per artist, spread same-seed tracks apart
- **Programmatic anti-cluster pass** runs after — constraint-based ordering that picks each next track to maximize difference from the previous (different artist, album, seed, decade)

**Step 4/4 — Update Spotify playlist**:
- Creates or updates "Discovery Engine" playlist with the curated track URIs

### Key files

| File | Purpose |
|------|---------|
| `discover.mjs` | Main discovery engine — all pipeline logic |
| `fetch-best-albums.mjs` | Scrapes besteveralbums.com RSS feeds |
| `fetch-tracklists.mjs` | Fetches Spotify tracklists for all albums |
| `test-playlist.mjs` | Test/debug utility |
| `.env` | API keys (ANTHROPIC_API_KEY, LASTFM_API_KEY, LASTFM_API_SECRET) |

### Data files (`~/.spotify-discover/`)

| File | Purpose |
|------|---------|
| `best-albums.json` | ~825 albums with artist, album, year, rank |
| `tracklists.json` | Full Spotify tracklists for each album (tracks with URIs) |
| `config.json` | Spotify client ID + secret |
| `tokens.json` | Spotify OAuth tokens (auto-refreshed) |

## How song selection works

### The problem
Spotify's algorithm creates an echo chamber — it recommends music similar to what you already listen to, reinforcing narrow taste. You never discover critically-acclaimed albums from decades or genres outside your bubble.

### The solution: data-driven discovery constrained to quality

```
Your listening history → Last.fm similarity → Filter to top 15 albums/year → Claude curates
```

**1. Seeds come from YOU** — your most-played tracks, top tracks, and liked songs. These are the starting points.

**2. Last.fm finds similar tracks** — for each seed, Last.fm's `track.getSimilar` returns tracks that real listeners also enjoy. This is collaborative filtering based on actual human listening patterns, not an LLM guessing.

**3. Quality filter** — similar tracks are only kept if they exist on one of the ~825 top-rated albums (1971-2026) from besteveralbums.com. This means every candidate is critically acclaimed — no filler, no algorithm bait.

**4. Decade balancing** — your seeds are probably skewed toward recent decades (Spotify's bias). The engine detects this and adds "exploration seeds" from top albums in underrepresented eras. Claude picks the most iconic track from each exploration album to use as a seed.

**5. Known track exclusion** — tracks you've already listened to are excluded using fuzzy matching that handles "Remastered", "Deluxe Edition", etc. All tracks from albums you've saved to Spotify are excluded too.

**6. Claude curates, doesn't generate** — Claude never invents recommendations. It receives ~70 data-driven candidates and selects 50, sequencing them into a playlist with decade balance, genre diversity, and no clustering.

**7. Anti-cluster ordering** — a constraint-based algorithm ensures no two tracks from the same artist, album, or seed source are adjacent. It picks each next track to maximize difference from the previous one.

### What Claude does (3 API calls total)

| Call | Purpose |
|------|---------|
| Pick best exploration tracks | Given album tracklists, selects the most iconic/recognizable track from each exploration album to use as a seed |
| Select 30 seeds | From ~85 candidates, picks 30 that maximize genre/decade/mood diversity. Must keep 15+ from listening history |
| Curate 50 from 70 | Selects and sequences the final playlist. Has genre tags, match scores, decade info to make informed cuts |

### What Claude does NOT do

- Generate recommendations from its training data
- Guess what music exists on Spotify
- Make up artist/track names

## Key design decisions

- **No Claude for candidate generation** — candidates come purely from Last.fm similarity data cross-referenced against the curated album list. Claude only curates/sequences.
- **3-per-seed cap** — prevents one seed track from dominating the playlist.
- **3-per-artist cap** — ensures artist diversity in candidates.
- **Fuzzy track matching** — normalizes track names (strips remaster/deluxe/edition suffixes) before comparing against known tracks. Prevents "Black Hole Sun - Remastered" from slipping through when you already know "Black Hole Sun".
- **Same-album-as-seed exclusion** — if "Jail" by Kanye is a seed, other Donda tracks won't be recommended (you already know that album).
- **Exploration seeds from top albums** — fills decade gaps by seeding from #1-5 ranked albums in underrepresented eras. Claude picks the best track from each album.
- **Genre tags from Last.fm** — `artist.getTopTags` provides actual genre data since Spotify Dev Mode strips genres. Included in curation prompt so Claude can enforce genre balance.
- **Constraint-based anti-clustering** — instead of swapping after the fact, builds the track order from scratch, always picking the next track that's most different from the previous.
- **Saved albums = known** — if you saved an album to Spotify, all tracks from it are excluded.
- **Last.fm for play counts only** — last.fm mirrors Spotify listening data, but adds numeric play counts that Spotify doesn't expose.
- **No fallbacks** — if a Claude API call fails, the pipeline throws an error rather than silently producing a bad playlist.

## CLI usage

```bash
node fetch-best-albums.mjs          # Fetch ~825 albums (run once)
node fetch-best-albums.mjs --from 1960  # Custom start year
node fetch-tracklists.mjs           # Fetch Spotify tracklists (re-run to fill gaps)
node discover.mjs                   # Generate playlist (50 tracks)
node discover.mjs --count 30        # Custom track count
node discover.mjs --diversity high  # low | medium | high (default: high)
node discover.mjs --auth            # Force Spotify re-auth
```

## Dependencies

- `dotenv` — loads .env file
- `open` — opens browser for Spotify OAuth
- Node.js built-in `http`, `fs`, `path`, `os`, `crypto` modules
- External APIs: Spotify Web API, Last.fm API, Anthropic Claude API
