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

Clicking a region drills into it: the region stays outlined, its children become clickable (whichever layer they're on), and everything else fades. Selecting something with no children keeps its siblings clickable. `Esc` or the **← parent** button goes up a level; at the top level it returns to browsing the active layer. Clicking a layer chip leaves the drill-down and browses that layer. Hidden regions are skipped, so their children appear under the next visible ancestor.

### Design Mode
Toggle with the **Design Mode** button (top-right). Exposes all editing tools and lets you create, modify, and delete annotations.

---

## Features

### Upload a Map
In Design Mode, use **Upload Image** (or paste) to load a JPEG or PNG as the map background. The image is stored in memory only — annotations are saved separately to `localStorage`.

**Baseline map:** if a `basemap.png` sits next to `index.html`, it loads automatically on startup. Add `?map=other.png` to the URL to load a different file instead. Uploading still replaces it for the session. If the file is missing, the app falls back to the upload prompt.

### Pins
- **Add Pin** tool: click anywhere on the map (including on top of regions) to place a pin.
- Click a pin to select it and view/edit its label and description in the detail panel.

### Regions
- **Add Region** tool: click to place polygon vertices; click the first vertex again (or double-click) to close the shape. `Esc` cancels.
- **Flood Region** (magic wand): click a point on the image and the tool flood-fills the area by color similarity. Adjust **Tolerance** to control how broadly it fills.
- **Edit Vertices**: with a region selected, activates vertex drag handles on the polygon.
- **Brush**: drag to paint-expand the selected region (or start a new one). `Shift`+drag always starts a new region; `Esc` deselects so the next stroke starts fresh.
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

### Layers
The layer strip (top-left) lists layers bottom → top; higher layers draw above lower ones.

- Only the active layer is interactive. Other layers are dimmed and ignore clicks; switch layers by clicking a chip.
- New annotations go on the active layer, and the brush/eraser only affect it.
- In Design Mode: **+** adds a layer, double-click renames, drag reorders, and **×** (click twice) deletes a layer along with its contents.
- Move an item between layers with the **Layer** dropdown in its editor. Regions on different layers can't be merged.

### Nesting
Every region and pin can have a parent region on another layer, forming a tree.

- Parents are assigned automatically: the region on the nearest layer below that covers most of the item. Empty layers are skipped.
- Pins can also nest in a region on their own layer (checked first), so a city pin placed on a provinces layer lands in its province. Regions always nest across layers.
- Links are recalculated when an item is created, reshaped or moved between layers, or when its parent is deleted. **Reordering layers does not change them.** Use **Re-nest layer** / **Re-nest all** (right panel, nothing selected) to reassign after a reorder.
- Set a parent by hand with the **Parent** dropdown in the editor. Manual parents are kept through re-nesting; choose **Auto** to go back.
- A selected item's panel shows a breadcrumb of its ancestors and an expandable **Contains** tree of its children; click any entry to jump to it.

### Sharing

Click **Share** (top-right) to generate a URL encoding the current annotations.

- **Lock Design Mode**: check this before copying the link to prevent the viewer from editing.
- The map image is not included in the link. Recipients get the baseline map if the site serves one (the link keeps any `?map=`); otherwise they must upload it themselves.
- Locked links hide the Design Mode button entirely. Unlocked links let the viewer edit freely.
- Links are compressed; the dialog shows the link size and warns when it's long enough that some apps may cut it off. Older uncompressed links still open.
- Everything in a link is treated as untrusted: ids, colours and coordinates are validated on load, and descriptions are sanitized before their Markdown is rendered.
- Locking is a convenience, not access control: anyone can edit the link itself.

---

## Data Persistence

Annotations are auto-saved to `localStorage` after edits. They are restored automatically on next load if the same map image is uploaded. To clear all data, use the discard option shown on load when saved data is detected.
