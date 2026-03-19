import express from "express";
import AdmZip from "adm-zip";
import { parse as parseCsv } from "csv-parse/sync";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();
const PORT = process.env.PORT || 3111;
const TZ = "America/New_York";

const SOURCES = {
  marc: {
    provider: "MARC",
    gtfsUrl: "https://feeds.mta.maryland.gov/gtfs/marc",
    tripUpdatesUrl: "https://mdotmta-gtfs-rt.s3.amazonaws.com/MARC+RT/marc-tu.pb"
  },
  vre: {
    provider: "VRE",
    gtfsUrl: "https://gtfs.vre.org/containercdngtfsupload/google_transit.zip",
    tripUpdatesUrl: "https://gtfs.vre.org/containercdngtfsupload/TripUpdateFeed"
  }
};

const AMTRAKER_CANDIDATE_URLS = [
  "https://api-v3.amtraker.com/v3/stations/WAS/trains",
  "https://api-v3.amtraker.com/v3/stations/was/trains",
  "https://api-v3.amtraker.com/v3/trains"
];

const gtfsCache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

function nowInEastern() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: TZ }));
}

function yyyymmdd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function parseGtfsTimeToSeconds(gtfsTime) {
  if (!gtfsTime) return null;
  const [h, m, s] = gtfsTime.split(":").map(Number);
  if ([h, m, s].some(Number.isNaN)) return null;
  return h * 3600 + m * 60 + s;
}

