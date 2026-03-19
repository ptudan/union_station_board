# Union Station Board

Simple web app to display arrivals/departures in the next hour at Washington Union Station from:

- Amtrak (via Amtraker endpoint candidates)
- MARC (GTFS + GTFS-RT)
- VRE (GTFS + GTFS-RT)

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3111`.

## Pages

| URL | Description |
|-----|-------------|
| `http://localhost:3111` | Full arrivals/departures board with filters |
| `http://localhost:3111/ticker.html` | OBS overlay ticker (see below) |

## OBS Ticker Overlay

`/ticker.html` is a transparent ticker bar designed to be injected into OBS as a **Browser Source** on a vertical (phone-style) stream.

### Adding to OBS

1. In OBS, click **+** in the Sources panel and choose **Browser**.
2. Set the URL to `http://localhost:3111/ticker.html`.
3. Set **Width** to match your canvas width (e.g. `1080` for a 1080×1920 vertical stream).
4. Set **Height** to `52` — the ticker is exactly 52 px tall.
5. Check **Shutdown source when not visible** so it doesn't poll when off-stream.
6. Click **OK**, then drag the source to the top of your scene.

> The page background is fully transparent, so only the ticker bar itself renders over your content.

### Ticker behaviour

- Cycles through **Departures → Arrivals → Did You Know?** and repeats.
- Each run starts left-aligned, pauses briefly, then scrolls off to the left.
- The label badge drops down between segments to reveal the next category.
- Train data refreshes every 60 seconds in the background without interrupting the scroll.
- Each event shows the provider logo, estimated time, train ID/route, headsign, and a colour-coded delay badge.

### Tuning

Constants at the top of `ticker.html`:

| Constant | Default | Description |
|----------|---------|-------------|
| `SPEED_PX_S` | `80` | Scroll speed in pixels per second |
| `START_DWELL` | `2200` | Pause at start before scrolling (ms) |
| `END_DWELL` | `900` | Pause after content scrolls off (ms) |
| `FACT_DWELL` | `7000` | How long fun facts are shown (ms) |
| `WINDOW_MINS` | `60` | How far ahead to fetch trains (minutes) |

## Notes

- The app uses GTFS static schedule data plus trip update delays where available.
- For MARC and VRE, Union Station stop IDs are inferred from stop metadata in GTFS (`stops.txt`). VRE uses a parent station hierarchy — child platform stops are automatically included.
- Terminus stops (first or last in a trip) only emit the relevant event type — no duplicate arrivals and departures for the same train.
- If Amtraker changes endpoint schema, the API response will include a warning.
