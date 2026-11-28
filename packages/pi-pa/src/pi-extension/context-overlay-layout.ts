import type { OverlayOptions } from "@earendil-works/pi-tui";

const SHARED_CONTEXT_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "top-right",
  width: "68%",
  minWidth: 42,
  maxHeight: "90%",
  margin: { right: 1 },
  visible: (terminalWidth) => terminalWidth >= 120,
};

const READER_CONTEXT_OVERLAY_OPTIONS: OverlayOptions = {
  ...SHARED_CONTEXT_OVERLAY_OPTIONS,
  visible: (terminalWidth, terminalHeight) => terminalWidth >= 100 && terminalHeight >= 6,
};

export function readerContextOverlayOptions(): OverlayOptions {
  return READER_CONTEXT_OVERLAY_OPTIONS;
}

export function contextOverlayOptions(): OverlayOptions {
  return SHARED_CONTEXT_OVERLAY_OPTIONS;
}
