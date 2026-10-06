# MinimalCAD Web

A browser-based port of MinimalCAD's core drafting/editing toolset — TypeScript + Vite, no server, no install. Builds to plain static files you can open directly or host anywhere.

## Cloud: MinimalERP's sign-in and item master

Without signing in, everything works on local files, as a plain static site.

Signed in (the **same** email and password as MinimalERP — this app uses MinimalERP's Supabase project, and is served from the same origin, so a person signed in there is signed in here), the Cloud panel shows:

- **Parts Library — item master**: the company's stock items from MinimalERP, each with any number of CAD files. Open a file (the tab stays linked: **Save** writes it back to the item), Insert one into the drawing, or **Save here** to add this drawing to an item. Items are created, and files deleted, in MinimalERP.
- **My Drawings**: a person's own drawings and the autosave slot.

Reads go straight to the tables (Row Level Security); every write goes through MinimalERP's `cad` Edge Function (`src/io/cloudApi.ts`). The tables and the function live in the MinimalERP repository (`supabase/migrations/20261026000100_cad.sql`, `supabase/functions/cad`); the `supabase/` folder here is the earlier, separate database and is no longer used by the site.

MinimalERP opens a file here with `#/item-file/<id>`.

## Running it

```bash
npm install
npm run dev       # dev server with hot reload
npm run build     # type-checks, then builds dist/ as static files
npm run preview   # serves the built dist/ locally
npm test          # runs the vitest suite
npm run lint       # eslint
```

## What's implemented (v1)

- **Draw**: Line, Circle, Arc, Rectangle (draws 4 independent Lines, matching the desktop app), Polyline (load/render/edit only — no draw tool yet)
- **Edit**: Move, Copy (incl. array-copy count), Rotate, Scale, Mirror, Trim, Offset, Fillet (Line-Line, Line-Arc, Arc-Arc), Chamfer — every drawable entity type (Line/Circle/Arc) works with every edit command that geometrically applies to it (Fillet/Chamfer never applied to whole circles in the desktop app either — that's not a gap)
- **Selection**: click, Shift-additive, window/crossing rubber-band, direct click-drag, Delete
- **Grips**: line endpoint extend, line/circle move, circle radius resize
- **Object snap — all types**: Endpoint, Intersection, Midpoint, Center, Quadrant, Perpendicular, Tangent, Center-via-curve-hover, Nearest (full priority-ordered search, matching the desktop app's own osnap system exactly)
- Pan/zoom, adaptive grid, Ortho (F8), Home overlay button (top-right, same position/size/style as the desktop app) + Space bar, typed dynamic input (`x,y` / `dist<angle` / bare distance / arithmetic expressions), Tab-to-freeze-and-select dynamic input fields
- Undo/redo, Save/Open as **`.jcad`** — byte-for-byte the same format as the desktop app (`file_io/jcad.py`: flat `{entities, constraints, version}` JSON, `indent=2`) — a drawing saved by either app opens correctly in the other; unsupported entity types (Ellipse/Text/Table/Dimension) are skipped gracefully on load, not fatal

## Known v1 scope limits (deliberate, not oversights)

- No Ellipse, Text, Table, Dimension/Leader entities yet
- No DXF import/export, PDF export, parts library, or distance constraints
- No Polyline drawing tool (existing polylines load/render/edit fine); Trim/Offset don't yet treat a Polyline as a cutting edge or offset it (self-trim/offset needs vertex-chain rebuilding, a separate substantial piece)

## Architecture

Mirrors the desktop app's own structure closely (see file header comments throughout for the exact Python source each module ports): `entities/` (geometry + serialize/draw/hitTest), `commands/` (one state machine per tool, dispatched via `commands/manager.ts`), `engine/` (viewport, picking, snapping — deliberately DOM-free so command logic is unit-testable), `geometry/` (pure math: intersections, arc fitting, reflection), `ui/` (canvas rendering + DOM chrome), `io/` (save/load).
