import { type Writable } from 'svelte/store';
import { DbConnectionBuilder, type DbConnectionImpl } from '../sdk/db_connection_impl';
import { type ConnectionState } from './connection_state';
/**
 * Establish a SpacetimeDB connection for the current component subtree and make
 * it available to `useSpacetimeDB`, `useTable` and `useReducer`.
 *
 * The connection is owned by the shared `ConnectionManager` (the same pool the
 * React and Solid bindings use), keyed by uri + database name. The manager's
 * reference counting and deferred cleanup absorb rapid mount/unmount cycles
 * (HMR, `{#key}` blocks), and it reconnects automatically with exponential
 * backoff if the socket drops unexpectedly.
 *
 * To swap the connection's auth token without reloading the page (e.g. after a
 * sign-in), call `reconnect(builder)` from the context value with a builder
 * carrying the new token.
 */
export declare function createSpacetimeDBProvider<DbConnection extends DbConnectionImpl<any>>(connectionBuilder: DbConnectionBuilder<DbConnection>): Writable<ConnectionState>;
//# sourceMappingURL=SpacetimeDBProvider.d.ts.map