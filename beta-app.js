const perth = [-31.9523, 115.8613];

const map = L.map("map", {
  closePopupOnClick: false
}).setView(perth, 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
}).addTo(map);

const USEFUL_ROUTES = [
  "24", "32", "33", "39",
  "72", "73",
  "176", "177", "178", "179",
  "270",
  "910", "930", "930X", "935", "940"
];

let currentRouteLine = null;
let selectedTripId = null;
let selectedStopId = null;
let highlightedTripIds = new Set();
let allShapes = {};
let allRoutes = [];
let allTrips = [];
let timetableTrips = [];
let stopUpcoming = {};
let stopLookup = {};
let busMarkersByTripId = {};
let stopMarkersByStopId = {};
let stopRouteLines = [];
let latestTripPositionsByTripId = {};
let selectedPanelType = null;
let activeTripIdsGlobal = new Set();
let serviceDayOffsetSeconds = 0;
let simulatedCurrentSecondsOverride = null;
let busUpdateTimerId = null;
let hasWarnedAboutNoActiveTrips = false;

let betaTrackingMode = "live";
let liveBusMarkersByTripId = {};
let latestLiveTripPositionsByTripId = {};
let ghostRouteSegmentLine = null;
let selectedBusVariant = "live";

const betaModeButtons = document.querySelectorAll(".beta-mode-button");

// Set this to false if you only ever want true real-time behaviour.
// When true, the prototype still shows buses if the current clock time has no active trips in the processed dataset.
const KEEP_PROTOTYPE_VISIBLE_WHEN_NO_REAL_TIME_BUSES = true;

const selectionPanel = document.getElementById("selectionPanel");
const selectionPanelContent = document.getElementById("selectionPanelContent");
const closeSelectionPanelButton = document.getElementById("closeSelectionPanelButton");

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showSelectionPanel() {
  // The panel is always present in the layout.
  // This prevents Leaflet from resizing/re-centering the map when content changes.
  selectionPanel.classList.add("has-selection");
}

function hideSelectionPanel() {
  selectionPanel.classList.remove("has-selection");
  selectionPanelContent.innerHTML = `
    <div class="panel-empty">
      <div class="panel-empty-title">Tap a stop or bus</div>
      <div class="panel-empty-subtitle">Details will appear here without shifting the map.</div>
    </div>
  `;
  selectedPanelType = null;
}

function renderStopPanel(stop, upcomingItems) {
  selectedPanelType = "stop";

  const upcomingHTML = upcomingItems.length
    ? upcomingItems.map(item => {
        const minsAway = formatMinutesAway(
          timeToSeconds(item.arrivalTime),
          getCurrentSecondsPrecise()
        );

        return `
          <button
            class="arrival-pill"
            type="button"
            data-shape-id="${escapeHTML(item.shapeId)}"
            data-trip-id="${escapeHTML(item.tripId)}"
            aria-label="Select route ${escapeHTML(item.routeShortName)} to ${escapeHTML(item.headsign)}, ${escapeHTML(minsAway)} away"
          >
            <span class="arrival-route">${escapeHTML(item.routeShortName)}</span>
            <span class="arrival-time">${escapeHTML(minsAway)}</span>
            <span class="arrival-destination">${escapeHTML(item.headsign)}</span>
          </button>
        `;
      }).join("")
    : `<div class="arrival-empty">No MVP-route buses in the next 30 mins.</div>`;

  selectionPanelContent.innerHTML = `
    <section class="panel-section stop-panel-section">
      <div class="panel-main-row">
        <div class="panel-text-stack">
          <div class="panel-title">${escapeHTML(stop.name)}</div>
          <div class="panel-subtitle">Stop ID: ${escapeHTML(stop.id)}</div>
        </div>
      </div>

      <div class="arrival-strip" aria-label="Upcoming buses">
        ${upcomingHTML}
      </div>
    </section>
  `;

  selectionPanelContent.querySelectorAll(".arrival-pill").forEach(button => {
    const selectUpcomingTrip = event => {
      event.preventDefault();
      event.stopPropagation();

      const shapeId = button.getAttribute("data-shape-id");
      const tripId = button.getAttribute("data-trip-id");
      const trip = timetableTrips.find(item => item.tripId === tripId);

      drawTripShapeByShapeId(shapeId);
      focusSingleTrip(tripId);

      if (trip) {
        renderBusPanel(trip);
      }
    };

    button.addEventListener("click", selectUpcomingTrip);
  });

  showSelectionPanel();
}

function getStableLiveDelaySeconds(tripId) {
  // Deterministic fake live-data offset for the beta demo.
  // Positive = live bus is behind schedule. Negative = live bus is ahead.
  let hash = 0;

  String(tripId).split("").forEach(char => {
    hash = ((hash << 5) - hash) + char.charCodeAt(0);
    hash |= 0;
  });

  const bucket = Math.abs(hash) % 7;
  const offsets = [-150, -90, -35, 0, 45, 105, 165];

  return offsets[bucket];
}

