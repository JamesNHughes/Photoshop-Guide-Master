# Guide Master — Photoshop UXP Plugin

**Guide Master** is a Photoshop UXP plugin that gives you full control over guides — generate precise column, row, and grid layouts in seconds, copy them between documents, and save unlimited named presets that travel with you across projects and document sizes.

---

## Why Guide Master?

Photoshop's built-in guide tools are manual and tedious. Guide Master replaces that workflow with a flexible, calculation-aware system:

- **Generate guides mathematically** — define column/row counts, gutters, and margins and let the plugin do the maths. Supports pixels and any Photoshop ruler unit.
- **Copy & paste layouts between documents** — capture the exact guide layout from one document and apply it to any other in one click.
- **Save and reuse named presets** — store guide layouts by name for reuse across projects. Presets remember the source document's size and DPI, so you can scale them intelligently when document dimensions differ.
- **Merge or replace** — every destructive operation gives you the choice to merge (add missing guides, skip duplicates) or replace (start fresh), so you never accidentally lose work.
- **Backup and restore** — export individual presets or your entire preset library to JSON, then import them on any machine.

---

## Commands

| Command | Description |
|---|---|
| **Copy Guides** | Copies all guides from the active document into an in-memory clipboard |
| **Paste Guides** | Applies the copied guides to the active document (replace or merge) |
| **Create Guide…** | Generates a column, row, or full grid layout with gutters and margins |
| **Clear All Guides** | Removes all guides from the active document |
| **Save Guide Preset…** | Saves the current guide layout as a named, persistent preset |
| **Load Guide Preset…** | Applies a saved preset, with optional rescaling if document size differs |
| **Manage Presets…** | Rename, delete, export, import, and backup your preset library |

---

## Create Guide — Flexibility Highlights

The **Create Guide** dialog is designed to eliminate guesswork:

- Choose **Columns**, **Rows**, or **Grid** layout from a single compact dialog
- Enter counts, gutters, and individual margins (left/right for columns, top/bottom for rows, all four for grids)
- Switch spacing units between **pixels** and **Photoshop's current ruler units** at any time
- Gutters and margins are **auto-filled with sensible defaults** after you enter counts — override them freely
- **Live validation** prevents creating an invalid layout: the Create button stays disabled and invalid fields are highlighted until values fit within the document
- If guides already exist, choose to **Replace** (remove existing) or **Merge** (add only missing guides)

---

## Preset System — Flexibility Highlights

Presets store not just guide positions but the **source document's width, height, and DPI**, unlocking smart rescaling options at load time:

- **Resize Document** — resize the active document to exactly match the preset's original dimensions
- **Apply to Current Layout** — scale guide positions proportionally to fit the active document
- **Apply Without Rescaling** — use saved coordinates as-is regardless of document size

When importing a preset library, the same rescaling choice applies so imported presets can immediately match your current working document.

---

## Install (Development)

1. Install **UXP Developer Tool** via Creative Cloud Desktop.
2. Open UXP Developer Tool → **Add Plugin…** → select the `ps-copy-paste-guides` folder.
3. Click **Load**.
4. Commands appear in Photoshop under **Plugins → Guide Master**.

## Packaging for Distribution

1. Confirm the plugin loads correctly via UXP Developer Tool.
2. For marketplace distribution, replace the plugin `id` in `manifest.json` with one obtained from [Adobe Developer Distribution](https://developer.adobe.com/distribute/home).
3. In UXP Developer Tool: **Actions (⋯) → Package** → choose an output folder.
4. Distribute the resulting `.ccx` file.

---

## License

MIT — see [LICENSE](LICENSE)
