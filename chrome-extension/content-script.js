// Content script to capture right-click position for image extraction
// This helps work around div overlays (like on Instagram) that hide images
// Running in MAIN world to share variables with executeScript

// Store the last right-click position in the global window scope
// so background script can access it via executeScript
if (!window.tokoroExtension) {
  window.tokoroExtension = {
    lastContextMenuPosition: { x: 0, y: 0 },
  };

  //console.log('[Tokoro] Content script loaded and ready');

  // Listen for contextmenu events (right-click)
  document.addEventListener(
    'contextmenu',
    event => {
      window.tokoroExtension.lastContextMenuPosition = {
        x: event.clientX,
        y: event.clientY,
      };

      console.log(
        '[Tokoro] Captured right-click at position:',
        window.tokoroExtension.lastContextMenuPosition
      );
    },
    true
  );
}
