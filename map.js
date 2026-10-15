
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

// regions are drawn in layers around the outlines (overlayPane, 400): the colourist's band of pigment
// just under them, the veil outside a drilled-into region above them, and region names over that,
// under the place marks (markerPane, 600)
map.createPane('regionWash').style.zIndex = 395;
map.createPane('drillVeil').style.zIndex  = 450;
map.createPane('regionNames').style.zIndex = 550;
map.getPane('regionNames').style.pointerEvents = 'none';
