// Trip Tracker main application
// Structure: map setup → state → UI rendering → map layers → data/time helpers → app lifecycle.

const perth = [-31.9523, 115.8613];

const map = L.map("map", {
  closePopupOnClick: false,
  preferCanvas: true
}).setView(perth, 11);

const mapTileLayers = {
  light: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
  }),
  dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
  })
};

const MAP_THEME_STORAGE_KEY = "tripTrackerMapTheme";
let currentMapTheme = localStorage.getItem(MAP_THEME_STORAGE_KEY) || "light";

if (!mapTileLayers[currentMapTheme]) {
  currentMapTheme = "light";
}

mapTileLayers[currentMapTheme].addTo(map);
document.documentElement.dataset.mapTheme = currentMapTheme;

const STOP_DOTS_MIN_ZOOM = 15;
const DETAILED_MARKER_MIN_ZOOM = 14;
const SERVICE_DOTS_MIN_ZOOM = 10;
const NETWORK_LAYER_MAX_ZOOM = 14;

let currentRouteLine = null;
let selectedTripId = null;
let selectedStopId = null;
let highlightedTripIds = new Set();
let allShapes = {};
let allRoutes = [];
let allTrips = [];
let timetableTrips = [];
let unfilteredTimetableTrips = [];
let stopUpcoming = {};
let unfilteredStopUpcoming = {};
let serviceCalendarRows = [];
let activeServiceIdsForToday = new Set();
let stopLookup = {};
let busMarkersByTripId = {};
let stopMarkersByStopId = {};
let stopHitMarkersByStopId = {};
let stopRouteLines = [];
let networkRouteLinesByShapeId = {};
let latestTripPositionsByTripId = {};
let selectedPanelType = null;
let serviceDayOffsetSeconds = 0;
let simulatedCurrentSecondsOverride = null;
let busUpdateTimerId = null;
let isMapMoving = false;
let mapRefreshTimeoutId = null;
const VEHICLE_UPDATE_INTERVAL_MS = 3000;
const MAP_SETTLE_REFRESH_DELAY_MS = 120;
let hasWarnedAboutNoActiveTrips = false;
let userLocationMarker = null;

let trackingMode = "scheduled";
let liveBusMarkersByTripId = {};
let latestLiveTripPositionsByTripId = {};
let ghostRouteSegmentLine = null;
let selectedBusVariant = "live";
let transportModeFilter = "all";
const PIN_STORAGE_KEY = "transitPinnedNetworkV1";
let pinnedRouteIds = new Set();
let pinnedStopIds = new Set();
let pinnedViewEnabled = false;
let activeMapPinMarker = null;
let tripLookupByTripId = {};
let etaMarkers = [];

const trackingModeButtons = document.querySelectorAll(".tracking-mode-button");

// Set this to false if you only ever want true real-time behaviour.
// When true, the prototype still shows buses if the current clock time has no active trips in the processed dataset.
const KEEP_PROTOTYPE_VISIBLE_WHEN_NO_REAL_TIME_BUSES = true;

const selectionPanel = document.getElementById("selectionPanel");
const selectionPanelContent = document.getElementById("selectionPanelContent");
const closeSelectionPanelButton = document.getElementById("closeSelectionPanelButton");
const liveNoticeModal = document.getElementById("liveNoticeModal");
const liveNoticeOkButton = document.getElementById("liveNoticeOkButton");
const LIVE_NOTICE_SEEN_KEY = "tripTrackerLiveNoticeSeen";
const locateUserButton = document.getElementById("locateUserButton");
const themeToggleButton = document.getElementById("themeToggleButton");
const themeToggleIcon = document.getElementById("themeToggleIcon");



// ---------- Map theme controls ----------
function applyMapTheme(theme) {
  if (!mapTileLayers[theme] || theme === currentMapTheme) return;

  map.removeLayer(mapTileLayers[currentMapTheme]);
  mapTileLayers[theme].addTo(map);

  currentMapTheme = theme;
  localStorage.setItem(MAP_THEME_STORAGE_KEY, currentMapTheme);
  document.documentElement.dataset.mapTheme = currentMapTheme;
  updateThemeToggleButton();
}

function updateThemeToggleButton() {
  if (!themeToggleButton || !themeToggleIcon) return;

  const isDark = currentMapTheme === "dark";
  themeToggleButton.classList.toggle("is-active", isDark);
  themeToggleButton.setAttribute("aria-label", isDark ? "Enable light map" : "Enable dark map");
  themeToggleIcon.setAttribute("src", isDark ? "enable_light_mode.svg" : "enable_dark_mode.svg");
}

function toggleMapTheme() {
  applyMapTheme(currentMapTheme === "dark" ? "light" : "dark");
}


// ---------- Generic helpers ----------
function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


// ---------- Bottom context panel ----------
function showSelectionPanel() {
  // The panel is always present in the layout.
  // This prevents Leaflet from resizing/re-centering the map when content changes.
  selectionPanel.classList.add("has-selection");
}

function hideSelectionPanel() {
  selectionPanel.classList.remove("has-selection");
  selectedPanelType = null;
  renderDefaultContextPanel();
}


// ---------- Pinning and route filtering ----------
function getTripRouteKey(trip = {}) {
  const routeId = String(trip.routeId ?? "").trim();
  if (routeId) return routeId;

  const mode = getTransportMode(trip);
  const shortName = String(trip.routeShortName ?? "").trim();
  const longName = String(trip.routeLongName ?? "").trim();

  return `${mode}:${shortName}:${longName}`;
}

function getRouteDisplayNameForTrip(trip = {}) {
  const label = getTransportLabel(trip);
  const mode = getTransportMode(trip);

  if (mode === "train" || mode === "ferry") {
    return String(trip.routeLongName || trip.headsign || label || mode).trim();
  }

  return String(label || trip.routeShortName || trip.routeLongName || "Route").trim();
}

function readPinState() {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    pinnedRouteIds = new Set(Array.isArray(parsed.pinnedRouteIds) ? parsed.pinnedRouteIds : []);
    pinnedStopIds = new Set(Array.isArray(parsed.pinnedStopIds) ? parsed.pinnedStopIds : []);
    pinnedViewEnabled = Boolean(parsed.pinnedViewEnabled);
  } catch (error) {
    console.warn("Pinned network state could not be read.", error);
    pinnedRouteIds = new Set();
    pinnedStopIds = new Set();
    pinnedViewEnabled = false;
  }
}

