# Guide Master (Photoshop UXP plugin)

Requires Photoshop 23.3 or newer. The plugin ID is `GuideMasterPhotoshop` so
installing the InDesign edition cannot overwrite this edition. See the root
README for version 1.0.1 upgrade and preset migration instructions.

Adds 8 commands:

- **Copy Guides**
- **Paste Guides**
- **Create Guide…**
- **Clear All Guides**
- **Save Guide Preset…**
- **Load Guide Preset…**
- **Manage Presets…**
- **Help…**

## What it does

- **Copy Guides**: reads all guides from the current (active) document into an in-memory clipboard.
- **Paste Guides**: overwrites guides in the current (active) document with the copied guides.

- **Create Guide…**: lets you generate **Columns**, **Rows**, or a full **Grid**.
   - Uses a single compact dialog with grouped **Overview**, **Structure**, and **Margins** sections
   - **Columns**: prompts for **column count**, **spacing units**, **column gutter**, **left margin**, and **right margin**
   - **Rows**: prompts for **row count**, **spacing units**, **row gutter**, **top margin**, and **bottom margin**
   - **Grid**: prompts for **column count**, **row count**, **spacing units**, **column gutter**, **row gutter**, and all four margins
   - Spacing can be entered in **pixels** or Photoshop's current **ruler units**
   - After you enter row/column counts, gutters and margins are auto-filled with sensible defaults that you can still override
   - Invalid layouts are flagged in the dialog and **Create** stays disabled until the values fit the document
   - Creates vertical guides, horizontal guides, or both depending on the selected layout
   - If the document already has guides, you can **Replace** or **Merge**

- **Clear All Guides**: removes all guides from the current (active) document.

- **Save Guide Preset…**: saves the current document’s guide layout into a named preset (persisted to disk).
   - Presets store the source document’s **width**, **height**, and **DPI** alongside the guides.
   - If the preset name already exists, you can **Replace** (overwrite) or **Merge** (combine + skip duplicates).
- **Load Guide Preset…**: loads a saved preset into the current document.
   - If the preset came from a different document size or DPI, you can **Resize Document** to match the preset, **Apply to Current Layout** and scale the guides into the active document, or **Apply Without Rescaling** to use the saved guide coordinates as-is.
   - If the document already has guides, you can **Replace** (remove existing) or **Merge** (add missing + skip duplicates).

- **Manage Presets…**: manage/backup/restore presets:
   - **Rename…**
   - **Delete…**
   - **Export…** (backup one preset to a JSON file)
   - **Export All…** (backup all presets to a single JSON file)
   - **Import…** (restore presets from a JSON file)
   - Imported JSON files also retain each preset’s original source **width**, **height**, and **DPI**.
   - When importing into an open document, you can keep the original exported layout or scale imported guides so the stored presets match the current document layout.

This supports pasting into a new document: create/open the destination doc, make it active, then run **Paste Guides**.

## Install (development)

1. Install **UXP Developer Tool** (via Creative Cloud Desktop).
2. In UXP Developer Tool, click **Add Plugin…** and select this folder:

   `ps-copy-paste-guides`

3. Click **Load**.
4. In Photoshop, run the commands from:

   **Plugins → Guide Master → Copy Guides**
   **Plugins → Guide Master → Paste Guides**
   **Plugins → Guide Master → Create Guide…**
   **Plugins → Guide Master → Clear All Guides**
   **Plugins → Guide Master → Save Guide Preset…**
   **Plugins → Guide Master → Load Guide Preset…**
   **Plugins → Guide Master → Manage Presets…**

## Notes

- The guide clipboard is stored in memory; it persists while Photoshop is running.
- Presets are stored in the plugin’s data folder (a JSON file) so they persist across Photoshop restarts.
- UXP plugins (as of today) expose command entrypoints under the **Plugins** menu. If you specifically need these commands under the built-in **Edit** menu, that generally requires a different kind of plugin (C++ / legacy extensibility).

## Icons

This plugin includes theme-aware icons in the `icons/` folder (dark + light, 1x + 2x). They are referenced from `manifest.json` via the root-level `icons` array.

## Packaging (.ccx)

Photoshop UXP plugins are distributed as a `.ccx` file.

1. Make sure the plugin loads and works via the UXP Developer Tool.
2. (For real distribution) get a real plugin id from Adobe Developer Distribution, then replace the `id` in `manifest.json`.
   - The current id (`GuideMasterPhotoshop`) is for local distribution; obtain a registered ID for marketplace distribution. Never reuse the InDesign edition's ID.
3. In **UXP Developer Tool**, find the plugin and choose **Actions (⋯) → Package**.
4. Pick an output folder. UDT will create a `.ccx`.
5. Test the packaged build:
   - Double-click the `.ccx` and install locally via Creative Cloud.
   - Relaunch Photoshop and confirm the commands appear under **Plugins → Guide Master**.
