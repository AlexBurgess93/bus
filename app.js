const perth = [-31.9523, 115.8613];

const map = L.map("map").setView(perth, 11);

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
let currentPanelKey = "";

const selectionPanel = document.getElementById("selectionPanel");
const selectionPanelContent = document.getElementById("selectionPanelContent");
const closeSelectionPanelButton = document.getElementById("closeSelectionPanelButton");


function getFutureStopIdsForTrips(tripIds) {
  const futureStopIds = new Set();
  const currentSeconds = getCurrentSecondsPrecise();

  timetableTrips.forEach(trip => {
    if (!tripIds.has(trip.tripId)) return;
    if (!trip.stops || trip.stops.length === 0) return;

    const firstDepartureSeconds = timeToSeconds(trip.stops[0].departureTime);
    const lastArrivalSeconds = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

    // If the trip has not started yet, every stop on that trip is still in the future.
    if (currentSeconds < firstDepartureSeconds) {
      trip.stops.forEach(stopTime => {
        futureStopIds.add(stopTime.stopId);
      });
      return;
    }

    // If the trip has already finished, do not show any of its stops.
    if (currentSeconds > lastArrivalSeconds) {
      return;
    }

    let firstFutureStopIndex = trip.stops.findIndex(stopTime => {
      const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
      const departureSeconds = timeToSeconds(stopTime.departureTime);

      return arrivalSeconds >= currentSeconds || departureSeconds >= currentSeconds;
    });

    if (firstFutureStopIndex === -1) return;

    // If the bus has already departed this stop, start at the next stop.
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
      color: '#64748b',
      weight: 1,
      fillColor: '#2563eb',
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
        color: '#1d4ed8',
        weight: 3,
        fillColor: '#2563eb',
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    if (relevantStopIds.has(stopId)) {
      marker.setStyle({
        radius: 5,
        color: '#111827',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle({
      radius: 3,
      color: '#cbd5e1',
      weight: 1,
      fillColor: '#e5e7eb',
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

    // If the bus has already departed this stop, the relevant passenger-facing
    // stops start from the next stop onward.
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
        color: '#92400e',
        weight: 3,
        fillColor: '#f59e0b',
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    if (futureStopIds.has(stopId)) {
      marker.setStyle({
        radius: 5,
        color: '#111827',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle({
      radius: 3,
      color: '#cbd5e1',
      weight: 1,
      fillColor: '#e5e7eb',
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
      opacity: 0.55
    }).addTo(map);

    line.bringToBack();

    stopRouteLines.push(line);
  });
}

function timeToSeconds(timeString) {
  const [hours, minutes, seconds] = timeString.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function getCurrentSecondsPrecise() {
  const now = new Date();

  return (
    now.getHours() * 3600 +
    now.getMinutes() * 60 +
    now.getSeconds() +
    now.getMilliseconds() / 1000
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

function createBusIcon(isSelected = false) {
  return L.divIcon({
    className: "",
    html: `
      <div class="${isSelected ? "bus-icon selected" : "bus-icon"}">
        🚌
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15]
  });
}

function clearRouteLine() {
  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
    currentRouteLine = null;
  }
}

function focusSelectedBus(tripId) {
  selectedTripId = tripId;
  selectedStopId = null;
  highlightedTripIds = new Set([tripId]);

  // A bus selection should behave like its own clean selection state.
  // This removes any previous stop-selection path/stops view.
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

  // Selecting a specific upcoming trip should leave the stop view cleanly.
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
    event.originalEvent.preventDefault?.();
    event.originalEvent.stopPropagation?.();
  }
}

function stopBrowserEvent(event) {
  if (!event) return;
  event.stopPropagation();
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showSelectionPanel() {
  selectionPanel.classList.remove("is-hidden");
}

function hideSelectionPanel() {
  currentPanelKey = "";
  selectionPanel.classList.add("is-hidden");
  selectionPanelContent.innerHTML = `
    <div class="panel-empty">
      Select a stop or bus to see details.
    </div>
  `;
}

function renderStopInfoPanel(stop, upcoming) {
  currentPanelKey = `stop|${stop.id}|${upcoming.map(item => item.tripId).join(",")}`;
  const upcomingRows = upcoming.length
    ? upcoming.map(item => {
        const minsAway = formatMinutesAway(
          timeToSeconds(item.arrivalTime),
          getCurrentSecondsPrecise()
        );

        return `
          <button class="ticker-item" type="button" data-shape-id="${escapeHTML(item.shapeId)}" data-trip-id="${escapeHTML(item.tripId)}">
            <span class="ticker-route">${escapeHTML(item.routeShortName)}</span>
            <span class="ticker-time">${escapeHTML(minsAway)}</span>
            <span class="ticker-destination">${escapeHTML(item.headsign)}</span>
          </button>
        `;
      }).join("")
    : `<div class="ticker-empty">No MVP-route buses in the next 30 mins.</div>`;

  selectionPanelContent.innerHTML = `
    <section class="panel-section stop-panel">
      <div class="panel-kicker">Selected stop</div>
      <div class="panel-title">${escapeHTML(stop.name)}</div>
      <div class="panel-subtitle">Stop ID: ${escapeHTML(stop.id)}</div>

      <div class="ticker-shell" aria-label="Coming soon buses">
        <div class="ticker-label">Coming soon</div>
        <div class="ticker-window">
          <div class="ticker-track">
            ${upcomingRows}
            ${upcoming.length ? upcomingRows : ""}
          </div>
        </div>
      </div>
    </section>
  `;

  selectionPanelContent.querySelectorAll(".ticker-item").forEach(row => {
    row.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();

      const shapeId = row.getAttribute("data-shape-id");
      const tripId = row.getAttribute("data-trip-id");
      const trip = timetableTrips.find(item => item.tripId === tripId);

      drawTripShapeByShapeId(shapeId);
      focusSingleTrip(tripId);

      if (trip) {
        renderBusInfoPanel(trip, latestTripPositionsByTripId[tripId], true);
      }
    });
  });

  showSelectionPanel();
}

function renderBusInfoPanel(trip, tripPosition, forceRender = false) {
  const betweenText = tripPosition
    ? `${tripPosition.stopA.name} → ${tripPosition.stopB.name}`
    : "Position unavailable";

  const panelKey = `bus|${trip.tripId}|${betweenText}`;

  if (!forceRender && currentPanelKey === panelKey) {
    return;
  }

  currentPanelKey = panelKey;

  selectionPanelContent.innerHTML = `
    <section class="panel-section bus-panel">
      <div class="panel-kicker">Selected bus</div>
      <div class="bus-summary-row">
        <div>
          <div class="panel-title">Route ${escapeHTML(trip.routeShortName)}</div>
          <div class="panel-subtitle">Destination: ${escapeHTML(trip.headsign)}</div>
        </div>
      </div>

      <div class="between-card">
        <span class="between-label">Between</span>
        <span class="between-value">${escapeHTML(betweenText)}</span>
      </div>
    </section>
  `;

  showSelectionPanel();
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

  const upcoming = stopUpcoming[stopId] || [];

  return upcoming
    .filter(item => {
      const arrivalSeconds = timeToSeconds(item.arrivalTime);
      return arrivalSeconds >= currentSeconds && arrivalSeconds <= maxSeconds;
    })
    .slice(0, 8);
}

function drawTripShapeByShapeId(shapeId) {
  const shapeCoords = allShapes[shapeId];

  if (!shapeCoords) return;

  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
  }

  currentRouteLine = L.polyline(shapeCoords, {
    color: "#f59e0b",
    weight: 5,
    opacity: 0.9
  }).addTo(map);

  currentRouteLine.bringToBack();
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
  const stopRoutes = await stopRoutesRes.json();

  stopLookup = createStopLookup(stops);

  console.log("Stops loaded:", stops.length);

  stops.forEach(stop => {
    const routes = stopRoutes[stop.id] || [];

    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      color: '#64748b',
      weight: 1,
      fillColor: '#2563eb',
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

      renderStopInfoPanel(stop, upcoming);
    });
  });
}

function drawSpecificTripShape(trip) {
  const shapeCoords = allShapes[trip.shapeId];

  if (!shapeCoords) return;

  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
  }

  currentRouteLine = L.polyline(shapeCoords, {
    color: "#f59e0b",
    weight: 5,
    opacity: 0.9
  }).addTo(map);

  currentRouteLine.bringToBack();
}

function getTripPositionNow(trip, currentSeconds) {
  const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
  const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

  if (currentSeconds < firstStopTime || currentSeconds > lastStopTime) {
    return null;
  }

  for (let i = 0; i < trip.stops.length - 1; i++) {
    const currentStopTime = timeToSeconds(trip.stops[i].departureTime);
    const nextStopTime = timeToSeconds(trip.stops[i + 1].arrivalTime);

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

    if (selectedTripId === trip.tripId) {
      renderBusInfoPanel(trip, tripPosition);
    }

    if (busMarkersByTripId[trip.tripId]) {
      const marker = busMarkersByTripId[trip.tripId];

      marker.setLatLng(tripPosition.position);

      if (selectedTripId === trip.tripId) {
        marker.setOpacity(1);
        marker.setIcon(createBusIcon(true));
        marker.setZIndexOffset(1200);
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
        renderBusInfoPanel(trip, tripPosition, true);
      });


      busMarkersByTripId[trip.tripId] = marker;
    }
  });

  Object.keys(busMarkersByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) {
      map.removeLayer(busMarkersByTripId[tripId]);
      delete busMarkersByTripId[tripId];
    }
  });

  requestAnimationFrame(updateBusPositionsLive);
}

map.on("click", () => {
  resetAppView();
});

// Mobile Safari can treat some map taps differently from desktop clicks.
// This gives the map the same escape behaviour on touch devices.
map.on("touchstart", event => {
  const target = event.originalEvent?.target;

  // Do not reset when the user is touching a bus or stop marker.
  if (target?.closest?.(".leaflet-marker-icon, .leaflet-interactive")) {
    return;
  }

  resetAppView();
});


closeSelectionPanelButton.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  resetAppView();
});

selectionPanel.addEventListener("click", stopBrowserEvent);
selectionPanel.addEventListener("touchstart", stopBrowserEvent, { passive: true });

async function init() {
  await loadCoreData();
  await loadStops();

  requestAnimationFrame(updateBusPositionsLive);
}

init().catch(err => console.error(err));