function savePinState() {
  localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify({
    pinnedRouteIds: Array.from(pinnedRouteIds),
    pinnedStopIds: Array.from(pinnedStopIds),
    pinnedViewEnabled
  }));
}

function rebuildTripLookup() {
  tripLookupByTripId = {};

  timetableTrips.forEach(trip => {
    tripLookupByTripId[trip.tripId] = trip;
  });
}

function getPinnedRouteIdsFromStops() {
  const routeIds = new Set();

  pinnedStopIds.forEach(stopId => {
    const upcoming = stopUpcoming[stopId] || [];

    upcoming.forEach(item => {
      const trip = tripLookupByTripId[item.tripId];
      if (trip) {
        routeIds.add(getTripRouteKey(trip));
      }
    });
  });

  return routeIds;
}

function getEffectivePinnedRouteIds() {
  const routeIds = new Set(pinnedRouteIds);
  getPinnedRouteIdsFromStops().forEach(routeId => routeIds.add(routeId));
  return routeIds;
}

function hasAnyPins() {
  return pinnedRouteIds.size > 0 || pinnedStopIds.size > 0;
}

function tripMatchesPinnedView(trip = {}) {
  if (!pinnedViewEnabled) return true;
  if (!hasAnyPins()) return false;

  return getEffectivePinnedRouteIds().has(getTripRouteKey(trip));
}

function tripMatchesMapFilters(trip = {}) {
  return tripMatchesTransportFilter(trip) && tripMatchesPinnedView(trip);
}

function getPinnedRouteLabels() {
  const labelsByKey = {};

  timetableTrips.forEach(trip => {
    const key = getTripRouteKey(trip);
    if (!getEffectivePinnedRouteIds().has(key)) return;
    labelsByKey[key] = getRouteDisplayNameForTrip(trip);
  });

  return Object.values(labelsByKey).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function setPinnedViewEnabled(enabled) {
  pinnedViewEnabled = Boolean(enabled);
  savePinState();
  clearBusFocus();
  renderDefaultContextPanel();
  updateBusPositionsLive();
  updateNetworkLayer();
}

function togglePinnedRoute(trip) {
  const routeKey = getTripRouteKey(trip);

  if (pinnedRouteIds.has(routeKey)) {
    pinnedRouteIds.delete(routeKey);
  } else {
    pinnedRouteIds.add(routeKey);
  }

  savePinState();
  updateBusPositionsLive();
  updateNetworkLayer();

  return pinnedRouteIds.has(routeKey);
}

function togglePinnedStop(stopId) {
  if (pinnedStopIds.has(stopId)) {
    pinnedStopIds.delete(stopId);
  } else {
    pinnedStopIds.add(stopId);
  }

  savePinState();
  updateBusPositionsLive();
  updateNetworkLayer();

  return pinnedStopIds.has(stopId);
}

function getRoutesForStop(stopId) {
  const routeMap = new Map();
  const upcoming = stopUpcoming[stopId] || [];

  upcoming.forEach(item => {
    const trip = tripLookupByTripId[item.tripId];
    if (!trip) return;

    const key = getTripRouteKey(trip);
    if (!routeMap.has(key)) {
      routeMap.set(key, {
        key,
        label: getRouteDisplayNameForTrip(trip),
        mode: getTransportMode(trip)
      });
    }
  });

  return Array.from(routeMap.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

function clearActiveMapPinMarker() {
  if (activeMapPinMarker) {
    map.removeLayer(activeMapPinMarker);
    activeMapPinMarker = null;
  }
}

function createMapPinIcon(label = "Pin", isPinned = false) {
  const stateClass = isPinned ? "is-pinned" : "is-unpinned";
  const iconSrc = isPinned ? "unpin_icon.svg" : "pin_icon.svg";

  return L.divIcon({
    className: "",
    html: `
      <button class="map-pin-button ${stateClass}" type="button" aria-label="${escapeHTML(label)}">
        <img class="map-pin-icon" src="${iconSrc}" alt="" aria-hidden="true">
      </button>
    `,
    iconSize: [34, 34],
    // Anchor lower than the icon so the control floats above the selected marker instead of covering it.
    iconAnchor: [17, 64]
  });
}

function showMapPinForStop(stop) {
  clearActiveMapPinMarker();

  if (!stop) return;

  const isPinned = pinnedStopIds.has(stop.id);
  const label = isPinned
    ? `Remove pinned stop ${stop.name}`
    : `Pin stop ${stop.name}`;

  activeMapPinMarker = L.marker([stop.lat, stop.lon], {
    icon: createMapPinIcon(label, isPinned),
    zIndexOffset: 1800,
    interactive: true,
    keyboard: true
  }).addTo(map);

  activeMapPinMarker.on("click", event => {
    stopLeafletEvent(event);
    togglePinnedStop(stop.id);
    showMapPinForStop(stop);
  });
}

function showMapPinForTrip(trip, variant = selectedBusVariant) {
  clearActiveMapPinMarker();

  if (!trip) return;

  const positionRecord = variant === "scheduled"
    ? latestTripPositionsByTripId[trip.tripId]
    : latestLiveTripPositionsByTripId[trip.tripId] || latestTripPositionsByTripId[trip.tripId];

  if (!positionRecord?.position) return;

  const routeKey = getTripRouteKey(trip);
  const isPinned = pinnedRouteIds.has(routeKey);
  const routeLabel = getRouteDisplayNameForTrip(trip);
  const label = isPinned
    ? `Remove pinned ${routeLabel}`
    : `Pin ${routeLabel}`;

  activeMapPinMarker = L.marker(positionRecord.position, {
    icon: createMapPinIcon(label, isPinned),
    zIndexOffset: 1800,
    interactive: true,
    keyboard: true
  }).addTo(map);

  activeMapPinMarker.on("click", event => {
    stopLeafletEvent(event);
    togglePinnedRoute(trip);
    showMapPinForTrip(trip, variant);
  });
}

function renderDefaultContextPanel() {
  const filters = [
    { value: "all", label: "All" },
    { value: "bus", label: "Bus" },
    { value: "train", label: "Train" },
    { value: "ferry", label: "Ferry" },
    {
      value: "pinned",
      label: "Pinned",
      iconHTML: `<img src="current_location_pin.svg" alt="" class="transport-filter-icon" aria-hidden="true">`
    }
  ];

  const filterHTML = filters.map(filter => {
    const contentHTML = filter.iconHTML
      ? `${filter.iconHTML}<span>${escapeHTML(filter.label)}</span>`
      : `<span>${escapeHTML(filter.label)}</span>`;

    return `
      <button
        class="transport-filter-button ${filter.value === transportModeFilter ? "is-active" : ""}"
        type="button"
        data-transport-filter="${escapeHTML(filter.value)}"
        aria-pressed="${filter.value === transportModeFilter ? "true" : "false"}"
      >
        ${contentHTML}
      </button>
    `;
  }).join("");

  const pinnedRouteLabels = getPinnedRouteLabels();
  const pinsSummary = hasAnyPins()
    ? `${pinnedRouteLabels.length} pinned route${pinnedRouteLabels.length === 1 ? "" : "s"} from ${pinnedStopIds.size} stop pin${pinnedStopIds.size === 1 ? "" : "s"}`
    : "Pin a stop or service from the map to build a personal network.";

  selectionPanelContent.innerHTML = `
    <section class="panel-section context-panel-section">
      <div class="context-panel-header">
        <div class="panel-text-stack">
          <div class="panel-title">Explore services</div>
          <div class="panel-subtitle">${escapeHTML(transportModeFilter === "pinned" ? `Pinned view active · ${pinsSummary}` : pinsSummary)}</div>
        </div>
      </div>

      <div class="transport-filter-strip context-filter-strip" role="group" aria-label="Filter map view">
        ${filterHTML}
      </div>
    </section>
  `;

  bindTransportFilterButtons();
}

function bindPinContextButtons() {
  // Pin controls now live on the map, not inside the bottom context panel.
}

function bindTransportFilterButtons() {
  selectionPanelContent.querySelectorAll(".transport-filter-button").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setTransportModeFilter(button.dataset.transportFilter || "all");
    });
  });
}