function getDelayStatus(delaySeconds) {
  if (delaySeconds <= -60) {
    return { label: "Ahead", className: "ahead", text: `${Math.abs(Math.round(delaySeconds / 60))} min ahead` };
  }

  if (delaySeconds >= 60) {
    return { label: "Behind", className: "behind", text: `${Math.round(delaySeconds / 60)} min behind` };
  }

  return { label: "On time", className: "on-time", text: "on time" };
}

function getDelayColour(delaySeconds) {
  const status = getDelayStatus(delaySeconds);

  if (status.className === "ahead") return "#16a34a";
  if (status.className === "behind") return "#f59e0b";
  return "#2563eb";
}

function getRoutePathColour() {
  return betaTrackingMode === "ghost" ? "#111827" : "#f59e0b";
}

function getRoutePathOpacity() {
  return betaTrackingMode === "ghost" ? 0.78 : 0.92;
}

function clearGhostRouteSegmentLine() {
  if (ghostRouteSegmentLine) {
    map.removeLayer(ghostRouteSegmentLine);
    ghostRouteSegmentLine = null;
  }
}

function getShapeSegmentBetweenPositions(shapeCoords, positionA, positionB) {
  if (!shapeCoords || shapeCoords.length < 2 || !positionA || !positionB) {
    return [];
  }

  const pointA = { lat: positionA[0], lon: positionA[1] };
  const pointB = { lat: positionB[0], lon: positionB[1] };

  const indexA = findClosestShapeIndex(shapeCoords, pointA);
  const indexB = findClosestShapeIndex(shapeCoords, pointB);
  const startIndex = Math.min(indexA, indexB);
  const endIndex = Math.max(indexA, indexB);

  const segment = shapeCoords.slice(startIndex, endIndex + 1);

  if (segment.length < 2) {
    return [positionA, positionB];
  }

  return [positionA, ...segment, positionB];
}

function drawGhostRouteSegmentForTrip(tripId) {
  clearGhostRouteSegmentLine();

  if (betaTrackingMode !== "ghost" || !tripId) return;

  const trip = timetableTrips.find(item => item.tripId === tripId);
  if (!trip) return;

  const scheduledPosition = latestTripPositionsByTripId[tripId];
  const livePosition = latestLiveTripPositionsByTripId[tripId];
  const shapeCoords = allShapes[trip.shapeId];

  if (!scheduledPosition?.position || !livePosition?.position || !shapeCoords) return;

  const delaySeconds = getStableLiveDelaySeconds(tripId);
  const segmentCoords = getShapeSegmentBetweenPositions(
    shapeCoords,
    scheduledPosition.position,
    livePosition.position
  );

  if (segmentCoords.length < 2) return;

  ghostRouteSegmentLine = L.polyline(segmentCoords, {
    color: getDelayColour(delaySeconds),
    weight: 7,
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(map);

  ghostRouteSegmentLine.bringToFront();

  if (busMarkersByTripId[tripId]) busMarkersByTripId[tripId].setZIndexOffset(1200);
  if (liveBusMarkersByTripId[tripId]) liveBusMarkersByTripId[tripId].setZIndexOffset(1300);
}

function renderBusPanel(trip, variant = selectedBusVariant) {
  selectedPanelType = "bus";

  const latestPosition = latestTripPositionsByTripId[trip.tripId];
  const betweenText = latestPosition
    ? `${latestPosition.stopA?.name || "Unknown stop"} → ${latestPosition.stopB?.name || "Unknown stop"}`
    : "Between stops unavailable";

  const delaySeconds = getStableLiveDelaySeconds(trip.tripId);
  const delayStatus = getDelayStatus(delaySeconds);
  const variantLabel = variant === "scheduled" ? "Scheduled position" : "Simulated live position";

  selectionPanelContent.innerHTML = `
    <section class="panel-section bus-panel-section">
      <div class="bus-summary-row">
        <div class="route-badge">${escapeHTML(trip.routeShortName)}</div>

        <div class="panel-text-stack">
          <div class="panel-subtitle">${escapeHTML(variantLabel)}</div>
          <div class="panel-title">${escapeHTML(trip.headsign)}</div>
        </div>

        <div class="beta-delay-chip ${escapeHTML(delayStatus.className)}">
          ${escapeHTML(delayStatus.text)}
        </div>
      </div>

      <div class="between-card">
        <div class="between-label">Between</div>
        <div class="between-value">${escapeHTML(betweenText)}</div>
      </div>
    </section>
  `;

  showSelectionPanel();
}

function getFutureStopIdsForTrips(tripIds) {
  const futureStopIds = new Set();
  const currentSeconds = getCurrentSecondsPrecise();

  timetableTrips.forEach(trip => {
    if (!tripIds.has(trip.tripId)) return;
    if (!trip.stops || trip.stops.length === 0) return;

    const firstDepartureSeconds = timeToSeconds(trip.stops[0].departureTime);
    const lastArrivalSeconds = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

    if (currentSeconds < firstDepartureSeconds) {
      trip.stops.forEach(stopTime => {
        futureStopIds.add(stopTime.stopId);
      });
      return;
    }

    if (currentSeconds > lastArrivalSeconds) return;

    let firstFutureStopIndex = trip.stops.findIndex(stopTime => {
      const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
      const departureSeconds = timeToSeconds(stopTime.departureTime);

      return arrivalSeconds >= currentSeconds || departureSeconds >= currentSeconds;
    });

    if (firstFutureStopIndex === -1) return;

    const firstFutureStop = trip.stops[firstFutureStopIndex];
    const firstFutureDepartureSeconds = timeToSeconds(firstFutureStop.departureTime);

    if (currentSeconds > firstFutureDepartureSeconds) {
      firstFutureStopIndex += 1;
    }

    for (let i = firstFutureStopIndex; i < trip.stops.length; i++) {
      futureStopIds.add(trip.stops[i].stopId);
    }
  });

  return futureStopIds;
}

function getDefaultStopStyleForZoom(zoom = map.getZoom()) {
  // Stops should act like background texture when zoomed out,
  // then become clearer and easier to tap as the user zooms in.
  if (zoom <= 11) {
    return {
      radius: 1.6,
      color: "#94a3b8",
      weight: 1,
      fillColor: "#2563eb",
      fillOpacity: 0.22,
      opacity: 0.22
    };
  }

  if (zoom <= 13) {
    return {
      radius: 2.6,
      color: "#64748b",
      weight: 1,
      fillColor: "#2563eb",
      fillOpacity: 0.42,
      opacity: 0.45
    };
  }

  if (zoom <= 15) {
    return {
      radius: 3.6,
      color: "#64748b",
      weight: 1,
      fillColor: "#2563eb",
      fillOpacity: 0.68,
      opacity: 0.75
    };
  }

  return {
    radius: 5,
    color: "#475569",
    weight: 1.25,
    fillColor: "#2563eb",
    fillOpacity: 0.85,
    opacity: 1
  };
}

function applyDefaultStopMarkerStylesForZoom() {
  const style = getDefaultStopStyleForZoom();

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];
    marker.setStyle(style);
  });
}

