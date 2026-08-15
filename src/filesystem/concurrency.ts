/**
 * Per-file mutation serialization (spec §28).
 *
 * All hybrid mutations to the same real target serialize through pi's
 * `withFileMutationQueue`, keyed by the resolved real target so that two
 * symlink aliases of one file cannot interleave.
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export { withFileMutationQueue };
