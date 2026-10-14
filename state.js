export const state = {
  mode: 'display',       // 'display' | 'design'
  title: '',             // map title: project files, export file name, browser tab
  image: null,           // { url, width, height, el, source } once loaded (el = the <img>, read by the wand)
                         // source: { kind: 'blob', blob, name } uploaded / imported, saved with the project
                         //       | { kind: 'baseline', src }   ?map= / basemap.png / bundled map, not saved
                         //       | { kind: 'ref', src }        referenced by a project file, saved as a reference
  annotations: {
    layers:  [],         // [{ id, name }] — array order = z-order; bottom = root, top = leaf
    regions: [],         // [{ id, polygons, color, label, body, hidden, layerId }]
    pins:    [],         // [{ id, latlng, label, body, hidden, layerId }]
  },
  ui: {
    activeTool:    null, // 'region' | 'pin' | 'wand' | 'brush' | 'eraser' | 'edit' | null
    selected:      null, // { type: 'region'|'pin', id }
    filter:        null, // future: { regionId }
    mergeSource:   null, // region id being used as merge source
    mergeHover:    null, // region id currently hovered as merge candidate
    activeLayerId: null, // currently selected layer; others render dimmed
    shareLocked:   false, // opened from a locked share link: design mode is off
    autosave:      true,  // false while viewing a map opened from a link, until it's kept
  },
};

// Leaflet layers keyed by annotation id
export const layers = {
  pins:    {}, // id → L.Marker
  regions: {}, // id → L.FeatureGroup (one L.Polygon per ring)
};

export const historyStack = [];
export const redoStack    = [];
export const HISTORY_MAX  = 50;
export const navStack     = [];
