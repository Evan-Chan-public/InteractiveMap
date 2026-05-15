export const state = {
  mode: 'display',       // 'display' | 'design'
  image: null,           // { url, width, height } once loaded
  annotations: {
    regions: [],         // [{ id, polygons, color, label, body, hidden }]
    pins:    [],         // [{ id, latlng, label, body, hidden }]
  },
  ui: {
    activeTool:  null,   // 'region' | 'pin' | 'wand' | 'brush' | 'eraser' | 'edit' | null
    selected:    null,   // { type: 'region'|'pin', id }
    filter:      null,   // future: { regionId }
    mergeSource: null,   // region id being used as merge source
    mergeHover:  null,   // region id currently hovered as merge candidate
  },
};

// Leaflet layers keyed by annotation id
export const layers = {
  pins:    {}, // id → L.Marker
  regions: {}, // id → L.FeatureGroup (one L.Polygon per ring)
};

export const historyStack = [];
export const HISTORY_MAX  = 50;
export const navStack     = [];