function parseCsvFromZip(zip, entryName) {
  const entry = zip.getEntry(entryName);
  if (!entry) return [];
  return parseCsv(entry.getData().toString("utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

function safeLower(value) {
  return String(value || "").toLowerCase();
}

const UNION_STOP_MATCHERS = {
  // MARC uses "UNION STATION MARC Washington" with city/code identifiers.
  marc(stop) {
    const name = safeLower(stop.stop_name);
    if (!name.includes("union") || !name.includes("station")) return false;
    const desc = safeLower(stop.stop_desc);
    const city = safeLower(stop.stop_city);
    const code = safeLower(stop.stop_code);
    const parent = safeLower(stop.parent_station);
    return (
      name.includes("washington") ||
      desc.includes("washington") ||
      city === "washington" ||
      code === "was" ||
      parent.includes("was")
    );
  },
  // VRE uses a bare "Union Station" parent stop (location_type 1) with no city metadata.
  // Timed stop_times reference child platform stops parented to it.
  vre(stop) {
    const name = safeLower(stop.stop_name);
    return name.trim() === "union station" && stop.location_type === "1";
  }
};

function serviceRunsOnDate(calendarRow, date) {
  if (!calendarRow) return false;
  const dateKey = yyyymmdd(date);
  if (dateKey < calendarRow.start_date || dateKey > calendarRow.end_date) {
    return false;
  }
  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];
  const weekdayKey = weekdays[date.getDay()];
  return calendarRow[weekdayKey] === "1";
}

function parseCalendarDates(calendarDatesRows) {
  const byService = new Map();
  for (const row of calendarDatesRows) {
    const serviceId = row.service_id;
    if (!byService.has(serviceId)) {
      byService.set(serviceId, new Map());
    }
    byService
      .get(serviceId)
      .set(row.date, row.exception_type === "1" ? "add" : "remove");
  }
  return byService;
}

function isServiceActive(serviceId, date, calendarsByService, calendarDatesByService) {
  const dateKey = yyyymmdd(date);
  const exceptions = calendarDatesByService.get(serviceId);
  if (exceptions && exceptions.has(dateKey)) {
    return exceptions.get(dateKey) === "add";
  }
  return serviceRunsOnDate(calendarsByService.get(serviceId), date);
}

function buildProviderData(provider, providerKey, rows) {
  const stops = rows.stops;
  const isUnionStop = UNION_STOP_MATCHERS[providerKey];
  const unionParentStopIds = new Set(stops.filter(isUnionStop).map((s) => s.stop_id));
  const unionStopIds = new Set(unionParentStopIds);
  for (const stop of stops) {
    if (unionParentStopIds.has(stop.parent_station)) {
      unionStopIds.add(stop.stop_id);
    }
  }
  const stopLookup = new Map(stops.map((s) => [s.stop_id, s]));

  const routesById = new Map(rows.routes.map((r) => [r.route_id, r]));
  const tripsById = new Map(rows.trips.map((t) => [t.trip_id, t]));
  const calendarsByService = new Map(rows.calendar.map((c) => [c.service_id, c]));
  const calendarDatesByService = parseCalendarDates(rows.calendar_dates);

  // Track min/max stop_sequence across all stops for each trip so we can
  // tell whether a Union Station stop is a terminus (first or last stop).
  const tripSequenceRange = new Map();
  for (const st of rows.stop_times) {
    const seq = Number(st.stop_sequence || 0);
    const existing = tripSequenceRange.get(st.trip_id);
    if (!existing) {
      tripSequenceRange.set(st.trip_id, { min: seq, max: seq });
    } else {
      if (seq < existing.min) existing.min = seq;
      if (seq > existing.max) existing.max = seq;
    }
  }

  const stopEvents = rows.stop_times
    .filter((st) => unionStopIds.has(st.stop_id))
    .map((st) => {
      const seq = Number(st.stop_sequence || 0);
      const range = tripSequenceRange.get(st.trip_id);
      const isFirstStop = range && seq === range.min;
      const isLastStop  = range && seq === range.max;
      return {
        tripId: st.trip_id,
        stopId: st.stop_id,
        // At a terminus only one direction is meaningful: suppress the
        // departure when it's the last stop and the arrival when it's the first.
        arrivalSecs:   isFirstStop ? null : parseGtfsTimeToSeconds(st.arrival_time),
        departureSecs: isLastStop  ? null : parseGtfsTimeToSeconds(st.departure_time),
        stopSequence: seq
      };
    })
    .filter((st) => st.arrivalSecs !== null || st.departureSecs !== null);

  return {
    provider,
    unionStopIds,
    stopLookup,
    routesById,
    tripsById,
    calendarsByService,
    calendarDatesByService,
    stopEvents
  };
}

async function loadProviderData(key) {
  const source = SOURCES[key];
  const cached = gtfsCache.get(key);
  if (cached && Date.now() - cached.loadedAt < CACHE_MS) {
    return cached.data;
  }

  const res = await fetch(source.gtfsUrl);
  if (!res.ok) {
    throw new Error(`${source.provider} GTFS fetch failed: ${res.status}`);
  }
  const zipBuffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(zipBuffer);

  const rows = {
    stops: parseCsvFromZip(zip, "stops.txt"),
    routes: parseCsvFromZip(zip, "routes.txt"),
    trips: parseCsvFromZip(zip, "trips.txt"),
    stop_times: parseCsvFromZip(zip, "stop_times.txt"),
    calendar: parseCsvFromZip(zip, "calendar.txt"),
    calendar_dates: parseCsvFromZip(zip, "calendar_dates.txt")
  };

  const data = buildProviderData(source.provider, key, rows);
  gtfsCache.set(key, { loadedAt: Date.now(), data });
  return data;
}

async function fetchRealtimeDelays(tripUpdatesUrl) {
  const res = await fetch(tripUpdatesUrl);
  if (!res.ok) return new Map();
  const buffer = Buffer.from(await res.arrayBuffer());
  const decoded = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  const map = new Map();
  for (const entity of decoded.entity || []) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate?.trip?.tripId) continue;
    const tripId = tripUpdate.trip.tripId;
    for (const stu of tripUpdate.stopTimeUpdate || []) {
      const stopId = stu.stopId;
      if (!stopId) continue;
      map.set(`${tripId}:${stopId}`, {
        arrivalDelay: stu.arrival?.delay ?? null,
        departureDelay: stu.departure?.delay ?? null
      });
    }
  }
  return map;
}