// ---------- Transport mode filtering ----------
function setTransportModeFilter(mode) {
  const nextMode = ["all", "bus", "train", "ferry", "pinned"].includes(mode) ? mode : "all";

  transportModeFilter = nextMode;
  pinnedViewEnabled = nextMode === "pinned";
  savePinState();

  if (!selectedTripId && !selectedStopId) {
    renderDefaultContextPanel();
  }

  updateBusPositionsLive();
  updateNetworkLayer();
}

function getTransportMode(item = {}) {
  const routeType = String(item.routeType ?? "").trim();

  if (routeType === "2") return "train";
  if (routeType === "4") return "ferry";
  if (routeType === "0") return "tram";
  if (routeType === "1") return "subway";
  if (routeType === "3") return "bus";

  // Fallback for older processed data that does not have routeType yet.
  // If there is a route number, treat it as a bus. Otherwise use a generic transit icon.
  if (String(item.routeShortName ?? "").trim()) return "bus";

  return "transit";
}

function tripMatchesTransportFilter(trip = {}) {
  if (transportModeFilter === "all" || transportModeFilter === "pinned") return true;
  return getTransportMode(trip) === transportModeFilter;
}

function positionIsInsideExpandedViewport(position) {
  if (!position) return false;
  return map.getBounds().pad(0.22).contains(L.latLng(position[0], position[1]));
}

function shouldRenderTripMarkers(trip, scheduledPosition, livePosition) {
  if (selectedTripId === trip.tripId) return true;
  if (!tripMatchesMapFilters(trip)) return false;

  const zoom = map.getZoom();

  // Wide-area views should still feel alive, but with very cheap tiny dots.
  // Below this, the network layer carries the God-view instead of thousands of markers.
  if (zoom < SERVICE_DOTS_MIN_ZOOM) return false;

  return (
    positionIsInsideExpandedViewport(scheduledPosition?.position) ||
    positionIsInsideExpandedViewport(livePosition?.position)
  );
}

function shouldUseCompactServiceMarker(isSelected = false) {
  return !isSelected && map.getZoom() < DETAILED_MARKER_MIN_ZOOM;
}

function getTransportLabel(item = {}) {
  const mode = getTransportMode(item);
  const routeShortName = String(item.routeShortName ?? "").trim();

  if (mode === "bus") return routeShortName || "BUS";
  if (mode === "train") return "🚆";
  if (mode === "ferry") return "⛴️";
  if (mode === "tram") return "🚋";
  if (mode === "subway") return "🚇";

  return "•";
}

function getTransportAriaLabel(item = {}) {
  const mode = getTransportMode(item);
  const label = getTransportLabel(item);
  const routeLongName = String(item.routeLongName ?? "").trim();
  const headsign = String(item.headsign ?? "").trim();

  if (mode === "bus") {
    return `bus route ${label}${headsign ? ` to ${headsign}` : ""}`;
  }

  return `${mode}${routeLongName ? ` ${routeLongName}` : ""}${headsign ? ` to ${headsign}` : ""}`;
}


