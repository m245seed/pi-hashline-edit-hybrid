/**
 * Canonical protocol identifiers (spec §31, PI:12).
 * Single source of truth for IPC and tool description strings.
 */
export const HASHLINE_PROTOCOL_ID = "pi-hashline/1" as const;
export const IPC_PROTOCOL_ID = "pi-sentinel-hashline/1" as const;
export const HASHLINE_RESULT_PROTOCOL = "pi-hashline-result/1" as const;
export const PACKAGE_NAME = "pi-hashline-edit-hybrid" as const;
export const PACKAGE_VERSION = "0.1.0" as const;

export const PROTOCOL_IDS = {
  hashline: HASHLINE_PROTOCOL_ID,
  ipc: IPC_PROTOCOL_ID,
  result: HASHLINE_RESULT_PROTOCOL,
} as const;
