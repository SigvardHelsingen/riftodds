# League player probabilities

A minimal League of Legends stats page focused on a single player.

## Setup

Put your Riot API key in `.env`:

```
RIOT_API_KEY=RGAPI-...
```

Then:

```
uv sync
uv run fastapi dev main.py
```

Open http://localhost:8000.

## Views

- **Landing**: current patch stats: objectives, side win rate, champion win/pick/ban rates and
  how safe a gold lead at 15 is. Filled by a background sampler.
- **Player**: profile, then tabs for Live game (when in one), Champions (vs your rank, with mastery),
  Draft (pick predictor, pocket picks), Habits and Win conditions (incl. comeback and close-out rates).
  Pick a range from the last 20 games up to the whole season; long ranges sync in the background.

## Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `RIOT_API_KEY` | – | required |
| `SEASON_START` | `2026-01-08` | first day of the ranked season |
| `SAMPLER` | `1` | `0` turns the patch sampler off |
| `SAMPLER_TARGET` | `10000` | games per patch before the sampler idles |
| `SAMPLER_PLAYERS` | `8` | players sampled in parallel per tier |
| `TIMELINE_LIMIT` | `100` | newest games per player that get a timeline (gold-lead stats) |

Rate limits are read from Riot's response headers, so any key works at its own limits.
PUUIDs are tied to the API key: when the key changes, the old `cache.db` is set aside
(`cache.db.<date>.old`, safe to delete) and a fresh cache is built.

## Users

The site is invite-only. Manage logins on the server:

```
uv run python auth.py add <username>      # prompts for a password
uv run python auth.py passwd <username>
uv run python auth.py remove <username>
uv run python auth.py list
```

Users and sessions are stored in `users.db` (not in git).
