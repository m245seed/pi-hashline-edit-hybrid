/** Resource-control limits (spec §53). */
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_LINES = 250_000;
export const MAX_DISPLAY_LINE_BYTES = 200 * 1024;
export const MAX_FEEDBACK_LINES = 100;
/** Default page size for read and the post-write auto-read preview. */
export const DEFAULT_READ_LIMIT = 2000;
export const AUTO_READ_MAX_LINES = DEFAULT_READ_LIMIT;
export const SNIFF_BYTES = 8192;
export const STALE_TEMP_MS = 60 * 60 * 1000;
export const ANCHOR_SPACE_PRESSURE_RATIO = 0.95;

/** Persistent store tuning (spec §49). */
export const DB_BUSY_TIMEOUT = 1000;
export const DB_BUSY_RETRIES = 3;
export const DB_BUSY_RETRY_DELAY_MS = 100;
export const SCHEMA_VERSION = 1;
