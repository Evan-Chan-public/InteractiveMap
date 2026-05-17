# Interactive Map

A lightweight browser-based tool for annotating custom map images. Aims to produce a sort of... locationally nested filesystem.

---

## Running Locally

The app uses ES modules and a Web Worker, so it must be served over HTTP. Opening `index.html` directly as a `file://` URL will not work.

Quick options:
```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Then open `http://localhost:8080` in your browser.

External dependencies (Leaflet, Marked, Lucide) are loaded from CDN, so an internet connection is required on first load (they may be cached after that).

---

## Rebuilding the WASM Module

The compiled files (`processor.js`, `processor.wasm`) are pre-built and excluded from git. If you modify `wasm/processor.cpp`, rebuild with:

```bash
cd wasm
make
```

Requires [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) installed to `~/.emsdk`.

---

## Modes

### Display Mode
The default view. Regions and pins are visible and selectable; clicking them opens a details panel on the right. Design tools are hidden.

### Design Mode
Toggle with the **Design Mode** button (top-right). Exposes all editing tools and lets you create, modify, and delete annotations.

---

## Features

### Upload a Map
In Design Mode, use **Upload Image** to load a JPEG or PNG as the map background. The image is stored in memory only — annotations are saved separately to `localStorage`.

### Pins
- **Add Pin** tool: click anywhere on the map (including on top of regions) to place a pin.
- Click a pin to select it and view/edit its label and description in the detail panel.

### Regions
- **Add Region** tool: click to place polygon vertices; click the first vertex again (or double-click) to close the shape.
- **Flood Region** (magic wand): click a point on the image and the tool flood-fills the area by color similarity. Adjust **Tolerance** to control how broadly it fills.
- **Edit Vertices**: with a region selected, activates vertex drag handles on the polygon.
- **Brush**: drag to paint-expand the selected region (or start a new one).
- **Eraser**: drag to subtract area from any region underneath.

### Merging and Consolidating
With a region selected in the detail panel:
- **Merge**: click Merge, then click another region. The two are unioned together.
- **Consolidate**: collapses a multi-ring region (e.g. two disconnected blobs) into a single contiguous polygon by bridging near-touching rings.

### Color
Each region has an assigned color, visible as a swatch in the region list and as the fill on the map. Colors can be set to a preset or custom hex value.

### Labels and Descriptions
All annotations have a **label** and a **description** field. Descriptions support Markdown (rendered in display mode).

### Hiding
Individual annotations can be toggled hidden. Hidden items are invisible in Display Mode.

### Undo / Redo
`Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`). Up to 50 steps of history.

### Navigation
Clicking a related pin in a region's detail panel (or vice versa) pushes a back-navigation entry, letting you return with the **←** button.

### Sharing

Click **Share** (top-right) to generate a URL encoding the current annotations.

- **Lock Design Mode**: check this before copying the link to prevent the viewer from editing.
- The map image is not included in the link — the recipient must upload it themselves.
- Locked links hide the Design Mode button entirely. Unlocked links let the viewer edit freely.

---

## Data Persistence

Annotations are auto-saved to `localStorage` after edits. They are restored automatically on next load if the same map image is uploaded. To clear all data, use the discard option shown on load when saved data is detected.
