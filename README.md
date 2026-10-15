# Cairn

A lightweight browser-based tool for annotating custom map images. Aims to produce a sort of... locationally nested filesystem.

**Use it at [cairn-atlas.github.io](https://cairn-atlas.github.io/).** Nothing to install or sign up for: maps save in your browser as you work, and **Export** gives you a file to back one up or open it elsewhere. Leaflet, Marked and the fonts load from CDNs, so the first visit needs an internet connection.

---

## Modes

### Display Mode
The default view. Regions and pins are visible and selectable; clicking them opens a details panel on the right (on a phone, a sheet rising over the lower half of the map). The panel's **×** closes it. Design tools are hidden. The frame around the map follows your system's light or dark setting.

From the keyboard, `Tab` reaches the regions and pins you can use; a dashed oxblood line shows which has focus, a focused region shows its name, and `Enter` or `Space` opens it.

Clicking a region drills into it: the region keeps its painted border, its children become clickable (whichever layer they're on), and everything outside it is veiled. Selecting something with no children keeps its siblings clickable. `Esc` or the back button (named after the parent) goes up a level; at the top level it returns to browsing the active layer. Clicking the map outside the area you're in (or outside the selected item) deselects and returns to the outermost layer; clicks inside it that miss a child do nothing. Clicking a layer chip leaves the drill-down and browses that layer. Hidden regions are skipped, so their children appear under the next visible ancestor.

### Design Mode
Switch with the **Display / Design** switch (top right). Design Mode exposes the editing tools and lets you create, modify, and delete annotations.

The tools are a narrow roll down the left edge (on a phone, a row along the bottom). Pick one by clicking its pocket or pressing its letter: `P` pin, `R` region, `F` flood, `V` vertices, `B` brush, `E` eraser (never while typing). The tool in hand turns gilt and a flap opens beside the roll with how to use it here, its settings and its keys; **Put down**, its pocket or its letter again puts it down. The flap's **«** folds it down to a tab to free the map's corner, keeping the tool in hand. The **Map** pocket at the foot of the roll holds the map file (see below); a dot on it means its flap has news.

---

## Features

### Upload a Map
In Design Mode, use **Upload Image** (or paste, or drop an image on the map) to load a PNG, JPEG, GIF or WebP as the map background. It becomes the map's own image: autosaved with the map and embedded when you export it.

**Baseline map:** on startup the app loads, in order of preference:
1. the file named by `?map=other.png` in the URL, if given;
2. `basemap.png` next to `index.html`, when you run your own copy (it's gitignored, so it stays your local map);
3. `maps/world.png`, the bundled world map.

Uploading still replaces it for the session.

**World map:** `maps/world.png` is a 4096×1650 black-and-white map of country borders (85°N to 60°S, equirectangular, Antarctica left out), drawn from [Natural Earth](https://www.naturalearthdata.com/) 1:50m data (public domain). Each country is a closed outline, so **Flood Region** fills one country per click. `maps/render_world.py` regenerates it (instructions at the top of the file; standard library only).

The flood fill works within a 1024×1024 window around the click, so the largest countries (Russia, Canada) fill only partly in one click. Fill the rest with a second click and **Merge**, or the brush.

### Pins
Pins are lettered onto the map like places on an old map: a small inked mark with the name beside it.

- **Add Pin** tool: click anywhere on the map (including on top of regions) to place a pin.
- Click a pin (its mark or its name) to select it and view/edit its label and description in the detail panel. The selected pin gets a gilt ring and underline.
- From the keyboard, `Tab` moves between the pins you can use (faded ones are skipped), a dashed ring shows which has focus, and `Enter` or `Space` selects it. Screen readers announce each pin by name.
- **Mark** (editor): a dot, a ring or a cairn. It's saved with the pin.
- Pins on faded layers show only their mark, so other layers don't crowd the map with names.
- **Names don't collide.** Each name sits to the right of its mark, or to the left, above or below when that's taken or would run off screen; a name with no free spot is left off until you zoom in (hover its mark to read it). Names on lower layers are placed first, so zooming out keeps the broad places and thins the detail. The selected pin always shows its name. Long names wrap onto several lines.

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
Each region has an assigned color, visible as a swatch in the region list and on the map, where it's painted like a hand-coloured old map: a band of colour along the inside of the border, a thin inked edge and a faint wash inside. Region names are lettered across the regions you can use, in spaced capitals; a name that doesn't fit (or would cover a pin) is left off, and hovering the region shows it instead. Pins on faded layers show their name when the mouse rests on them. New regions take the next of eight pigments (woad, minium, verdigris, orpiment, folium, kermes, moss, ochre); the editor's **Color** picker offers seventeen named pigments or any custom colour.

### Labels and Descriptions
All annotations have a **label** and a **description** field. Descriptions support Markdown (rendered in display mode).

### Hiding
- **Hide in display mode** (editor checkbox) hides an item from viewers. It's saved with the map.
- **Eye toggles** declutter your own view while editing: an eye on each row of the right panel's list hides that item, and an eye on each layer chip hides the whole layer. They only apply in Design Mode, aren't saved, aren't part of undo, and never change what viewers see. Selecting a hidden item (from the list or the tree) or creating something on a hidden layer shows it again; the eraser leaves hidden regions alone. Opening another map shows everything again.

### Selecting Several
In Design Mode, with no tool in hand, you can gather several items on the active layer and change them all at once:

- `Shift`-click (or `Cmd`/`Ctrl`-click) places on the map to add or remove them.
- `Shift`-drag a box on the map to add everything wholly inside it.
- `Cmd`/`Ctrl`+`A` or **Select all** (right panel) takes everything on the layer.
- Tick the boxes on the right panel's list, or click **Select more** in an item's editor (the way in on phones).

The panel then shows what's selected, with a shared **Layer**, **Color** (regions), **Mark** (pins) and **Hide in display mode**, and **Delete N**. Each change is one undo step. `Esc`, **Select none**, picking up a tool or switching to Display Mode lets go. In Design Mode `Shift`-drag selects instead of zooming.

### Deleting
Select an item (or several) in Design Mode and press `Backspace` / `Delete`, or click **Delete** in the editor. With **Confirm deletes** on (Map flap, on by default, remembered per browser), the first press arms the button and a second press or click within 3 seconds deletes; `Esc` cancels. Keys typed into a text field never delete. Newly created items open with their label focused for naming; selecting an existing item doesn't, so `Backspace` goes to the item.

### Undo / Redo
`Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`). Up to 50 steps of history.

### Navigation
Clicking a related pin in a region's detail panel (or vice versa) pushes a back-navigation entry, letting you return with the **←** button.

### Layers
The layer strip (top-left) lists layers bottom → top; higher layers draw above lower ones.

- Only the active layer is interactive. Other layers are dimmed and ignore clicks; switch layers by clicking a chip.
- New annotations go on the active layer, and the brush/eraser only affect it.
- In Design Mode: **+** adds a layer; double-click a chip (or press `F2` on it) to rename; drag a chip, press `Alt`+`←`/`→` on it, or use the arrows beside the layer's name in the right panel to reorder; **×** (click twice) deletes a layer along with its contents.
- Move an item between layers with the **Layer** dropdown in its editor. Regions on different layers can't be merged.

### Nesting
Every region and pin can have a parent region on another layer, forming a tree.

- Parents are assigned automatically: the region on the nearest layer below that covers most of the item. Empty layers are skipped.
- Pins can also nest in a region on their own layer (checked first), so a city pin placed on a provinces layer lands in its province. Regions always nest across layers.
- Links are recalculated when an item is created, reshaped or moved between layers, or when its parent is deleted. **Reordering layers does not change them.** Use **Re-nest layer** / **Re-nest all** (right panel, nothing selected) to reassign after a reorder.
- Set a parent by hand with the **Parent** dropdown in the editor. Manual parents are kept through re-nesting; choose **Auto** to go back.
- A selected item's panel shows a breadcrumb of its ancestors and an expandable **Contains** tree of its children; click any entry to jump to it.

### Map Files

A map (title, layers, regions, pins and the map image) can be saved as one `.imap.json` file. The **Map** pocket at the foot of the tool roll (Design Mode) opens the map's flap: its title, **Upload image**, the **Export** / **Import** buttons and **New map**; you can also drop a `.imap.json` file anywhere on the map to open it.

- **Export** downloads `<title>.imap.json`. The image is embedded, so the file opens anywhere; the bundled world map (`maps/…`) is stored as a reference instead, since it ships with the app.
- **Import** replaces the current map. If the current map has content you're asked first, with an option to export it before replacing. Undo history starts fresh with the opened map.
- **New map** starts a blank map (no places, one layer, no image of its own) in place of the current one, after asking, with the same option to export first.
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

Click **Share** (top-right). The dialog offers two kinds of link.

**Link to a map file** (recommended; includes the image, any size):
1. **Export** the map (Map flap).
2. Create a gist at [gist.github.com](https://gist.github.com) (a *secret* gist is fine: it's unlisted but viewable by anyone with the link) and drop the `.imap.json` file into it.
3. Paste the gist's address into the Share dialog and copy the link it builds: `…/?gist=you/abc123`.

- Viewers get the map display-only. Tick **Let viewers edit** to allow Design Mode (`&edit=1`); their changes aren't saved unless they choose to keep the map.
- A gist link always opens the gist's latest version, so updating the gist updates the map for everyone (GitHub caches it for about 5 minutes). Pasting a raw link that pins a revision still links to the latest.
- Any `.imap.json` the browser may fetch works too: `?project=<url>`, for a file on the same site or on a host that allows cross-site requests.
- The link points at wherever you're running the app, so copy it from the hosted app: a link made on a local copy (`localhost`) works only on your computer, and the dialog says so.
- Opening a linked map never touches the viewer's own saved map. If the file can't be loaded, a message on the map says why.

**Quick link** (annotations only, encoded in the URL itself):

- **Lock Design Mode**: check this before copying the link to prevent the viewer from editing.
- The map image is not included in the link. Recipients get the baseline map if the site serves one (the link keeps any `?map=`); otherwise they must upload it themselves.
- Locked links hide the Design / Display switch entirely. Unlocked links let the viewer edit freely.
- Links are compressed; the dialog shows the link size and warns when it's long enough that some apps may cut it off. Older uncompressed links still open.
- Everything in a link is treated as untrusted: ids, colours and coordinates are validated on load, and descriptions are sanitized before their Markdown is rendered.
- Locking is a convenience, not access control: anyone can edit the link itself.
- A shared map opens separately from your own: unlocked links can be edited, but nothing is saved (a notice in the Map flap says so; it opens by itself the first time you switch to Design Mode) until you click **Keep as my map**, which replaces your saved map.

---

## Data Persistence

The current map autosaves to the browser's IndexedDB after every edit: annotations, title and an uploaded image, so everything (image included) comes back on the next visit. Baseline maps aren't stored, since they're loaded from their file each time. Where IndexedDB isn't available, only the annotations are saved, to `localStorage` (not the image or title). Maps saved in `localStorage` by older versions are moved over automatically.

Saved data lives in this browser only. Use **Export** to keep a copy or move a map elsewhere.

- The map's own image is kept even when something else is on screen: opening with `?map=…`, or a fallback to the baseline because the image couldn't load, never replaces the saved image.
- The image and the annotations are written separately, so if the image can't be stored (e.g. storage is full) the annotations still save, and the Map flap says the image wasn't saved until it is (and its pocket shows a red dot).
- A saved map that can't be read is left untouched: the session opens empty and doesn't save until you import a map.
- If no image can be shown at all, the placeholder offers to discard the saved map (after confirming).
- Several tabs on the same map: the last one to save wins.

---

## Running Your Own Copy

### Locally

The app uses ES modules and a Web Worker, so it must be served over HTTP. Opening `index.html` directly as a `file://` URL will not work.

```bash
python3 -m http.server 8080   # or: npx serve .
```

Then open `http://localhost:8080`.

**Flood Region** runs on a small WebAssembly module (`processor.js` + `processor.wasm`) that isn't in the repo, so a fresh clone has to build it once (below). Everything else works without it.

### Building the WASM Module

```bash
cd wasm
make
```

Requires [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) installed to `~/.emsdk`. Rebuild after changing `wasm/processor.cpp`.

### Deploying

Pushes to `main` of the [cairn-atlas/cairn-atlas.github.io](https://github.com/cairn-atlas/cairn-atlas.github.io) repository deploy to GitHub Pages through `.github/workflows/pages.yml` (in any other copy of the repo the job is skipped). It builds the WASM module and publishes only what the browser needs (`index.html`, `style.css`, the scripts, `processor.wasm` and `maps/world.png`).

### Code Layout

Plain ES modules, no build step. `app.js` is the entry point (mode, tools, map and keyboard events, startup); the rest:

| Module | Holds |
|---|---|
| `state.js` | shared app state and the Leaflet layer registry |
| `persistence.js` | autosave (IndexedDB, with a `localStorage` fallback) and sanitizing loaded data |
| `project.js` | map files: the format, export, import, opening `?gist=` / `?project=` links, the Map flap |
| `nesting.js` | parent links, auto-nesting, tree lookups |
| `map.js` | the Leaflet map |
| `render.js` | drawing annotations, stacking order, what's clickable, faded or hidden |
| `labels.js` | placing pin names so they don't collide, thinned by layer |
| `selection.js` | selection and back/up navigation |
| `panel.js` | the right panel: layer list, details, editor, tree |
| `flap.js` | the tool roll's flap: the tool in hand (or the map file), how to use it, its settings and keys |
| `layerstrip.js` | the layer chips and moving items between layers |
| `create.js` | new pins and regions, colours, deletion |
| `shapes.js` | merge, consolidate, vertex edit, brush, eraser |
| `wand.js` | flood fill via the WASM worker |
| `image.js` | the map image: upload, paste, baseline file, and how it's saved |
| `share.js` | share links: encoding and the dialog |
| `history.js` | undo/redo |
| `utils.js` | small shared helpers |

Modules import each other in cycles. That's safe because only `app.js` runs code at load time; the others just declare functions and attach listeners to their own elements.

`maps/render_world.py` regenerates the bundled world map (see [Upload a Map](#upload-a-map)).
