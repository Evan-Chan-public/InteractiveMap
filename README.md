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

## Code Layout

Plain ES modules, no build step. `app.js` is the entry point (mode, tools, map and keyboard events, startup); the rest:

| Module | Holds |
|---|---|
| `state.js` | shared app state and the Leaflet layer registry |
| `persistence.js` | localStorage save/load and sanitizing loaded data |
| `nesting.js` | parent links, auto-nesting, tree lookups |
| `map.js` | the Leaflet map |
| `render.js` | drawing annotations, stacking order, what's clickable/faded |
| `selection.js` | selection and back/up navigation |
| `panel.js` | the right panel: layer list, details, editor, tree |
| `layerstrip.js` | the layer chips and moving items between layers |
| `create.js` | new pins and regions, colours, deletion |
| `shapes.js` | merge, consolidate, vertex edit, brush, eraser |
| `wand.js` | flood fill via the WASM worker |
| `image.js` | map image upload, paste and baseline file |
| `share.js` | share links: encoding and the dialog |
| `history.js` | undo/redo |

Modules import each other in cycles. That's safe because only `app.js` runs code at load time; the others just declare functions and attach listeners to their own elements.

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

Clicking a region drills into it: the region stays outlined, its children become clickable (whichever layer they're on), and everything else fades. Selecting something with no children keeps its siblings clickable. `Esc` or the **← parent** button goes up a level; at the top level it returns to browsing the active layer. Clicking the map outside the area you're in (or outside the selected item) deselects and returns to the outermost layer; clicks inside it that miss a child do nothing. Clicking a layer chip leaves the drill-down and browses that layer. Hidden regions are skipped, so their children appear under the next visible ancestor.

### Design Mode
Toggle with the **Design Mode** button (top-right). Exposes all editing tools and lets you create, modify, and delete annotations.

---

## Features

### Upload a Map
In Design Mode, use **Upload Image** (or paste) to load a JPEG or PNG as the map background. The image is stored in memory only — annotations are saved separately to `localStorage`.

**Baseline map:** on startup the app loads, in order of preference:
1. the file named by `?map=other.png` in the URL, if given;
2. `basemap.png` next to `index.html` (gitignored, so it's your own local map);
3. `maps/world.png`, the bundled world map.

Uploading still replaces it for the session.

**World map:** `maps/world.png` is a 4096×1650 black-and-white map of country borders (85°N to 60°S, equirectangular, Antarctica left out), drawn from [Natural Earth](https://www.naturalearthdata.com/) 1:50m data (public domain). Each country is a closed outline, so **Flood Region** fills one country per click. `maps/render_world.py` regenerates it (instructions at the top of the file; standard library only).

The flood fill works within a 1024×1024 window around the click, so the largest countries (Russia, Canada) fill only partly in one click. Fill the rest with a second click and **Merge**, or the brush.

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

### Deleting
Select an item in Design Mode and press `Backspace` / `Delete`, or click **Delete** in the editor. With **Confirm deletes** on (left panel, on by default, remembered per browser), the first press arms the button and a second press or click within 3 seconds deletes; `Esc` cancels. Keys typed into a text field never delete. Newly created items open with their label focused for naming; selecting an existing item doesn't, so `Backspace` goes to the item.

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

### Map Files

A map (title, layers, regions, pins and the map image) can be saved as one `.imap.json` file. The **Map** section at the top of the left panel (Design Mode) holds the title and the **Export** / **Import** buttons; you can also drop a `.imap.json` file anywhere on the map to open it.

- **Export** downloads `<title>.imap.json`. The image is embedded, so the file opens anywhere; the bundled world map (`maps/…`) is stored as a reference instead, since it ships with the app.
- **Import** replaces the current map. If the current map has content you're asked first, with an option to export it before replacing. Undo history starts fresh with the opened map.
- Files are checked on open like share links: unknown or malformed fields are dropped, only PNG/JPEG/GIF/WebP images are accepted, and image references must be `http(s)` or relative paths.

Format (version 1, plain JSON):

```json
{
  "format": "interactive-map",
  "version": 1,
  "title": "Europe",
  "modified": "2026-10-14T12:00:00.000Z",
  "image": { "width": 5632, "height": 2048, "name": "europe.png", "data": "data:image/png;base64,…" },
  "annotations": { "layers": [ … ], "regions": [ … ], "pins": [ … ] }
}
```

`image` may instead be `{ "width", "height", "src": "maps/world.png" }` (a reference) or `null` (use the viewer's baseline map). Files from a newer version of the app are refused with a message rather than misread; older versions are upgraded on load.

### Sharing

Click **Share** (top-right) to generate a URL encoding the current annotations.

- **Lock Design Mode**: check this before copying the link to prevent the viewer from editing.
- The map image is not included in the link. Recipients get the baseline map if the site serves one (the link keeps any `?map=`); otherwise they must upload it themselves.
- Locked links hide the Design Mode button entirely. Unlocked links let the viewer edit freely.
- Links are compressed; the dialog shows the link size and warns when it's long enough that some apps may cut it off. Older uncompressed links still open.
- Everything in a link is treated as untrusted: ids, colours and coordinates are validated on load, and descriptions are sanitized before their Markdown is rendered.
- Locking is a convenience, not access control: anyone can edit the link itself.
- A shared map opens separately from your own: unlocked links can be edited, but nothing is saved (a notice in the left panel says so) until you click **Keep as my map**, which replaces your saved map.

---

## Data Persistence

The current map autosaves to the browser's IndexedDB after every edit: annotations, title and an uploaded image, so everything (image included) comes back on the next visit. Baseline maps aren't stored, since they're loaded from their file each time. Where IndexedDB isn't available, annotations fall back to `localStorage` as before; maps saved there by older versions are moved over automatically.

Saved data lives in this browser only. Use **Export** to keep a copy or move a map elsewhere. If a saved map's image can't be loaded, the placeholder offers to discard the saved map.
