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

## Notes

- The app uses GTFS static schedule data plus trip update delays where available.
- For MARC and VRE, Union Station stop IDs are inferred from stop metadata in GTFS (`stops.txt`).
- If Amtraker changes endpoint schema, the API response will include a warning.