// ---------- Stop and service detail panels ----------
function renderStopPanel(stop, upcomingItems) {
  selectedPanelType = "stop";

  const routesForStop = getRoutesForStop(stop.id);
  const routeStripHTML = routesForStop.length
    ? routesForStop
        .slice(0, 18)
        .map(route => `<span class="stop-route-pill stop-route-${escapeHTML(route.mode)}">${escapeHTML(route.label)}</span>`)
        .join("")
    : `<span class="stop-route-empty">No active routes found for this stop today.</span>`;

  const upcomingHTML = upcomingItems.length
    ? upcomingItems.map(item => {
        const minsAway = formatMinutesAway(
          timeToSeconds(item.arrivalTime),
          getCurrentSecondsPrecise()
        );

        const trip = tripLookupByTripId[item.tripId] || item;
        const delayStatus = getDelayStatus(getStableLiveDelaySeconds(item.tripId));
        const statusLabel = delayStatus.detail === "on time" ? "on time" : delayStatus.detail;

        return `
          <button
            class="arrival-pill ${escapeHTML(delayStatus.className)}"
            type="button"
            data-shape-id="${escapeHTML(item.shapeId)}"
            data-trip-id="${escapeHTML(item.tripId)}"
            aria-label="Select ${escapeHTML(getTransportAriaLabel(item))}, ${escapeHTML(minsAway)} away, ${escapeHTML(statusLabel)}"
          >
            <span class="arrival-route ${escapeHTML(`arrival-route-${getTransportMode(trip)}`)}">${escapeHTML(getTransportLabel(trip))}</span>
            <span class="arrival-time">${escapeHTML(minsAway)}</span>
            <span class="arrival-destination">${escapeHTML(item.headsign)}</span>
          </button>
        `;
      }).join("")
    : `<div class="arrival-empty">No active services in the next 30 mins.</div>`;

  selectionPanelContent.innerHTML = `
    <section class="panel-section stop-panel-section">
      <div class="panel-main-row stop-panel-header">
        <div class="panel-text-stack">
          <div class="panel-title">${escapeHTML(stop.name)}</div>
          <div class="panel-subtitle">Stop ID: ${escapeHTML(stop.id)}</div>
        </div>

        <button class="stop-routes-toggle" type="button" aria-expanded="false" aria-label="Show routes serving this stop">
          ${escapeHTML(routesForStop.length)} routes
        </button>
      </div>

      <div class="stop-route-strip is-collapsed" aria-label="Routes serving this stop">
        ${routeStripHTML}
      </div>

      <div class="arrival-strip" aria-label="Upcoming services">
        ${upcomingHTML}
      </div>
    </section>
  `;

  const routeToggle = selectionPanelContent.querySelector(".stop-routes-toggle");
  const routeStrip = selectionPanelContent.querySelector(".stop-route-strip");

  if (routeToggle && routeStrip) {
    routeToggle.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();

      const isCollapsed = routeStrip.classList.toggle("is-collapsed");
      routeToggle.setAttribute("aria-expanded", String(!isCollapsed));
    });
  }

  selectionPanelContent.querySelectorAll(".arrival-pill").forEach(button => {
    const selectUpcomingTrip = event => {
      event.preventDefault();
      event.stopPropagation();

      const shapeId = button.getAttribute("data-shape-id");
      const tripId = button.getAttribute("data-trip-id");
      const trip = tripLookupByTripId[tripId];

      drawTripShapeByShapeId(shapeId);
      focusSingleTrip(tripId);

      if (trip) {
        renderBusPanel(trip);
      }
    };

    button.addEventListener("click", selectUpcomingTrip);
  });

  showMapPinForStop(stop);
  showSelectionPanel();
}


// ---------- Schedule/live comparison status ----------
function getStableLiveDelaySeconds(tripId) {
  // Deterministic fake live-data offset for the visualisation demo.
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
  const roundedMinutes = Math.round(Math.abs(delaySeconds) / 60);

  // Colour is mapped to rider outcome, not just raw schedule maths:
  // on-time is good, late is a warning/problem, early is informational.
  if (delaySeconds <= -60) {
    return {
      label: "Ahead",
      className: "ahead",
      text: `-${roundedMinutes} min`,
      detail: "ahead"
    };
  }

  if (delaySeconds >= 300) {
    return {
      label: "Delayed",
      className: "very-late",
      text: `+${roundedMinutes} min`,
      detail: "delayed"
    };
  }

  if (delaySeconds >= 60) {
    return {
      label: "Behind",
      className: "behind",
      text: `+${roundedMinutes} min`,
      detail: "behind"
    };
  }

  return {
    label: "On time",
    className: "on-time",
    text: "on time",
    detail: "on time"
  };
}

function getDelayColour(delaySeconds) {
  const status = getDelayStatus(delaySeconds);

  if (status.className === "ahead") return "#2563eb";
  if (status.className === "very-late") return "#dc2626";
  if (status.className === "behind") return "#f59e0b";
  return "#16a34a";
}

function getRoutePathColour() {
  return trackingMode === "ghost" ? "#111827" : "#f59e0b";
}

function getRoutePathOpacity() {
  return trackingMode === "ghost" ? 0.78 : 0.92;
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

  // Do not fall back to a direct "as the crow flies" connector.
  // If the two positions collapse to the same/single closest shape point,
  // there is not enough route geometry to draw a meaningful route-following segment.
  if (segment.length < 2) {
    return [];
  }

  // Keep the highlight locked to the route shape.
  // The live/scheduled marker positions are already interpolated from the same shape,
  // so this uses the actual route geometry instead of drawing a straight connector.
  return segment;
}

