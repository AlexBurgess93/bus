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
let busUpdateTimerId = null;
let busUpdateTimerId = null;
let hasWarnedAboutNoActiveTrips = false;

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
  selectionPanel.classList.remove("is-hidden");
  setTimeout(() => {
    map.invalidateSize();
  }, 0);
}

function hideSelectionPanel() {
  selectionPanel.classList.add("is-hidden");
  selectionPanelContent.innerHTML = `
    <div class="panel-empty">
      Select a stop or bus to see details.
    </div>
  `;
  selectedPanelType = null;
  setTimeout(() => {
    map.invalidateSize();
  }, 0);
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

function renderBusPanel(trip) {
  selectedPanelType = "bus";

  const latestPosition = latestTripPositionsByTripId[trip.tripId];
  const betweenText = latestPosition
    ? `${latestPosition.stopA?.name || "Unknown stop"} → ${latestPosition.stopB?.name || "Unknown stop"}`
    : "Between stops unavailable";

  selectionPanelContent.innerHTML = `
    <section class="panel-section bus-panel-section">
      <div class="bus-summary-row">
        <div class="route-badge">${escapeHTML(trip.routeShortName)}</div>

        <div class="panel-text-stack">
          <div class="panel-subtitle">Destination</div>
          <div class="panel-title">${escapeHTML(trip.headsign)}</div>
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

function resetStopMarkerStyles() {
  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    marker.setStyle({
      radius: 4,
      color: "#64748b",
      weight: 1,
      fillColor: "#2563eb",
      fillOpacity: 0.8,
      opacity: 1
    });

    marker.bringToFront();
  });
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

function chooseServiceDayOffset() {
  const clockSeconds = getClockSecondsPrecise();
  const activeToday = countActiveTripsAtSeconds(clockSeconds);
  const activeAfterMidnightService = countActiveTripsAtSeconds(clockSeconds + 86400);

  // This matters after midnight because GTFS often represents 12:30am as 24:30:00,
  // while the device clock says 00:30:00.
  if (activeToday === 0 && activeAfterMidnightService > 0) {
    serviceDayOffsetSeconds = 86400;
  } else {
    serviceDayOffsetSeconds = 0;
  }

  console.log("Clock seconds:", Math.round(clockSeconds));
  console.log("Service day offset seconds:", serviceDayOffsetSeconds);
  console.log("Active trips at clock time:", activeToday);
  console.log("Active trips at GTFS after-midnight time:", activeAfterMidnightService);
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

function createBusIcon(isSelected = false) {
  return L.divIcon({
    className: "",
    html: `
      <div class="${isSelected ? "bus-icon selected" : "bus-icon"}">
        🚌
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function clearRouteLine() {
  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
    currentRouteLine = null;
  }
}

function drawTripShapeByShapeId(shapeId) {
  const shapeCoords = allShapes[shapeId];

  if (!shapeCoords) return;

  clearRouteLine();

  currentRouteLine = L.polyline(shapeCoords, {
    color: "#f59e0b",
    weight: 5,
    opacity: 0.92
  }).addTo(map);

  currentRouteLine.bringToBack();
}

function drawSpecificTripShape(trip) {
  drawTripShapeByShapeId(trip.shapeId);
}

function focusSelectedBus(tripId) {
  selectedTripId = tripId;
  selectedStopId = null;
  highlightedTripIds = new Set([tripId]);

  clearStopRouteLines();
  highlightFutureStopMarkersForTrip(tripId);

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];

    if (id === selectedTripId) {
      marker.setOpacity(1);
      marker.setIcon(createBusIcon(true));
      marker.setZIndexOffset(1200);
    } else {
      marker.setOpacity(0.15);
      marker.setIcon(createBusIcon(false));
      marker.setZIndexOffset(0);
    }
  });

  if (currentRouteLine) {
    currentRouteLine.bringToBack();
  }
}

