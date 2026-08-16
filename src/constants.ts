/** Resource-control limits (spec §53). */
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_LINES = 250_000;
export const MAX_DISPLAY_LINE_BYTES = 200 * 1024;
export const MAX_FEEDBACK_LINES = 100;
/** Default page size for read. */
export const DEFAULT_READ_LIMIT = 2000;
/**
 * Post-write auto-read preview limits (PH-WRITE-002): independent default of
 * 100 lines plus a total byte cap.
 */
export const AUTO_READ_MAX_LINES = 100;
export const AUTO_READ_MAX_BYTES = 64 * 1024;
/** Total output budgets (PH-OUTPUT-003). */
export const READ_MAX_OUTPUT_BYTES = 512 * 1024;
export const DIFF_MAX_OUTPUT_BYTES = 256 * 1024;
export const SNIFF_BYTES = 8192;
export const STALE_TEMP_MS = 60 * 60 * 1000;
export const ANCHOR_SPACE_PRESSURE_RATIO = 0.95;

/**
 * Large destructive edit guard thresholds (PH-EDIT-006..008). Configurable:
 * mutate this object (e.g. from Sentinel policy integration) to adjust.
 */
export const largeEditGuard = {
  /** Reject when removedLines >= minRemovedLines AND the ratio test passes. */
  minRemovedLines: 20,
  /** Reject when removedLines > removedRatio * max(1, addedLines). */
  removedRatio: 3,
};

/** Persistent store tuning (spec §49). */
export const DB_BUSY_TIMEOUT = 1000;
export const DB_BUSY_RETRIES = 3;
export const DB_BUSY_RETRY_DELAY_MS = 100;
export const SCHEMA_VERSION = 1;
