/* global module */

// Keep Photoshop's modal scope alive until the native dialog promise settles.
// Waiting only for a DOM close event can strand the command when opening fails
// or the user dismisses the window with Escape / the title-bar close button.
async function showPluginDialog(dialog, core, onShow) {
  return await core.executeAsModal(async () => {
    const closed = dialog.uxpShowModal({
      title: "Guide Master",
      resize: "none"
    });
    try {
      // Focus is cosmetic and must not interrupt the native dialog lifecycle.
      try { if (onShow) onShow(); } catch { /* host may not allow focus yet */ }
      const result = await closed;
      return result === "reasonCanceled" || !result ? "cancel" : result;
    } finally {
      try { dialog.close(); } catch { /* already closed */ }
    }
  }, { commandName: "Guide Master dialog", interactive: true });
}

module.exports = { showPluginDialog };