function drawGhostRouteSegmentForTrip(tripId) {
  clearGhostRouteSegmentLine();

  if (trackingMode !== "ghost" || !tripId) return;

  const trip = tripLookupByTripId[tripId];
  if (!trip) return;

  const scheduledPosition = latestTripPositionsByTripId[tripId];
  const livePosition = latestLiveTripPositionsByTripId[tripId];
  const shapeCoords = allShapes[trip.shapeId];

  if (!scheduledPosition?.position || !livePosition?.position || !shapeCoords) return;

  const delaySeconds = getStableLiveDelaySeconds(tripId);

  // Avoid visual noise for tiny differences.
  // Under 30 seconds, the scheduled/live positions are effectively the same for this demo.
  if (Math.abs(delaySeconds) < 30) return;

  const delayStatus = getDelayStatus(delaySeconds);
  const segmentCoords = getShapeSegmentBetweenPositions(
    shapeCoords,
    scheduledPosition.position,
    livePosition.position
  );

  if (segmentCoords.length < 2) return;

  ghostRouteSegmentLine = L.polyline(segmentCoords, {
    color: getDelayColour(delaySeconds),
    weight: 8,
    opacity: 0.96,
    dashArray: delayStatus.className === "on-time" ? null : "8 10",
    lineCap: "round",
    lineJoin: "round",
    className: `ghost-route-segment ${delayStatus.className}`
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
        <div class="route-badge route-badge-${escapeHTML(getTransportMode(trip))}">${escapeHTML(getTransportLabel(trip))}</div>

        <div class="panel-text-stack">
          <div class="panel-subtitle">${escapeHTML(variantLabel)}</div>
          <div class="panel-title">${escapeHTML(trip.headsign)}</div>
        </div>

        <div class="delay-chip ${escapeHTML(delayStatus.className)}" title="${escapeHTML(delayStatus.detail)}">
          <span class="delay-value">${escapeHTML(delayStatus.text)}</span>
          <span class="delay-detail">${escapeHTML(delayStatus.detail)}</span>
        </div>
      </div>

      <div class="between-card">
        <div class="between-label">Between</div>
        <div class="between-value">${escapeHTML(betweenText)}</div>
      </div>
    </section>
  `;

  showMapPinForTrip(trip, variant);
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


// ---------- Stop marker styling and interaction ----------
function getDefaultStopStyleForZoom(zoom = map.getZoom()) {
  // Stop dots are high-detail infrastructure. Keep them hidden until the
  // user is close enough to interact with individual stops.
  if (zoom < STOP_DOTS_MIN_ZOOM) {
    return {
      radius: 0,
      color: "#94a3b8",
      weight: 0,
      fillColor: "#2563eb",
      fillOpacity: 0,
      opacity: 0
    };
  }

  if (zoom === STOP_DOTS_MIN_ZOOM) {
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

function getStopHitAreaStyleForZoom(zoom = map.getZoom()) {
  // Invisible tap target. Keep it larger than the visual stop dot on mobile,
  // but hidden while stop dots are hidden so zoomed-out maps do not catch
  // accidental stop taps.
  if (zoom < STOP_DOTS_MIN_ZOOM) {
    return {
      radius: 0,
      color: "transparent",
      weight: 0,
      fillColor: "transparent",
      fillOpacity: 0,
      opacity: 0
    };
  }

  if (zoom >= 17) {
    return {
      radius: 12,
      color: "transparent",
      weight: 0,
      fillColor: "transparent",
      fillOpacity: 0,
      opacity: 0
    };
  }

  if (zoom >= 16) {
    return {
      radius: 15,
      color: "transparent",
      weight: 0,
      fillColor: "transparent",
      fillOpacity: 0,
      opacity: 0
    };
  }

  return {
    radius: 18,
    color: "transparent",
    weight: 0,
    fillColor: "transparent",
    fillOpacity: 0,
    opacity: 0
  };
}

function applyStopHitAreaStylesForZoom() {
  const style = getStopHitAreaStyleForZoom();

  Object.keys(stopHitMarkersByStopId).forEach(stopId => {
    stopHitMarkersByStopId[stopId].setStyle(style);
  });
}

function selectStop(stop) {
  clearBusFocus();
  clearNetworkLayer();

  const upcoming = getUpcomingForStop(stop.id, 30);

  focusTripsForStop(stop.id, upcoming);
  drawStopUpcomingPaths(upcoming);
  highlightRelevantStopMarkers(stop.id, upcoming);
  renderStopPanel(stop, upcoming);
}

function applyDefaultStopMarkerStylesForZoom() {
  const style = getDefaultStopStyleForZoom();

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    if (pinnedStopIds.has(stopId)) {
      marker.setStyle({
        radius: map.getZoom() < STOP_DOTS_MIN_ZOOM ? 6 : 7,
        color: "#7c2d12",
        weight: 3,
        fillColor: "#f97316",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle(style);
  });
}

function resetStopMarkerStyles() {
  applyDefaultStopMarkerStylesForZoom();
  applyStopHitAreaStylesForZoom();
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
  const trip = tripLookupByTripId[tripId];

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


// ---------- Multi-scale network route layer ----------
function clearNetworkLayer() {
  Object.keys(networkRouteLinesByShapeId).forEach(shapeId => {
    map.removeLayer(networkRouteLinesByShapeId[shapeId]);
  });

  networkRouteLinesByShapeId = {};
}

function getNetworkLineStyleForTrip(trip) {
  const mode = getTransportMode(trip);

  if (mode === "train") {
    return { color: "#7c3aed", weight: 3.5, opacity: 0.22 };
  }

  if (mode === "ferry") {
    return { color: "#0284c7", weight: 3, opacity: 0.24, dashArray: "7 9" };
  }

  if (mode === "tram" || mode === "subway") {
    return { color: "#0891b2", weight: 3, opacity: 0.22 };
  }

  return { color: "#334155", weight: 2.4, opacity: 0.16 };
}

function shapeTouchesExpandedViewport(shapeCoords) {
  if (!shapeCoords || shapeCoords.length === 0) return false;

  const bounds = map.getBounds().pad(0.18);
  const step = Math.max(1, Math.floor(shapeCoords.length / 28));

  for (let i = 0; i < shapeCoords.length; i += step) {
    if (bounds.contains(L.latLng(shapeCoords[i][0], shapeCoords[i][1]))) {
      return true;
    }
  }

  const last = shapeCoords[shapeCoords.length - 1];
  return bounds.contains(L.latLng(last[0], last[1]));
}

function updateNetworkLayer() {
  const zoom = map.getZoom();

  // The network layer is for wide/mid zoom. Once the user is close enough,
  // detailed markers, stop dots, and selected route paths take over.
  if (selectedTripId || selectedStopId || zoom > NETWORK_LAYER_MAX_ZOOM) {
    clearNetworkLayer();
    return;
  }

  const currentSeconds = getCurrentSecondsPrecise();
  const desiredShapeIds = new Set();
  const tripByShapeId = {};

  timetableTrips.forEach(trip => {
    if (!tripMatchesMapFilters(trip)) return;
    if (!tripIsActiveAtSeconds(trip, currentSeconds)) return;

    const shapeCoords = allShapes[trip.shapeId];
    if (!shapeCoords || !shapeTouchesExpandedViewport(shapeCoords)) return;

    desiredShapeIds.add(trip.shapeId);
    if (!tripByShapeId[trip.shapeId]) {
      tripByShapeId[trip.shapeId] = trip;
    }
  });

  Object.keys(networkRouteLinesByShapeId).forEach(shapeId => {
    if (!desiredShapeIds.has(shapeId)) {
      map.removeLayer(networkRouteLinesByShapeId[shapeId]);
      delete networkRouteLinesByShapeId[shapeId];
    }
  });

  desiredShapeIds.forEach(shapeId => {
    if (networkRouteLinesByShapeId[shapeId]) return;

    const shapeCoords = allShapes[shapeId];
    const trip = tripByShapeId[shapeId];
    const style = getNetworkLineStyleForTrip(trip);

    const line = L.polyline(shapeCoords, {
      ...style,
      interactive: false,
      lineCap: "round",
      lineJoin: "round",
      className: `network-route-line network-${getTransportMode(trip)}`
    }).addTo(map);

    line.bringToBack();
    networkRouteLinesByShapeId[shapeId] = line;
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


// ---------- Time, service-day and timetable helpers ----------
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


// ---------- Service marker rendering ----------
function createBusIcon(trip, isSelected = false, variant = "scheduled", delayClass = "on-time") {
  const mode = getTransportMode(trip);
  const markerLabel = escapeHTML(getTransportLabel(trip));
  const ariaLabel = escapeHTML(getTransportAriaLabel(trip));
  const compact = shouldUseCompactServiceMarker(isSelected);

  if (compact) {
    const dotClasses = [
      "service-dot-marker",
      `transport-${mode}`,
      variant === "live" ? "live" : "scheduled"
    ];

    if (variant === "live") dotClasses.push(delayClass);

    return L.divIcon({
      className: "",
      html: `<span class="${dotClasses.join(" ")}" aria-label="${variant} ${ariaLabel}"></span>`,
      iconSize: variant === "live" ? [12, 12] : [9, 9],
      iconAnchor: variant === "live" ? [6, 6] : [4.5, 4.5]
    });
  }

  const classes = [
    "route-bus-marker",
    `transport-${mode}`,
    variant === "live" ? "live" : "scheduled"
  ];

  if (isSelected) classes.push("selected");
  if (variant === "live") classes.push(delayClass);

  const iconSize = variant === "live" ? [48, 48] : [34, 34];
  const iconAnchor = variant === "live" ? [24, 24] : [17, 17];

  return L.divIcon({
    className: "",
    html: `
      <div class="${classes.join(" ")}" aria-label="${variant} ${ariaLabel}">
        ${variant === "live" ? `<span class="route-bus-pulse"></span>` : ""}
        <span class="route-bus-badge">${markerLabel}</span>
        ${variant === "scheduled" ? `<span class="route-bus-scheduled-dot" aria-hidden="true"></span>` : ""}
      </div>
    `,
    iconSize,
    iconAnchor
  });
}

function getScheduledMarkerOpacity(tripId) {
  if (trackingMode === "live") return 0;
  if (selectedTripId && tripId !== selectedTripId) return 0;
  if (selectedStopId && !highlightedTripIds.has(tripId)) return 0.15;
  return trackingMode === "ghost" ? 0.72 : 1;
}

function getLiveMarkerOpacity(tripId) {
  if (trackingMode === "scheduled") return 0;
  if (selectedTripId && tripId !== selectedTripId) return 0;
  if (selectedStopId && !highlightedTripIds.has(tripId)) return 0.15;
  return 1;
}

function applyBetaMarkerVisibility() {
  Object.keys(busMarkersByTripId).forEach(tripId => {
    const marker = busMarkersByTripId[tripId];
    marker.setOpacity(getScheduledMarkerOpacity(tripId));

    const element = marker.getElement?.();
    if (element) {
      element.style.pointerEvents = trackingMode === "live" ? "none" : "auto";
    }
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    const marker = liveBusMarkersByTripId[tripId];
    marker.setOpacity(getLiveMarkerOpacity(tripId));

    const element = marker.getElement?.();
    if (element) {
      element.style.pointerEvents = trackingMode === "scheduled" ? "none" : "auto";
    }
  });
}


// ---------- Selection highlighting and ETA chips ----------
function clearRouteLine() {
  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
    currentRouteLine = null;
  }

  clearGhostRouteSegmentLine();
}

function drawTripShapeByShapeId(shapeId) {
  clearNetworkLayer();
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

function clearEtaMarkers() {
  etaMarkers.forEach(marker => {
    map.removeLayer(marker);
  });

  etaMarkers = [];
}

function formatScheduledClockTime(timeString) {
  const seconds = timeToSeconds(timeString);

  if (Number.isNaN(seconds)) return "";

  const daySeconds = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(daySeconds / 3600);
  const minutes = Math.floor((daySeconds % 3600) / 60);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function getEtaText(arrivalSeconds, currentSeconds) {
  const diffSeconds = arrivalSeconds - currentSeconds;
  const diffMinutes = Math.round(diffSeconds / 60);

  if (diffMinutes <= 0) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function drawEtaMarkersForTrip(tripId) {
  clearEtaMarkers();

  const trip = tripLookupByTripId[tripId] || timetableTrips.find(item => item.tripId === tripId);

  if (!trip || !trip.stops || trip.stops.length === 0) return;

  const currentSeconds = getCurrentSecondsPrecise();
  const futureStops = trip.stops
    .filter(stopTime => {
      const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
      return !Number.isNaN(arrivalSeconds) && arrivalSeconds >= currentSeconds;
    })
    .slice(0, 12);

  futureStops.forEach((stopTime, index) => {
    const stop = stopLookup[stopTime.stopId];
    if (!stop) return;

    const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
    const etaText = getEtaText(arrivalSeconds, currentSeconds);
    const scheduledClock = formatScheduledClockTime(stopTime.arrivalTime);

    const marker = L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({
        className: "",
        html: `
          <div class="eta-chip ${index === 0 ? "is-next" : ""}" title="Scheduled ${escapeHTML(scheduledClock)}">
            <span class="eta-chip-time">${escapeHTML(etaText)}</span>
          </div>
        `,
        iconSize: [46, 24],
        iconAnchor: [23, 38]
      }),
      interactive: false,
      zIndexOffset: 1450
    }).addTo(map);

    etaMarkers.push(marker);
  });
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

    marker.setIcon(createBusIcon(tripLookupByTripId[id], isSelected, "scheduled"));
    marker.setZIndexOffset(isSelected ? 1200 : 500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(id => {
    const marker = liveBusMarkersByTripId[id];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(id)).className;
    const isSelected = id === selectedTripId && variant === "live";

    marker.setIcon(createBusIcon(tripLookupByTripId[id], isSelected, "live", delayClass));
    marker.setZIndexOffset(isSelected ? 1300 : 700);
  });

  applyBetaMarkerVisibility();
  drawGhostRouteSegmentForTrip(tripId);
  drawEtaMarkersForTrip(tripId);

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
    marker.setIcon(createBusIcon(tripLookupByTripId[tripId], highlightedTripIds.has(tripId), "scheduled"));
    marker.setZIndexOffset(highlightedTripIds.has(tripId) ? 1000 : 500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    const marker = liveBusMarkersByTripId[tripId];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(tripId)).className;
    marker.setIcon(createBusIcon(tripLookupByTripId[tripId], highlightedTripIds.has(tripId), "live", delayClass));
    marker.setZIndexOffset(highlightedTripIds.has(tripId) ? 1100 : 700);
  });

  applyBetaMarkerVisibility();
}

function focusSingleTrip(tripId) {
  selectedBusVariant = trackingMode === "scheduled" ? "scheduled" : "live";
  focusSelectedBus(tripId, selectedBusVariant);
}

function clearBusFocus() {
  clearActiveMapPinMarker();
  selectedTripId = null;
  selectedStopId = null;
  selectedBusVariant = trackingMode === "scheduled" ? "scheduled" : "live";
  highlightedTripIds = new Set();

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];
    marker.setIcon(createBusIcon(tripLookupByTripId[id], false, "scheduled"));
    marker.setZIndexOffset(500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(id => {
    const marker = liveBusMarkersByTripId[id];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(id)).className;
    marker.setIcon(createBusIcon(tripLookupByTripId[id], false, "live", delayClass));
    marker.setZIndexOffset(700);
  });

  applyBetaMarkerVisibility();
  clearRouteLine();
  clearEtaMarkers();
  clearStopRouteLines();
  resetStopMarkerStyles();
}

function resetAppView() {
  clearBusFocus();
  hideSelectionPanel();
  updateNetworkLayer();
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


// ---------- Stop arrivals and user location ----------
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
      const sameRoute = getTransportLabel(existing) === getTransportLabel(item) && getTransportMode(existing) === getTransportMode(item);
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


function findNearestStop(lat, lon) {
  let closestStop = null;
  let closestDistance = Infinity;

  Object.values(stopLookup).forEach(stop => {
    const distance = distanceBetweenPoints(
      [lat, lon],
      [stop.lat, stop.lon]
    );

    if (distance < closestDistance) {
      closestDistance = distance;
      closestStop = stop;
    }
  });

  return closestStop;
}

function showLocationMessage(title, message) {
  selectionPanelContent.innerHTML = `
    <section class="panel-section location-panel-section">
      <div class="panel-main-row">
        <div class="panel-text-stack">
          <div class="panel-title">${escapeHTML(title)}</div>
          <div class="panel-subtitle">${escapeHTML(message)}</div>
        </div>
      </div>
    </section>
  `;

  showSelectionPanel();
}

function selectNearestStopFromLocation(lat, lon) {
  const nearestStop = findNearestStop(lat, lon);

  if (!nearestStop) {
    showLocationMessage("No nearby stop found", "The app could not find a stop in the current dataset.");
    return;
  }

  const upcoming = getUpcomingForStop(nearestStop.id, 30);

  clearBusFocus();
  focusTripsForStop(nearestStop.id, upcoming);
  drawStopUpcomingPaths(upcoming);
  highlightRelevantStopMarkers(nearestStop.id, upcoming);
  renderStopPanel(nearestStop, upcoming);

  map.setView([nearestStop.lat, nearestStop.lon], Math.max(map.getZoom(), 15), {
    animate: true
  });
}

function updateUserLocationMarker(lat, lon) {
  if (userLocationMarker) {
    userLocationMarker.setLatLng([lat, lon]);
    return;
  }

  userLocationMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      className: "",
      html: `
        <div class="user-location-marker">
          <div class="user-location-pulse"></div>
          <div class="user-location-core">
            <img src="current_location_pin.svg" alt="Your location">
          </div>
        </div>
      `,
      iconSize: [56, 56],
      iconAnchor: [28, 28]
    }),
    zIndexOffset: 2200,
    interactive: false
  }).addTo(map);
}

function requestUserLocation() {
  if (!navigator.geolocation) {
    showLocationMessage("Location unavailable", "This browser does not support GPS location.");
    return;
  }

  showLocationMessage("Finding nearest stop…", "Allow location access when your browser asks.");

  navigator.geolocation.getCurrentPosition(
    position => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      updateUserLocationMarker(lat, lon);
      selectNearestStopFromLocation(lat, lon);
    },
    error => {
      const message = error.code === error.PERMISSION_DENIED
        ? "Location access was denied."
        : "The app could not get your current location.";

      showLocationMessage("Location not available", message);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000
    }
  );
}


function getLocalDateNumber(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return Number(`${year}${month}${day}`);
}

function getCalendarDayField(date = new Date()) {
  const dayFields = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];

  return dayFields[date.getDay()];
}

function getActiveServiceIdsForDate(date = new Date()) {
  const todayNumber = getLocalDateNumber(date);
  const dayField = getCalendarDayField(date);
  const activeServiceIds = new Set();

  serviceCalendarRows.forEach(service => {
    const startDate = Number(service.startDate);
    const endDate = Number(service.endDate);
    const runsToday = service[dayField] === true || service[dayField] === "1" || service[dayField] === 1;

    if (runsToday && todayNumber >= startDate && todayNumber <= endDate) {
      activeServiceIds.add(String(service.serviceId));
    }
  });

  return activeServiceIds;
}

function filterStopUpcomingByServiceIds(stopUpcomingLookup, activeServiceIds) {
  const filtered = {};

  Object.keys(stopUpcomingLookup).forEach(stopId => {
    const activeItems = stopUpcomingLookup[stopId].filter(item => {
      return activeServiceIds.has(String(item.serviceId));
    });

    if (activeItems.length > 0) {
      filtered[stopId] = activeItems;
    }
  });

  return filtered;
}

function applyTodayServiceFilter() {
  activeServiceIdsForToday = getActiveServiceIdsForDate(new Date());

  if (activeServiceIdsForToday.size === 0) {
    console.warn("No active service_ids found for today's local date. Falling back to all timetable trips.");
    timetableTrips = unfilteredTimetableTrips;
    stopUpcoming = unfilteredStopUpcoming;
    rebuildTripLookup();
    return;
  }

  timetableTrips = unfilteredTimetableTrips.filter(trip => {
    return activeServiceIdsForToday.has(String(trip.serviceId));
  });

  stopUpcoming = filterStopUpcomingByServiceIds(unfilteredStopUpcoming, activeServiceIdsForToday);
  rebuildTripLookup();

  console.log("Date filter applied", {
    localDate: getLocalDateNumber(new Date()),
    activeServiceIds: activeServiceIdsForToday.size,
    unfilteredTrips: unfilteredTimetableTrips.length,
    activeTrips: timetableTrips.length
  });
}


// ---------- Data loading ----------
async function loadCoreData() {
  const [routesRes, tripsRes, shapesRes, timetableRes, stopUpcomingRes, calendarRes] = await Promise.all([
    fetch("data/processed/routes.json"),
    fetch("data/processed/trips.json"),
    fetch("data/processed/shapes.json"),
    fetch("data/processed/trip-stop-times.json"),
    fetch("data/processed/stop-upcoming.json"),
    fetch("data/processed/calendar.json")
  ]);

  allRoutes = await routesRes.json();
  allTrips = await tripsRes.json();
  allShapes = await shapesRes.json();
  unfilteredTimetableTrips = await timetableRes.json();
  unfilteredStopUpcoming = await stopUpcomingRes.json();
  serviceCalendarRows = await calendarRes.json();

  applyTodayServiceFilter();
  chooseServiceDayOffset();

  console.log("Core data loaded");
  console.log("Routes:", allRoutes.length);
  console.log("Trips:", allTrips.length);
  console.log("Shapes:", Object.keys(allShapes).length);
  console.log("Unfiltered timetable trips:", unfilteredTimetableTrips.length);
  console.log("Today timetable trips:", timetableTrips.length);
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
    // Visible stop dot stays small and clean.
    const marker = L.circleMarker(
      [stop.lat, stop.lon],
      {
        ...getDefaultStopStyleForZoom(),
        interactive: false
      }
    ).addTo(map);

    // Invisible hit area gives mobile users a much larger tap target without
    // visually enlarging every stop dot.
    const hitMarker = L.circleMarker(
      [stop.lat, stop.lon],
      {
        ...getStopHitAreaStyleForZoom(),
        interactive: true
      }
    ).addTo(map);

    stopMarkersByStopId[stop.id] = marker;
    stopHitMarkersByStopId[stop.id] = hitMarker;

    hitMarker.on("click", event => {
      stopLeafletEvent(event);
      selectStop(stop);
    });
  });
}



// ---------- Vehicle update loop ----------
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
  const visibleTripIds = new Set();

  timetableTrips.forEach(trip => {
    const scheduledPosition = getTripPositionNow(trip, currentSeconds);

    if (!scheduledPosition) return;

    activeTripIds.add(trip.tripId);
    latestTripPositionsByTripId[trip.tripId] = scheduledPosition;

    const delaySeconds = getStableLiveDelaySeconds(trip.tripId);
    const livePosition = getTripPositionNow(trip, currentSeconds - delaySeconds) || scheduledPosition;
    latestLiveTripPositionsByTripId[trip.tripId] = livePosition;

    if (!shouldRenderTripMarkers(trip, scheduledPosition, livePosition)) {
      return;
    }

    visibleTripIds.add(trip.tripId);

    const scheduledIsSelected = selectedTripId === trip.tripId && selectedBusVariant === "scheduled";

    if (busMarkersByTripId[trip.tripId]) {
      busMarkersByTripId[trip.tripId]
        .setLatLng(scheduledPosition.position)
        .setIcon(createBusIcon(trip, scheduledIsSelected, "scheduled"));
    } else {
      const marker = L.marker(scheduledPosition.position, {
        icon: createBusIcon(trip, false, "scheduled"),
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

    const delayClass = getDelayStatus(delaySeconds).className;

    const liveIsSelected = selectedTripId === trip.tripId && selectedBusVariant === "live";

    if (liveBusMarkersByTripId[trip.tripId]) {
      liveBusMarkersByTripId[trip.tripId]
        .setLatLng(livePosition.position)
        .setIcon(createBusIcon(trip, liveIsSelected, "live", delayClass));
    } else {
      const marker = L.marker(livePosition.position, {
        icon: createBusIcon(trip, false, "live", delayClass),
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
    if (!visibleTripIds.has(tripId)) {
      map.removeLayer(busMarkersByTripId[tripId]);
      delete busMarkersByTripId[tripId];
    }
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    if (!visibleTripIds.has(tripId)) {
      map.removeLayer(liveBusMarkersByTripId[tripId]);
      delete liveBusMarkersByTripId[tripId];
    }
  });

  Object.keys(latestTripPositionsByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) delete latestTripPositionsByTripId[tripId];
  });

  Object.keys(latestLiveTripPositionsByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) delete latestLiveTripPositionsByTripId[tripId];
  });

  if (selectedTripId) {
    drawGhostRouteSegmentForTrip(selectedTripId);
    drawEtaMarkersForTrip(selectedTripId);
  }

  updateNetworkLayer();
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


function refreshMapAfterInteraction() {
  if (mapRefreshTimeoutId) {
    window.clearTimeout(mapRefreshTimeoutId);
  }

  mapRefreshTimeoutId = window.setTimeout(() => {
    if (selectedTripId || selectedStopId) {
      // Keep selected views responsive even after a zoom/pan.
      updateBusPositionsLive();
      return;
    }

    applyDefaultStopMarkerStylesForZoom();
    applyStopHitAreaStylesForZoom();
    updateBusPositionsLive();
  }, MAP_SETTLE_REFRESH_DELAY_MS);
}


// ---------- Tracking mode controls and app events ----------
function showLiveNoticeOnce() {
  if (!liveNoticeModal) return;
  if (localStorage.getItem(LIVE_NOTICE_SEEN_KEY) === "true") return;

  liveNoticeModal.classList.remove("is-hidden");
}

function closeLiveNoticeModal() {
  if (!liveNoticeModal) return;

  localStorage.setItem(LIVE_NOTICE_SEEN_KEY, "true");
  liveNoticeModal.classList.add("is-hidden");
}

function setTrackingMode(mode) {
  trackingMode = mode;

  trackingModeButtons.forEach(button => {
    button.classList.toggle("is-active", button.dataset.trackingMode === mode);
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
    updateNetworkLayer();
  }
}

trackingModeButtons.forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();

    const selectedMode = button.dataset.trackingMode;
    setTrackingMode(selectedMode);

    if (selectedMode === "live") {
      showLiveNoticeOnce();
    }
  });
});

if (themeToggleButton) {
  themeToggleButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    toggleMapTheme();
  });

  themeToggleButton.addEventListener("touchstart", event => {
    event.stopPropagation();
  }, { passive: true });
}

if (locateUserButton) {
  locateUserButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    requestUserLocation();
  });

  locateUserButton.addEventListener("touchstart", event => {
    event.stopPropagation();
  }, { passive: true });
}

map.on("movestart zoomstart", () => {
  isMapMoving = true;
});

map.on("moveend zoomend", () => {
  isMapMoving = false;
  refreshMapAfterInteraction();
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

if (liveNoticeOkButton) {
  liveNoticeOkButton.addEventListener("click", event => {
    event.preventDefault();
    closeLiveNoticeModal();
  });
}

if (liveNoticeModal) {
  liveNoticeModal.addEventListener("click", event => {
    if (event.target === liveNoticeModal) {
      closeLiveNoticeModal();
    }
  });
}


// ---------- App startup ----------
async function init() {
  updateThemeToggleButton();
  hideSelectionPanel();

  await loadCoreData();
  renderDefaultContextPanel();
  await loadStops();
  applyStopHitAreaStylesForZoom();

  map.invalidateSize();
  updateBusPositionsLive();
  setTrackingMode("scheduled");
  updateNetworkLayer();

  busUpdateTimerId = window.setInterval(() => {
    if (!isMapMoving) {
      updateBusPositionsLive();
    }
  }, VEHICLE_UPDATE_INTERVAL_MS);
}

init().catch(err => console.error(err));