function focusTripsForStop(stopId, upcomingItems) {
  selectedTripId = null;
  selectedStopId = stopId;
  highlightedTripIds = new Set(upcomingItems.map(item => item.tripId));

  Object.keys(busMarkersByTripId).forEach(tripId => {
    const marker = busMarkersByTripId[tripId];

    if (highlightedTripIds.has(tripId)) {
      marker.setOpacity(1);
      marker.setIcon(createBusIcon(true));
      marker.setZIndexOffset(1000);
    } else {
      marker.setOpacity(0.15);
      marker.setIcon(createBusIcon(false));
      marker.setZIndexOffset(0);
    }
  });
}

function focusSingleTrip(tripId) {
  selectedTripId = tripId;
  selectedStopId = null;
  highlightedTripIds = new Set([tripId]);

  clearStopRouteLines();
  highlightFutureStopMarkersForTrip(tripId);

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];

    if (id === tripId) {
      marker.setOpacity(1);
      marker.setIcon(createBusIcon(true));
      marker.setZIndexOffset(1200);
    } else {
      marker.setOpacity(0.15);
      marker.setIcon(createBusIcon(false));
      marker.setZIndexOffset(0);
    }
  });
}

function clearBusFocus() {
  selectedTripId = null;
  selectedStopId = null;
  highlightedTripIds = new Set();

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];

    marker.setOpacity(1);
    marker.setIcon(createBusIcon(false));
    marker.setZIndexOffset(500);
  });

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
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      color: "#64748b",
      weight: 1,
      fillColor: "#2563eb",
      fillOpacity: 0.8,
      opacity: 1
    }).addTo(map);

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
    const tripPosition = getTripPositionNow(trip, currentSeconds);

    if (!tripPosition) return;

    activeTripIds.add(trip.tripId);
    latestTripPositionsByTripId[trip.tripId] = tripPosition;

    if (busMarkersByTripId[trip.tripId]) {
      const marker = busMarkersByTripId[trip.tripId];

      marker.setLatLng(tripPosition.position);

      if (selectedTripId === trip.tripId) {
        marker.setOpacity(1);
        marker.setIcon(createBusIcon(true));
        marker.setZIndexOffset(1200);

        if (selectedPanelType === "bus") {
          renderBusPanel(trip);
        }
      } else if (highlightedTripIds.has(trip.tripId)) {
        marker.setOpacity(1);
        marker.setIcon(createBusIcon(true));
        marker.setZIndexOffset(1000);
      } else if (selectedTripId || selectedStopId) {
        marker.setOpacity(0.15);
        marker.setIcon(createBusIcon(false));
        marker.setZIndexOffset(0);
      } else {
        marker.setOpacity(1);
        marker.setIcon(createBusIcon(false));
        marker.setZIndexOffset(500);
      }
    } else {
      const marker = L.marker(tripPosition.position, {
        icon: createBusIcon(false),
        zIndexOffset: 500
      }).addTo(map);

      marker.on("click", event => {
        stopLeafletEvent(event);

        drawSpecificTripShape(trip);
        focusSelectedBus(trip.tripId);
        renderBusPanel(trip);
      });

      busMarkersByTripId[trip.tripId] = marker;
    }
  });

  Object.keys(busMarkersByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) {
      map.removeLayer(busMarkersByTripId[tripId]);
      delete busMarkersByTripId[tripId];
      delete latestTripPositionsByTripId[tripId];
    }
  });

  if (activeTripIds.size > 0) {
    hasWarnedAboutNoActiveTrips = false;
  } else if (!hasWarnedAboutNoActiveTrips) {
    console.warn(
      "No active timetable trips found for the current device time. Stops can still render while buses are empty if no trip is active right now."
    );
    hasWarnedAboutNoActiveTrips = true;
  }
}

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
  await loadCoreData();
  await loadStops();

  updateBusPositionsLive();

  busUpdateTimerId = window.setInterval(() => {
    updateBusPositionsLive();
  }, 1000);
}

init().catch(err => console.error(err));
