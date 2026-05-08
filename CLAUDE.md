# Spotify Discovery Engine

## Project overview


The key insight: your Spotify listening history seeds Last.fm's similarity engine, but candidates are only accepted if they appear on one of the top 15 albums of any year from 1971-2026. This guarantees every recommendation is critically acclaimed while still being connected to your taste.

## Architecture

### Data pipeline (run once / periodically)

1. **`fetch-best-albums.mjs`** — Scrapes besteveralbums.com RSS feeds for top 15 albums per year (1971-2026). Saves to `~/.spotify-discover/best-albums.json` (~825 albums).
2. **`fetch-tracklists.mjs`** — Reads best-albums.json, searches Spotify for each album, saves full tracklists with Spotify URIs to `~/.spotify-discover/tracklists.json`. Idempotent — skips already-fetched albums, safe to re-run to fill gaps from rate limits.
3. **`fetch-scrobbles.mjs`** — Pages through Last.fm `user.getRecentTracks` and caches every scrobble with its timestamp to `~/.spotify-discover/scrobbles.json`. Incremental — re-running only fetches new scrobbles since the last run. Powers the bucket-affinity time-of-day signal.

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
- Claude selects 60 and sequences them into a cohesive playlist
- Each candidate is labelled "vibe: recent" (from current listening seeds) or "vibe: library" (from all-time album seeds) — Claude prefers recent-vibe tracks (~60% target) to reflect the user's current mood
- Rules: decade balance (~5 from 70s, 12 from 80s/90s/00s/10s, 7 from 20s), genre cap at ~25%, max 2 per artist, spread same-seed tracks apart
- **Programmatic anti-cluster pass** runs after — constraint-based ordering that picks each next track to maximize difference from the previous (different artist, album, seed, decade)

**Step 4/4 — Update Spotify playlist**:
- Creates or updates "Discovery Engine" playlist with the curated track URIs

### Key files

| File | Purpose |
|------|---------|
| `discover.mjs` | Main discovery engine — all pipeline logic |
| `fetch-best-albums.mjs` | Scrapes besteveralbums.com RSS feeds |
| `fetch-tracklists.mjs` | Fetches Spotify tracklists for all albums |
| `fetch-scrobbles.mjs` | Caches Last.fm scrobble history with timestamps for bucket affinity |
| `test-playlist.mjs` | Test/debug utility |
| `.env` | API keys (ANTHROPIC_API_KEY, LASTFM_API_KEY, LASTFM_API_SECRET) |

### Data files (`~/.spotify-discover/`)

| File | Purpose |
|------|---------|
| `best-albums.json` | ~825 albums with artist, album, year, rank |
| `tracklists.json` | Full Spotify tracklists for each album (tracks with URIs) |
| `config.json` | Spotify client ID + secret |
| `tokens.json` | Spotify OAuth tokens (auto-refreshed) |
| `run-history.json` | Last 20 run analyses — decade/genre distribution, violations, tracks. Fed back into curation prompt |
| `scrobbles.json` | Last.fm scrobble history with timestamps. Powers bucket-affinity weighting in seed selection |

## How song selection works

### The problem
Spotify's algorithm creates an echo chamber — it recommends music similar to what you already listen to, reinforcing narrow taste. You never discover critically-acclaimed albums from decades or genres outside your bubble.

### The solution: data-driven discovery constrained to quality

```
Your listening history → Last.fm similarity → Filter to top 15 albums/year → Claude curates
```

**1. Seeds come from YOU** — two sources blended together: ~70% from your listening history (recently played, top tracks, my-seeds.json favourites) and ~30% from your all-time album collection (my-albums.json). The album seeds ensure your full taste profile feeds discovery even when your recent listening is narrow. The split ratio is stored in run-history.json and can be tuned by the feedback loop.

**2. Last.fm finds similar tracks** — for each seed, Last.fm's `track.getSimilar` returns tracks that real listeners also enjoy. This is collaborative filtering based on actual human listening patterns, not an LLM guessing.

**3. Quality filter** — similar tracks are only kept if they exist on one of the ~825 top-rated albums (1971-2026) from besteveralbums.com. This means every candidate is critically acclaimed — no filler, no algorithm bait.