function buildRailEventsForWindow(providerData, realtimeMap, windowStart, windowEnd, serviceDate) {
  const events = [];
  const midnight = new Date(serviceDate);
  midnight.setHours(0, 0, 0, 0);

  for (const stopEvent of providerData.stopEvents) {
    const trip = providerData.tripsById.get(stopEvent.tripId);
    if (!trip) continue;

    if (
      !isServiceActive(
        trip.service_id,
        serviceDate,
        providerData.calendarsByService,
        providerData.calendarDatesByService
      )
    ) {
      continue;
    }

    const route = providerData.routesById.get(trip.route_id);
    const stop = providerData.stopLookup.get(stopEvent.stopId);
    const realtime = realtimeMap.get(`${stopEvent.tripId}:${stopEvent.stopId}`);

    const candidates = [
      {
        type: "arrival",
        secs: stopEvent.arrivalSecs,
        delaySecs: realtime?.arrivalDelay ?? 0
      },
      {
        type: "departure",
        secs: stopEvent.departureSecs,
        delaySecs: realtime?.departureDelay ?? 0
      }
    ];

    for (const candidate of candidates) {
      if (candidate.secs === null) continue;
      const scheduled = new Date(midnight.getTime() + candidate.secs * 1000);
      if (scheduled < windowStart || scheduled > windowEnd) continue;

      const estimated = new Date(scheduled.getTime() + candidate.delaySecs * 1000);
      events.push({
        provider: providerData.provider,
        mode: "rail",
        trainId: trip.trip_short_name || trip.trip_headsign || stopEvent.tripId,
        route: route?.route_short_name || route?.route_long_name || "",
        headsign: trip.trip_headsign || "",
        // Prefer parent stop name (e.g. VRE child stops are platform numbers like "22", "Lead").
        station:
          (stop?.parent_station && providerData.stopLookup.get(stop.parent_station)?.stop_name) ||
          stop?.stop_name ||
          "Washington Union Station",
        eventType: candidate.type,
        scheduledTime: scheduled.toISOString(),
        estimatedTime: estimated.toISOString(),
        delayMinutes: Math.round(candidate.delaySecs / 60)
      });
    }
  }
  return events;
}

function parseAmtrakerDate(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function normalizeAmtrakerStationEventTrain(train) {
  const trainNo = train.trainNum || train.train_num || train.number || train.trainNumber;
  const route = train.routeName || train.route || train.route_name || "";
  const headsign = train.destName || train.destination || train.dest || "";

  const arr = parseAmtrakerDate(
    train.estArr || train.estimated_arrival || train.schArr || train.scheduled_arrival
  );
  const dep = parseAmtrakerDate(
    train.estDep || train.estimated_departure || train.schDep || train.scheduled_departure
  );
  const schArr = parseAmtrakerDate(train.schArr || train.scheduled_arrival);
  const schDep = parseAmtrakerDate(train.schDep || train.scheduled_departure);

  const events = [];
  if (arr) {
    events.push({
      provider: "Amtrak",
      mode: "rail",
      trainId: trainNo || "Amtrak",
      route,
      headsign,
      station: "Washington Union Station",
      eventType: "arrival",
      scheduledTime: (schArr || arr).toISOString(),
      estimatedTime: arr.toISOString(),
      delayMinutes: schArr ? Math.round((arr.getTime() - schArr.getTime()) / 60000) : 0
    });
  }
  if (dep) {
    events.push({
      provider: "Amtrak",
      mode: "rail",
      trainId: trainNo || "Amtrak",
      route,
      headsign,
      station: "Washington Union Station",
      eventType: "departure",
      scheduledTime: (schDep || dep).toISOString(),
      estimatedTime: dep.toISOString(),
      delayMinutes: schDep ? Math.round((dep.getTime() - schDep.getTime()) / 60000) : 0
    });
  }
  return events;
}

function extractTrainsFromGlobalAmtrakerPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const trains = [];
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") trains.push(item);
      }
    }
  }
  return trains;
}

function normalizeAmtrakerGlobalTrain(train, stationCode = "WAS") {
  const station = (train.stations || []).find((stop) => stop.code === stationCode);
  if (!station) return [];

  const arr = parseAmtrakerDate(station.arr || station.estArr || station.schArr);
  const dep = parseAmtrakerDate(station.dep || station.estDep || station.schDep);
  const schArr = parseAmtrakerDate(station.schArr);
  const schDep = parseAmtrakerDate(station.schDep);

  const events = [];
  if (arr) {
    events.push({
      provider: "Amtrak",
      mode: "rail",
      trainId: train.trainNum || train.trainNumRaw || train.trainID || "Amtrak",
      route: train.routeName || "",
      headsign: train.destName || "",
      station: "Washington Union Station",
      eventType: "arrival",
      scheduledTime: (schArr || arr).toISOString(),
      estimatedTime: arr.toISOString(),
      delayMinutes: schArr ? Math.round((arr.getTime() - schArr.getTime()) / 60000) : 0
    });
  }
  if (dep) {
    events.push({
      provider: "Amtrak",
      mode: "rail",
      trainId: train.trainNum || train.trainNumRaw || train.trainID || "Amtrak",
      route: train.routeName || "",
      headsign: train.destName || "",
      station: "Washington Union Station",
      eventType: "departure",
      scheduledTime: (schDep || dep).toISOString(),
      estimatedTime: dep.toISOString(),
      delayMinutes: schDep ? Math.round((dep.getTime() - schDep.getTime()) / 60000) : 0
    });
  }
  return events;
}

