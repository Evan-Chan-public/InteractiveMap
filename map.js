
// MAP — the Leaflet map (CRS.Simple: lat = -y, lng = x in image pixels)

export const map = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: -4,
  maxZoom: 4,
  zoomSnap: 0,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 40,
  zoomAnimation: false,
  attributionControl: false,
});

// the map image sits in its own pane under the annotations (overlayPane is z-index 400)
map.createPane('mapImage').style.zIndex = 350;