**4. Decade balancing** — your seeds are probably skewed toward recent decades (Spotify's bias). The engine detects this and adds "exploration seeds" from top albums in underrepresented eras. Claude picks the most iconic track from each exploration album to use as a seed.

**5. Soft known-track exclusion** — designed to feel like "hey you might like this", not strict new-only:
- Spotify recently played (last 50) — avoids immediate repeats
- Last.fm tracks with **≥50 scrobbles** — only the truly burned-in stuff is filtered out
- Tracks from previous 3 runs — keeps each run fresh
- Feedback-skipped tracks — explicit user "no"
- Fuzzy matching handles "Remastered", "Deluxe Edition", etc.

Tracks the user has heard a few times (or even has on a saved album) are now eligible candidates. Heavily-played tracks are filtered via the scrobble-count threshold rather than a blanket top-tracks ban.

**6. Discovery-weighted seed slots** — seed tracks with LOW play counts get MORE recommendation slots than heavily-played seeds. This pushes Last.fm's similarity engine toward unexplored corners of the user's taste, instead of reinforcing familiar territory.

**6b. Bucket affinity (time-of-day / day-of-week)** — scrobbles are bucketed by `weekday-vs-weekend` × `morning/afternoon/evening/night` (8 buckets). At run time the engine identifies the current bucket and counts each seed's scrobbles within that bucket. Two effects: (a) fresh seeds query Last.fm in **bucket-affinity-descending order** so high-affinity seeds always get processed before any candidate-cap truncation; (b) the **top quartile of bucket-matched seeds get +1 slot** in the slot allocator (additive to the inverted play-count weighting). Falls back gracefully if `scrobbles.json` is missing.

**7. Spotify Recommendations API** — a fourth discovery pass using Spotify's audio-feature similarity (different algorithm than Last.fm's collaborative filtering). Uses low-play-count seeds with max_popularity=60 to surface genuinely obscure tracks.

**8. Claude curates, doesn't generate** — Claude never invents recommendations. It receives ~85 data-driven candidates and selects 60, sequencing them into a playlist with decade balance, genre diversity, and no clustering. Each candidate is tagged with its seed source ("vibe: recent" or "vibe: library") so Claude can prefer tracks that match the user's current listening mood (~60% recent target). Candidates include Spotify popularity scores; Claude deprioritizes high-popularity (>70) tracks as likely already known.

**9. Anti-cluster ordering** — a constraint-based algorithm ensures no two tracks from the same artist, album, or seed source appear within 5 positions of each other. It scores each candidate against a sliding window of the last 5 placed tracks, not just the previous one.

**10. Same-artist-as-seed filtering** — Last.fm's `track.getSimilar` often returns tracks by the same artist as the seed. These are now filtered out programmatically — candidates must be by a different artist than their seed.

**11. Seed track exclusion** — seed tracks themselves are never recommended back. A fuzzy-matched set of all seed track keys is checked during candidate filtering.

**12. Artist alias grouping** — related artists (e.g., Kanye West / KIDS SEE GHOSTS / ¥$, White Zombie / Rob Zombie) are grouped under a canonical name for per-artist cap enforcement. Configured in `ARTIST_ALIAS_GROUPS` in discover.mjs.

**13. Feedback loop** — each run's playlist is analyzed (decade/genre distribution, artist violations, clustering issues) and logged to `~/.spotify-discover/run-history.json`. Issues from the previous run are injected into the curation prompt so Claude can correct recurring patterns.

### What Claude does (3 API calls total)

| Call | Purpose |
|------|---------|
| Pick best exploration tracks | Given album tracklists, selects the most iconic/recognizable track from each exploration album to use as a seed |
| Select 30 seeds | From ~85 candidates, picks 30 that maximize genre/decade/mood diversity. Must keep 15+ from listening history |
| Curate 60 from ~85 | Selects and sequences the final playlist. Has genre tags, match scores, decade info, and vibe labels (recent vs library) to make informed cuts — prefers recent-vibe tracks |

### What Claude does NOT do

- Generate recommendations from its training data
- Guess what music exists on Spotify
- Make up artist/track names

## Key design decisions