async function fetchAmtrakEvents(windowStart, windowEnd) {
  // Preferred Amtraker feed with rich train+station payload.
  try {
    const globalRes = await fetch("https://api-v3.amtraker.com/v3/trains");
    if (globalRes.ok) {
      const globalPayload = await globalRes.json();
      const trains = extractTrainsFromGlobalAmtrakerPayload(globalPayload);
      const events = trains.flatMap((train) => normalizeAmtrakerGlobalTrain(train, "WAS"));
      const filtered = events.filter((event) => {
        const when = new Date(event.estimatedTime);
        return when >= windowStart && when <= windowEnd;
      });
      return { events: filtered, warning: null };
    }
  } catch (_error) {
    // Continue with fallback endpoints.
  }

  for (const url of AMTRAKER_CANDIDATE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const payload = await res.json();
      let trains = [];
      if (Array.isArray(payload?.trains)) trains = payload.trains;
      else if (Array.isArray(payload?.data)) trains = payload.data;
      else if (Array.isArray(payload)) trains = payload;
      const events = trains.flatMap(normalizeAmtrakerStationEventTrain).filter((event) => {
        const when = new Date(event.estimatedTime);
        return when >= windowStart && when <= windowEnd;
      });
      if (events.length > 0) return { events, warning: null };
    } catch (_error) {
      // Try the next candidate endpoint.
    }
  }
  return {
    events: [],
    warning: "Amtraker endpoint unavailable or schema changed."
  };
}

function sortEvents(events) {
  return [...events].sort(
    (a, b) => new Date(a.estimatedTime).getTime() - new Date(b.estimatedTime).getTime()
  );
}

app.use(express.static("public"));

app.get("/api/board", async (req, res) => {
  const warnings = [];
  const now = nowInEastern();
  const requestedWindow = Number.parseInt(String(req.query.windowMinutes || "60"), 10);
  const windowMinutes =
    Number.isFinite(requestedWindow) && requestedWindow >= 5 && requestedWindow <= 24 * 60
      ? requestedWindow
      : 60;
  const windowEnd = new Date(now.getTime() + windowMinutes * 60 * 1000);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const [marcResult, vreResult, amtrakResult] = await Promise.allSettled([
    loadProviderData("marc"),
    loadProviderData("vre"),
    fetchAmtrakEvents(now, windowEnd)
  ]);

  let marcEvents = [];
  let vreEvents = [];
  let amtrakEvents = [];

  if (amtrakResult.status === "fulfilled") {
    amtrakEvents = amtrakResult.value.events;
    if (amtrakResult.value.warning) warnings.push(amtrakResult.value.warning);
  } else {
    warnings.push(`Amtrak load failed: ${amtrakResult.reason?.message || amtrakResult.reason}`);
  }

  if (marcResult.status === "fulfilled") {
    let marcRt = new Map();
    try {
      marcRt = await fetchRealtimeDelays(SOURCES.marc.tripUpdatesUrl);
    } catch (_error) {
      warnings.push("MARC realtime feed unavailable.");
    }
    marcEvents = [
      ...buildRailEventsForWindow(marcResult.value, marcRt, now, windowEnd, now),
      ...buildRailEventsForWindow(marcResult.value, marcRt, now, windowEnd, yesterday)
    ];
  } else {
    warnings.push(`MARC load failed: ${marcResult.reason?.message || marcResult.reason}`);
  }

  if (vreResult.status === "fulfilled") {
    let vreRt = new Map();
    try {
      vreRt = await fetchRealtimeDelays(SOURCES.vre.tripUpdatesUrl);
    } catch (_error) {
      warnings.push("VRE realtime feed unavailable.");
    }
    vreEvents = [
      ...buildRailEventsForWindow(vreResult.value, vreRt, now, windowEnd, now),
      ...buildRailEventsForWindow(vreResult.value, vreRt, now, windowEnd, yesterday)
    ];
  } else {
    warnings.push(`VRE load failed: ${vreResult.reason?.message || vreResult.reason}`);
  }

  const allEvents = sortEvents([...amtrakEvents, ...marcEvents, ...vreEvents]);
  res.json({
    station: "Washington Union Station (WAS)",
    timezone: TZ,
    updatedAt: new Date().toISOString(),
    windowMinutes,
    warnings,
    events: allEvents
  });
});

app.listen(PORT, () => {
  console.log(`Union Station board: http://localhost:${PORT}`);
});
