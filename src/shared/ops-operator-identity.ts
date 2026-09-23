/**
 * The `/opsapi/nodes` operator plane's own creator-ledger identity (`node-ops.ts` `create()` stamps
 * every node it spawns with this as the ownership record's `sourceNodeId`, never a live node id).
 *
 * Lives here, in `shared/`, rather than in `server/node-ops.ts` where it originated, so that
 * `core/orphan-adoption.ts` (which must stay dependency-free of `server/`) and
 * `server/headless-node-factory.ts` (the OPTIONAL verified-node control plane, which must not gain
 * a hard dependency on the always-on ops plane) can both import the one constant without a new
 * coupling in either direction.
 *
 * Charset-constrained to `isSafeNodeId` ([A-Za-z0-9._-]): the durable ownership ledger
 * (`node-ownership-store.ts` `record()`) silently refuses (fails closed) any sourceNodeId outside
 * that charset, so this string must stay inside it or the ownership stamp becomes a silent no-op.
 */
export const OPS_OPERATOR_SOURCE_ID = 'ops-operator'