- **No Claude for candidate generation** — candidates come from Last.fm similarity data and Spotify's Recommendations API. Claude only curates/sequences.
- **Discovery-weighted seeds** — least-played seeds get more recommendation slots, pushing the similarity engine toward unexplored taste. Inverts the natural bias toward overplayed tracks.
- **Soft overplay exclusion** — only Spotify recently-played (last 50) + Last.fm tracks with ≥50 scrobbles + previous runs + feedback skips. Designed for "hey you might like this" rather than strict new-only — known-but-not-overplayed tracks are welcome candidates.
- **Bucket affinity for time-of-day patterns** — scrobble history is bucketed by weekday/weekend × time-of-day. Seeds matching the current bucket are queried first and get a +1 slot bonus, so the playlist reflects what the user actually listens to in this context (e.g. weekday morning vs Friday night).
- **Spotify Recommendations API** — fourth pass using audio-feature similarity with max_popularity=60, surfacing obscure tracks from a different algorithm than Last.fm's collaborative filtering.
- **Popularity-aware curation** — Spotify popularity scores are included in the curation prompt. Claude deprioritizes tracks with popularity >70 as likely already known.
- **3-per-seed cap** — prevents one seed track from dominating the playlist.
- **3-per-artist cap** — ensures artist diversity in candidates.
- **Fuzzy track matching** — normalizes track names (strips remaster/deluxe/edition suffixes) before comparing against known tracks. Prevents "Black Hole Sun - Remastered" from slipping through when you already know "Black Hole Sun".
- **Same-album-as-seed exclusion** — if "Jail" by Kanye is a seed, other Donda tracks won't be recommended (you already know that album).
- **Exploration seeds from top albums** — fills decade gaps by seeding from #1-5 ranked albums in underrepresented eras. Claude picks the best track from each album.
- **Genre tags from Last.fm** — `artist.getTopTags` provides actual genre data since Spotify Dev Mode strips genres. Included in curation prompt so Claude can enforce genre balance.
- **Constraint-based anti-clustering** — instead of swapping after the fact, builds the track order from scratch. Uses a sliding window of 5 tracks to prevent clustering, not just the immediately previous track.
- **Same-artist-as-seed exclusion** — if "Jail" by Kanye is a seed, no Kanye tracks will appear as candidates from that seed. Last.fm often returns same-artist tracks with high match scores; these are now filtered.
- **Seed track exclusion** — seed tracks are never recommended back as discoveries. A fuzzy-matched set prevents remastered variants from slipping through.
- **Artist alias groups** — related artists are grouped for cap enforcement. Kanye West, KIDS SEE GHOSTS, and ¥$ share one 3-track cap. Configurable in `ARTIST_ALIAS_GROUPS`.
- **Feedback loop** — run history is logged to `run-history.json` with automated analysis. Issues from the previous run (decade skew, genre overload, artist clustering) are injected into the curation prompt so Claude can self-correct across runs.
- **Last.fm for play counts only** — last.fm mirrors Spotify listening data, but adds numeric play counts that Spotify doesn't expose.
- **Vibe-aware curation** — each candidate carries its seed source (recent listening vs all-time album). The curation prompt labels each track "vibe: recent" or "vibe: library" and instructs Claude to prefer recent-vibe tracks (~60% target), so the playlist reflects the user's current mood while still drawing from the full collection.
- **No fallbacks** — if a Claude API call fails, the pipeline throws an error rather than silently producing a bad playlist.

## CLI usage

```bash
node fetch-best-albums.mjs          # Fetch ~825 albums (run once)
node fetch-best-albums.mjs --from 1960  # Custom start year
node fetch-tracklists.mjs           # Fetch Spotify tracklists (re-run to fill gaps)
node fetch-scrobbles.mjs            # Cache Last.fm scrobble history (incremental — run before each discovery for fresh bucket data)
node fetch-scrobbles.mjs --full     # Force full backfill from scratch
node discover.mjs                   # Generate playlist (60 tracks)
node discover.mjs --count 30        # Custom track count
node discover.mjs --diversity high  # low | medium | high (default: high)
node discover.mjs --auth            # Force Spotify re-auth
```

## Dependencies

- `dotenv` — loads .env file
- `open` — opens browser for Spotify OAuth
- Node.js built-in `http`, `fs`, `path`, `os`, `crypto` modules
- External APIs: Spotify Web API, Last.fm API, Anthropic Claude API

## MCP Memory Service

Always check the MCP memory service (`mcp_memory_service`) before making design decisions or assumptions. User preferences and architectural decisions for this project are stored there. When the user gives guidance that's unexpected or differs from the default approach, store it in MCP memory with the `spotify-playlist` tag.