function resetStopMarkerStyles() {
  applyDefaultStopMarkerStylesForZoom();
}

function highlightRelevantStopMarkers(selectedStopId, upcomingItems) {
  const tripIds = new Set(upcomingItems.map(item => item.tripId));
  const relevantStopIds = getFutureStopIdsForTrips(tripIds);

  relevantStopIds.add(selectedStopId);

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    if (stopId === selectedStopId) {
      marker.setStyle({
        radius: 8,
        color: "#1d4ed8",
        weight: 3,
        fillColor: "#2563eb",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    if (relevantStopIds.has(stopId)) {
      marker.setStyle({
        radius: 5,
        color: "#111827",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle({
      radius: 3,
      color: "#cbd5e1",
      weight: 1,
      fillColor: "#e5e7eb",
      fillOpacity: 0.08,
      opacity: 0.12
    });
  });
}

function getFutureStopDetailsForTrip(tripId) {
  const trip = timetableTrips.find(item => item.tripId === tripId);

  if (!trip || !trip.stops || trip.stops.length === 0) {
    return {
      trip: null,
      futureStopIds: new Set(),
      nextStopId: null
    };
  }

  const currentSeconds = getCurrentSecondsPrecise();
  const firstDepartureSeconds = timeToSeconds(trip.stops[0].departureTime);
  const lastArrivalSeconds = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

  if (currentSeconds > lastArrivalSeconds) {
    return {
      trip,
      futureStopIds: new Set(),
      nextStopId: null
    };
  }

  let firstFutureStopIndex = 0;

  if (currentSeconds >= firstDepartureSeconds) {
    firstFutureStopIndex = trip.stops.findIndex(stopTime => {
      const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
      const departureSeconds = timeToSeconds(stopTime.departureTime);

      return arrivalSeconds >= currentSeconds || departureSeconds >= currentSeconds;
    });

    if (firstFutureStopIndex === -1) {
      return {
        trip,
        futureStopIds: new Set(),
        nextStopId: null
      };
    }

    const firstFutureStop = trip.stops[firstFutureStopIndex];
    const firstFutureDepartureSeconds = timeToSeconds(firstFutureStop.departureTime);

    if (currentSeconds > firstFutureDepartureSeconds) {
      firstFutureStopIndex += 1;
    }
  }

  const futureStopIds = new Set();

  for (let i = firstFutureStopIndex; i < trip.stops.length; i++) {
    futureStopIds.add(trip.stops[i].stopId);
  }

  return {
    trip,
    futureStopIds,
    nextStopId: trip.stops[firstFutureStopIndex]?.stopId || null
  };
}

function highlightFutureStopMarkersForTrip(tripId) {
  const { futureStopIds, nextStopId } = getFutureStopDetailsForTrip(tripId);

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    if (stopId === nextStopId) {
      marker.setStyle({
        radius: 7,
        color: "#92400e",
        weight: 3,
        fillColor: "#f59e0b",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    if (futureStopIds.has(stopId)) {
      marker.setStyle({
        radius: 5,
        color: "#111827",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle({
      radius: 3,
      color: "#cbd5e1",
      weight: 1,
      fillColor: "#e5e7eb",
      fillOpacity: 0.08,
      opacity: 0.12
    });
  });
}

function clearStopRouteLines() {
  stopRouteLines.forEach(line => {
    map.removeLayer(line);
  });

  stopRouteLines = [];
}

function drawStopUpcomingPaths(upcomingItems) {
  clearStopRouteLines();

  const uniqueShapeIds = [...new Set(upcomingItems.map(item => item.shapeId))];

  uniqueShapeIds.forEach(shapeId => {
    const shapeCoords = allShapes[shapeId];

    if (!shapeCoords) return;

    const line = L.polyline(shapeCoords, {
      color: "#94a3b8",
      weight: 4,
      opacity: 0.58
    }).addTo(map);

    line.bringToBack();

    stopRouteLines.push(line);
  });
}

function timeToSeconds(timeString) {
  if (!timeString || typeof timeString !== "string") return NaN;

  const [hours, minutes, seconds] = timeString.split(":").map(Number);

  if ([hours, minutes, seconds].some(value => Number.isNaN(value))) {
    return NaN;
  }

  // GTFS can legally use times past midnight, e.g. 24:12:00 or 25:03:00.
  return hours * 3600 + minutes * 60 + seconds;
}

function getClockSecondsPrecise() {
  const now = new Date();

  return (
    now.getHours() * 3600 +
    now.getMinutes() * 60 +
    now.getSeconds() +
    now.getMilliseconds() / 1000
  );
}

function getCurrentSecondsPrecise() {
  if (simulatedCurrentSecondsOverride !== null) {
    return simulatedCurrentSecondsOverride;
  }

  return getClockSecondsPrecise() + serviceDayOffsetSeconds;
}

function tripIsActiveAtSeconds(trip, currentSeconds) {
  if (!trip?.stops?.length) return false;

  const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
  const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

  if (Number.isNaN(firstStopTime) || Number.isNaN(lastStopTime)) return false;

  return currentSeconds >= firstStopTime && currentSeconds <= lastStopTime;
}

function countActiveTripsAtSeconds(currentSeconds) {
  let count = 0;

  timetableTrips.forEach(trip => {
    if (tripIsActiveAtSeconds(trip, currentSeconds)) {
      count += 1;
    }
  });

  return count;
}

function findNearestInServiceSecond(clockSeconds) {
  let best = null;

  timetableTrips.forEach(trip => {
    if (!trip?.stops?.length) return;

    const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
    const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

    if (Number.isNaN(firstStopTime) || Number.isNaN(lastStopTime)) return;

    const candidates = [];

    if (clockSeconds < firstStopTime) {
      candidates.push(firstStopTime + 60);
    } else if (clockSeconds > lastStopTime) {
      candidates.push(Math.max(firstStopTime, lastStopTime - 60));
    } else {
      candidates.push(clockSeconds);
    }

    candidates.forEach(candidateSeconds => {
      const distance = Math.min(
        Math.abs(candidateSeconds - clockSeconds),
        Math.abs(candidateSeconds - (clockSeconds + 86400)),
        Math.abs(candidateSeconds - (clockSeconds - 86400))
      );

      if (!best || distance < best.distance) {
        best = {
          seconds: candidateSeconds,
          distance
        };
      }
    });
  });

  return best ? best.seconds : null;
}

function chooseServiceDayOffset() {
  const clockSeconds = getClockSecondsPrecise();

  const candidates = [
    { label: "device clock", offset: 0, seconds: clockSeconds },
    { label: "GTFS after-midnight service day", offset: 86400, seconds: clockSeconds + 86400 },
    { label: "previous service day", offset: -86400, seconds: clockSeconds - 86400 }
  ];

  const scoredCandidates = candidates.map(candidate => ({
    ...candidate,
    activeTrips: countActiveTripsAtSeconds(candidate.seconds)
  }));

  scoredCandidates.sort((a, b) => b.activeTrips - a.activeTrips);

  const bestCandidate = scoredCandidates[0];

  simulatedCurrentSecondsOverride = null;

  if (bestCandidate && bestCandidate.activeTrips > 0) {
    serviceDayOffsetSeconds = bestCandidate.offset;

    console.log("Using timetable time source:", bestCandidate.label);
    console.log("Active trips:", bestCandidate.activeTrips);
    console.log("Clock seconds:", Math.round(clockSeconds));
    console.log("Service day offset seconds:", serviceDayOffsetSeconds);
    return;
  }

  serviceDayOffsetSeconds = 0;

  if (KEEP_PROTOTYPE_VISIBLE_WHEN_NO_REAL_TIME_BUSES) {
    const nearestInServiceSecond = findNearestInServiceSecond(clockSeconds);

    if (nearestInServiceSecond !== null) {
      simulatedCurrentSecondsOverride = nearestInServiceSecond;

      console.warn(
        "No trips were active at the device clock time, so the prototype is showing the nearest in-service timetable moment instead.",
        {
          deviceClockSeconds: Math.round(clockSeconds),
          simulatedTimetableSeconds: Math.round(simulatedCurrentSecondsOverride),
          activeTripsAtSimulatedTime: countActiveTripsAtSeconds(simulatedCurrentSecondsOverride)
        }
      );
      return;
    }
  }

  console.warn(
    "No active trips found for the device time, after-midnight time, previous service day, or nearest-service fallback."
  );
}

function createStopLookup(stops) {
  const lookup = {};

  stops.forEach(stop => {
    lookup[stop.id] = stop;
  });

  return lookup;
}

function distanceBetweenPoints(a, b) {
  const latDiff = a[0] - b[0];
  const lonDiff = a[1] - b[1];

  return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
}

function findClosestShapeIndex(shapeCoords, stop) {
  let closestIndex = 0;
  let closestDistance = Infinity;

  const stopPoint = [stop.lat, stop.lon];

  for (let i = 0; i < shapeCoords.length; i++) {
    const distance = distanceBetweenPoints(shapeCoords[i], stopPoint);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = i;
    }
  }

  return closestIndex;
}

function interpolateAlongShape(shapeCoords, stopA, stopB, progress) {
  if (!shapeCoords || shapeCoords.length === 0) {
    return [stopA.lat, stopA.lon];
  }

  let startIndex = findClosestShapeIndex(shapeCoords, stopA);
  let endIndex = findClosestShapeIndex(shapeCoords, stopB);

  if (endIndex < startIndex) {
    const temp = startIndex;
    startIndex = endIndex;
    endIndex = temp;
    progress = 1 - progress;
  }

  const segment = shapeCoords.slice(startIndex, endIndex + 1);

  if (segment.length < 2) {
    return [
      stopA.lat + (stopB.lat - stopA.lat) * progress,
      stopA.lon + (stopB.lon - stopA.lon) * progress
    ];
  }

  const exactIndex = progress * (segment.length - 1);
  const lowerIndex = Math.floor(exactIndex);
  const upperIndex = Math.min(lowerIndex + 1, segment.length - 1);
  const localProgress = exactIndex - lowerIndex;

  const lowerPoint = segment[lowerIndex];
  const upperPoint = segment[upperIndex];

  return [
    lowerPoint[0] + (upperPoint[0] - lowerPoint[0]) * localProgress,
    lowerPoint[1] + (upperPoint[1] - lowerPoint[1]) * localProgress
  ];
}

function createBusIcon(isSelected = false, variant = "scheduled", delayClass = "on-time") {
  const classes = ["bus-icon"];

  if (isSelected) classes.push("selected");
  if (variant === "live") classes.push("live-bus-icon", delayClass);
  if (variant === "scheduled") classes.push("scheduled-bus-icon");

  const label = variant === "live" ? "L" : "S";

  return L.divIcon({
    className: "",
    html: `
      <div class="${classes.join(" ")}">
        <span class="bus-emoji">🚌</span>
        <span class="bus-mode-label">${label}</span>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
}

function setMarkerVisible(marker, visible) {
  if (!marker) return;

  marker.setOpacity(visible ? 1 : 0);

  const element = marker.getElement?.();
  if (element) {
    element.style.pointerEvents = visible ? "auto" : "none";
  }
}

function getScheduledMarkerOpacity(tripId) {
  if (betaTrackingMode === "live") return 0;
  if (selectedTripId && tripId !== selectedTripId) return 0.15;
  if (selectedStopId && !highlightedTripIds.has(tripId)) return 0.15;
  return betaTrackingMode === "ghost" ? 0.72 : 1;
}

function getLiveMarkerOpacity(tripId) {
  if (betaTrackingMode === "scheduled") return 0;
  if (selectedTripId && tripId !== selectedTripId) return 0.15;
  if (selectedStopId && !highlightedTripIds.has(tripId)) return 0.15;
  return 1;
}

function applyBetaMarkerVisibility() {
  Object.keys(busMarkersByTripId).forEach(tripId => {
    const marker = busMarkersByTripId[tripId];
    marker.setOpacity(getScheduledMarkerOpacity(tripId));

    const element = marker.getElement?.();
    if (element) {
      element.style.pointerEvents = betaTrackingMode === "live" ? "none" : "auto";
    }
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    const marker = liveBusMarkersByTripId[tripId];
    marker.setOpacity(getLiveMarkerOpacity(tripId));

    const element = marker.getElement?.();
    if (element) {
      element.style.pointerEvents = betaTrackingMode === "scheduled" ? "none" : "auto";
    }
  });
}

function clearRouteLine() {
  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
    currentRouteLine = null;
  }

  clearGhostRouteSegmentLine();
}

function drawTripShapeByShapeId(shapeId) {
  const shapeCoords = allShapes[shapeId];

  if (!shapeCoords) return;

  clearRouteLine();

  currentRouteLine = L.polyline(shapeCoords, {
    color: getRoutePathColour(),
    weight: 5,
    opacity: getRoutePathOpacity(),
    lineCap: "round",
    lineJoin: "round"
  }).addTo(map);

  currentRouteLine.bringToBack();
}

function drawSpecificTripShape(trip) {
  drawTripShapeByShapeId(trip.shapeId);
}

function focusSelectedBus(tripId, variant = selectedBusVariant) {
  selectedTripId = tripId;
  selectedStopId = null;
  selectedBusVariant = variant;
  highlightedTripIds = new Set([tripId]);

  clearStopRouteLines();
  highlightFutureStopMarkersForTrip(tripId);

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];
    const isSelected = id === selectedTripId && variant === "scheduled";

    marker.setIcon(createBusIcon(isSelected, "scheduled"));
    marker.setZIndexOffset(isSelected ? 1200 : 500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(id => {
    const marker = liveBusMarkersByTripId[id];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(id)).className;
    const isSelected = id === selectedTripId && variant === "live";

    marker.setIcon(createBusIcon(isSelected, "live", delayClass));
    marker.setZIndexOffset(isSelected ? 1300 : 700);
  });

  applyBetaMarkerVisibility();
  drawGhostRouteSegmentForTrip(tripId);

  if (currentRouteLine) {
    currentRouteLine.setStyle({
      color: getRoutePathColour(),
      opacity: getRoutePathOpacity()
    });
    currentRouteLine.bringToBack();
  }
}

function focusTripsForStop(stopId, upcomingItems) {
  selectedTripId = null;
  selectedStopId = stopId;
  highlightedTripIds = new Set(upcomingItems.map(item => item.tripId));

  Object.keys(busMarkersByTripId).forEach(tripId => {
    const marker = busMarkersByTripId[tripId];
    marker.setIcon(createBusIcon(highlightedTripIds.has(tripId), "scheduled"));
    marker.setZIndexOffset(highlightedTripIds.has(tripId) ? 1000 : 500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    const marker = liveBusMarkersByTripId[tripId];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(tripId)).className;
    marker.setIcon(createBusIcon(highlightedTripIds.has(tripId), "live", delayClass));
    marker.setZIndexOffset(highlightedTripIds.has(tripId) ? 1100 : 700);
  });

  applyBetaMarkerVisibility();
}

function focusSingleTrip(tripId) {
  selectedBusVariant = betaTrackingMode === "scheduled" ? "scheduled" : "live";
  focusSelectedBus(tripId, selectedBusVariant);
}

function clearBusFocus() {
  selectedTripId = null;
  selectedStopId = null;
  selectedBusVariant = betaTrackingMode === "scheduled" ? "scheduled" : "live";
  highlightedTripIds = new Set();

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];
    marker.setIcon(createBusIcon(false, "scheduled"));
    marker.setZIndexOffset(500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(id => {
    const marker = liveBusMarkersByTripId[id];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(id)).className;
    marker.setIcon(createBusIcon(false, "live", delayClass));
    marker.setZIndexOffset(700);
  });

  applyBetaMarkerVisibility();
  clearRouteLine();
  clearStopRouteLines();
  resetStopMarkerStyles();
}

function resetAppView() {
  clearBusFocus();
  hideSelectionPanel();
}

function stopLeafletEvent(event) {
  if (!event) return;

  L.DomEvent.stopPropagation(event);

  if (event.originalEvent) {
    L.DomEvent.stop(event.originalEvent);
  }
}

function formatMinutesAway(arrivalSeconds, currentSeconds) {
  const diffSeconds = arrivalSeconds - currentSeconds;
  const diffMinutes = Math.round(diffSeconds / 60);

  if (diffMinutes <= 0) return "due now";
  if (diffMinutes === 1) return "1 min";
  return `${diffMinutes} mins`;
}

function getUpcomingForStop(stopId, minutesAhead = 30) {
  const currentSeconds = getCurrentSecondsPrecise();
  const maxSeconds = currentSeconds + minutesAhead * 60;
  const duplicateWindowSeconds = 120;

  const upcoming = stopUpcoming[stopId] || [];

  const timeValidItems = upcoming
    .filter(item => {
      const arrivalSeconds = timeToSeconds(item.arrivalTime);
      return arrivalSeconds >= currentSeconds && arrivalSeconds <= maxSeconds;
    })
    .sort((a, b) => timeToSeconds(a.arrivalTime) - timeToSeconds(b.arrivalTime));

  const uniqueByTrip = [];
  const seenTripIds = new Set();

  timeValidItems.forEach(item => {
    if (seenTripIds.has(item.tripId)) return;
    seenTripIds.add(item.tripId);
    uniqueByTrip.push(item);
  });

  const deduped = [];

  uniqueByTrip.forEach(item => {
    const arrivalSeconds = timeToSeconds(item.arrivalTime);

    const duplicateIndex = deduped.findIndex(existing => {
      const existingArrivalSeconds = timeToSeconds(existing.arrivalTime);
      const sameRoute = existing.routeShortName === item.routeShortName;
      const sameDestination = existing.headsign === item.headsign;
      const sameShape = existing.shapeId === item.shapeId;
      const closeArrival = Math.abs(existingArrivalSeconds - arrivalSeconds) <= duplicateWindowSeconds;

      return sameRoute && sameDestination && sameShape && closeArrival;
    });

    if (duplicateIndex === -1) {
      deduped.push(item);
      return;
    }

    const existingArrivalSeconds = timeToSeconds(deduped[duplicateIndex].arrivalTime);

    if (arrivalSeconds < existingArrivalSeconds) {
      deduped[duplicateIndex] = item;
    }
  });

  return deduped
    .sort((a, b) => timeToSeconds(a.arrivalTime) - timeToSeconds(b.arrivalTime))
    .slice(0, 8);
}

async function loadCoreData() {
  const [routesRes, tripsRes, shapesRes, timetableRes, stopUpcomingRes] = await Promise.all([
    fetch("data/processed/routes.json"),
    fetch("data/processed/trips.json"),
    fetch("data/processed/shapes.json"),
    fetch("data/processed/trip-stop-times.json"),
    fetch("data/processed/stop-upcoming.json")
  ]);

  allRoutes = await routesRes.json();
  allTrips = await tripsRes.json();
  allShapes = await shapesRes.json();
  timetableTrips = await timetableRes.json();
  stopUpcoming = await stopUpcomingRes.json();

  chooseServiceDayOffset();

  console.log("Core data loaded");
  console.log("Routes:", allRoutes.length);
  console.log("Trips:", allTrips.length);
  console.log("Shapes:", Object.keys(allShapes).length);
  console.log("Filtered timetable trips:", timetableTrips.length);
  console.log("Stop upcoming records:", Object.keys(stopUpcoming).length);
}

async function loadStops() {
  console.log("Loading stops + stop routes...");

  const [stopsRes, stopRoutesRes] = await Promise.all([
    fetch("data/processed/stops.json"),
    fetch("data/processed/stop-routes.json")
  ]);

  const stops = await stopsRes.json();
  await stopRoutesRes.json();

  stopLookup = createStopLookup(stops);

  console.log("Stops loaded:", stops.length);

  stops.forEach(stop => {
    const marker = L.circleMarker(
      [stop.lat, stop.lon],
      getDefaultStopStyleForZoom()
    ).addTo(map);

    stopMarkersByStopId[stop.id] = marker;

    marker.on("click", event => {
      stopLeafletEvent(event);

      clearBusFocus();

      const upcoming = getUpcomingForStop(stop.id, 30);

      focusTripsForStop(stop.id, upcoming);
      drawStopUpcomingPaths(upcoming);
      highlightRelevantStopMarkers(stop.id, upcoming);
      renderStopPanel(stop, upcoming);
    });
  });
}

function getTripPositionNow(trip, currentSeconds) {
  if (!tripIsActiveAtSeconds(trip, currentSeconds)) {
    return null;
  }

  for (let i = 0; i < trip.stops.length - 1; i++) {
    const currentStopTime = timeToSeconds(trip.stops[i].departureTime);
    const nextStopTime = timeToSeconds(trip.stops[i + 1].arrivalTime);

    if (Number.isNaN(currentStopTime) || Number.isNaN(nextStopTime)) continue;

    if (currentSeconds >= currentStopTime && currentSeconds <= nextStopTime) {
      const stopA = stopLookup[trip.stops[i].stopId];
      const stopB = stopLookup[trip.stops[i + 1].stopId];

      if (!stopA || !stopB) return null;

      const segmentDuration = nextStopTime - currentStopTime;
      const elapsed = currentSeconds - currentStopTime;
      const progress = segmentDuration > 0 ? elapsed / segmentDuration : 0;

      const shapeCoords = allShapes[trip.shapeId];

      const position = interpolateAlongShape(
        shapeCoords,
        stopA,
        stopB,
        progress
      );

      return {
        position,
        stopA,
        stopB,
        progress,
        segmentIndex: i,
        nextStopIndex: i + 1
      };
    }
  }

  return null;
}

function updateBusPositionsLive() {
  const currentSeconds = getCurrentSecondsPrecise();
  const activeTripIds = new Set();

  timetableTrips.forEach(trip => {
    const scheduledPosition = getTripPositionNow(trip, currentSeconds);

    if (!scheduledPosition) return;

    activeTripIds.add(trip.tripId);
    latestTripPositionsByTripId[trip.tripId] = scheduledPosition;

    if (busMarkersByTripId[trip.tripId]) {
      busMarkersByTripId[trip.tripId].setLatLng(scheduledPosition.position);
    } else {
      const marker = L.marker(scheduledPosition.position, {
        icon: createBusIcon(false, "scheduled"),
        zIndexOffset: 500
      }).addTo(map);

      marker.on("click", event => {
        stopLeafletEvent(event);

        drawSpecificTripShape(trip);
        focusSelectedBus(trip.tripId, "scheduled");
        renderBusPanel(trip, "scheduled");
      });

      busMarkersByTripId[trip.tripId] = marker;
    }

    const delaySeconds = getStableLiveDelaySeconds(trip.tripId);
    const livePosition = getTripPositionNow(trip, currentSeconds - delaySeconds) || scheduledPosition;
    latestLiveTripPositionsByTripId[trip.tripId] = livePosition;
    const delayClass = getDelayStatus(delaySeconds).className;

    if (liveBusMarkersByTripId[trip.tripId]) {
      liveBusMarkersByTripId[trip.tripId].setLatLng(livePosition.position);
    } else {
      const marker = L.marker(livePosition.position, {
        icon: createBusIcon(false, "live", delayClass),
        zIndexOffset: 700
      }).addTo(map);

      marker.on("click", event => {
        stopLeafletEvent(event);

        drawSpecificTripShape(trip);
        focusSelectedBus(trip.tripId, "live");
        renderBusPanel(trip, "live");
      });

      liveBusMarkersByTripId[trip.tripId] = marker;
    }

    if (selectedTripId === trip.tripId && selectedPanelType === "bus") {
      renderBusPanel(trip, selectedBusVariant);
    }
  });

  Object.keys(busMarkersByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) {
      map.removeLayer(busMarkersByTripId[tripId]);
      delete busMarkersByTripId[tripId];
      delete latestTripPositionsByTripId[tripId];
    }
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) {
      map.removeLayer(liveBusMarkersByTripId[tripId]);
      delete liveBusMarkersByTripId[tripId];
      delete latestLiveTripPositionsByTripId[tripId];
    }
  });

  if (selectedTripId) {
    drawGhostRouteSegmentForTrip(selectedTripId);
  }

  activeTripIdsGlobal = activeTripIds;
  applyBetaMarkerVisibility();

  if (activeTripIds.size > 0) {
    hasWarnedAboutNoActiveTrips = false;
  } else if (!hasWarnedAboutNoActiveTrips) {
    console.warn(
      "No active timetable trips found for the selected timetable second. Check the logs from chooseServiceDayOffset().",
      { currentSeconds: Math.round(currentSeconds), serviceDayOffsetSeconds, simulatedCurrentSecondsOverride }
    );
    hasWarnedAboutNoActiveTrips = true;
  }
}

function setBetaTrackingMode(mode) {
  betaTrackingMode = mode;

  betaModeButtons.forEach(button => {
    button.classList.toggle("is-active", button.dataset.betaMode === mode);
  });

  if (mode === "scheduled") {
    selectedBusVariant = "scheduled";
  } else if (selectedBusVariant === "scheduled") {
    selectedBusVariant = "live";
  }

  if (currentRouteLine) {
    currentRouteLine.setStyle({
      color: getRoutePathColour(),
      opacity: getRoutePathOpacity()
    });
  }

  if (selectedTripId) {
    focusSelectedBus(selectedTripId, selectedBusVariant);
  } else {
    clearGhostRouteSegmentLine();
    applyBetaMarkerVisibility();
  }
}

betaModeButtons.forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    setBetaTrackingMode(button.dataset.betaMode);
  });
});

map.on("zoomend", () => {
  // Only restyle all stops when there is no active selection.
  // Selected stop/bus views deliberately override the default zoom styling.
  if (!selectedTripId && !selectedStopId) {
    applyDefaultStopMarkerStylesForZoom();
  }
});

map.on("click", () => {
  resetAppView();
});

closeSelectionPanelButton.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  resetAppView();
});

closeSelectionPanelButton.addEventListener("touchstart", event => {
  event.stopPropagation();
}, { passive: true });

selectionPanel.addEventListener("click", event => {
  event.stopPropagation();
});

selectionPanel.addEventListener("touchstart", event => {
  event.stopPropagation();
}, { passive: true });

async function init() {
  hideSelectionPanel();

  await loadCoreData();
  await loadStops();

  map.invalidateSize();
  updateBusPositionsLive();
  setBetaTrackingMode("live");

  busUpdateTimerId = window.setInterval(() => {
    updateBusPositionsLive();
  }, 1000);
}

init().catch(err => console.error(err));
