# Spotify Discovery Engine

Breaks the algorithmic echo chamber by combining your Spotify listening data, Last.fm similarity data, and a curated database of 750 critically-acclaimed albums to generate genuinely diverse playlists.

## How it works

1. **Data pipeline** (run once) — Fetches the top 15 albums per year for 50 years from besteveralbums.com, then pulls each album's full tracklist from Spotify (~7,500 tracks).
2. **Candidate generation** — Takes your most-played tracks as seeds, calls Last.fm's `track.getSimilar` for each, and cross-references results against the cached tracklist. Only tracks that exist on critically-acclaimed albums make the cut.
3. **Curation** — Claude receives ~60 candidates with similarity scores and sequences the best 45 into a cohesive playlist — mixing genres, decades, and energy levels.
4. **Playlist update** — Creates or refreshes a "Discovery Engine" playlist on your Spotify account.

## Setup

### 1. Spotify Developer App

1. Go to https://developer.spotify.com/dashboard
2. Log in with your Spotify Premium account
3. Create an app, set the redirect URI to `http://127.0.0.1:8765/callback`
4. Note the Client ID and Client Secret

### 2. Environment Variables

Create a `.env` file:

```
ANTHROPIC_API_KEY=sk-ant-...
LASTFM_API_KEY=your-lastfm-api-key
LASTFM_API_SECRET=your-lastfm-api-secret
```

Last.fm is required — it provides the similarity data that drives candidate generation, plus actual play counts (which Spotify doesn't expose).

### 3. Install & Build Data

```bash
npm install
node fetch-best-albums.mjs    # Scrape 750 albums (run once)
node fetch-tracklists.mjs      # Fetch Spotify tracklists (re-run to fill gaps from rate limits)
```

## Usage

```bash
node discover.mjs                   # Run discovery (creates/refreshes playlist)
node discover.mjs --auth            # Force re-authentication
node discover.mjs --count 30        # Number of tracks (default: 45)
node discover.mjs --diversity high  # low | medium | high (default: high)
```

On first run, you'll be prompted for your Spotify Client ID/Secret and directed to authorize in the browser.

## Data files

Stored in `~/.spotify-discover/`:

| File | Purpose |
|------|---------|
| `best-albums.json` | 750 albums (top 15/year, 1977-2026) |
| `tracklists.json` | Full Spotify tracklists for each album |
| `config.json` | Spotify client credentials |
| `tokens.json` | OAuth tokens (auto-refreshed) |
