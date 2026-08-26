/**
 * Shared mutation result types (PI:9).
 * Single definition for MutationMetrics and base tool details.
 */
export interface MutationMetrics {
  classification: "applied" | "noop";
  edits_attempted: number;
  edits_applied: number;
  edits_noop: number;
  lines_added: number;
  lines_removed: number;
  warnings: number;
  before_revision: string;
  after_revision: string;
  transaction_id: string | null;
}

export interface HashlineToolDetailsBase {
  diff?: string;
  metrics?: MutationMetrics;
  hashline: ReturnType<typeof import("../render/result-details").hashlineDetails>;
}

export function extractWarningCodes(details: string): string[] {
  const matches = details.match(/W_[A-Z_]+/g);
  return matches ? [...new Set(matches)] : [];
}
