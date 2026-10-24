/**
 * ConnectionManager - A reference-counted connection manager for SpacetimeDB.
 *
 * This module implements a TanStack Query-style pattern for managing WebSocket
 * connections in React applications. It solves the React StrictMode double-mount
 * problem by using reference counting and deferred cleanup.
 *
 * ## How it works:
 *
 * 1. **Reference Counting**: Each `retain()` increments a counter, `release()` decrements it.
 *    The connection is only closed when the count reaches zero.
 *
 * 2. **Deferred Cleanup**: When refCount hits zero, cleanup is scheduled via `setTimeout(0)`.
 *    This allows React StrictMode's rapid unmount→remount cycle to cancel the cleanup.
 *
 * 3. **useSyncExternalStore Integration**: The `subscribe()` and `getSnapshot()` methods
 *    are designed to work with React's `useSyncExternalStore` hook for tear-free reads.
 *
 * ## StrictMode Lifecycle:
 *
 * ```
 * Mount   → retain()  → refCount: 0→1, connection created
 * Unmount → release() → refCount: 1→0, cleanup SCHEDULED (not executed)
 * Remount → retain()  → refCount: 0→1, cleanup CANCELLED
 * Result: Single WebSocket survives ✓
 * ```
 *
 * ## Reconnection:
 *
 * The manager forces {@link DbConnectionBuilder.withAutomaticReconnect} on
 * every builder it builds from, so a connection lost mid-session reconnects
 * *inside* the `DbConnection`: the object, its table handles and its callbacks
 * all survive, and the manager merely mirrors the lifecycle events into its
 * state snapshots. The manager itself rebuilds a connection only when the SDK
 * reports it will not retry (a failed initial connection, or another terminal
 * failure), preserving the frameworks' historical keep-trying behavior.
 *
 * @module connection_manager
 */
import type { DbConnectionBuilder, DbConnectionImpl } from './db_connection_impl';
import type { Identity } from '../lib/identity';
import { ConnectionId } from '../lib/connection_id';
/** Represents the current state of a managed connection. */
export type ConnectionState = {
    isActive: boolean;
    identity?: Identity;
    token?: string;
    connectionId: ConnectionId;
    connectionError?: Error;
};
type Listener = () => void;
export declare const CONNECTION_MANAGER_RECONNECT_BASE_DELAY_MS = 1000;
export declare const CONNECTION_MANAGER_RECONNECT_MAX_DELAY_MS = 30000;
/**
 * Computes the rebuild delay for the given attempt (0-based) using
 * exponential backoff: the base delay doubles with each consecutive failed
 * attempt, capped at the maximum delay.
 *
 * This paces only the manager's own rebuild loop for failures the SDK will
 * not retry; reconnects after a mid-session drop are paced by the SDK's own
 * policy (see `computeReconnectDelayMs` in `db_connection_impl`).
 */
export declare function connectionManagerReconnectDelayMs(attempt: number): number;
/**
 * Singleton manager for SpacetimeDB connections.
 * Use the exported `ConnectionManager` instance rather than instantiating directly.
 */
declare class ConnectionManagerImpl {
    #private;
    /** Generates a unique key for a connection based on URI and module name. */
    static getKey(uri: string, moduleName: string): string;
    /** Instance method wrapper for getKey. */
    getKey(uri: string, moduleName: string): string;
    /**
     * Retains a connection, incrementing its reference count.
     * Creates the connection on first call; returns existing connection on subsequent calls.
     * Cancels any pending release if the connection was about to be cleaned up.
     *
     * @param key - Unique identifier for the connection (use getKey to generate)
     * @param builder - Connection builder to create the connection if needed
     * @returns The managed connection instance
     */
    retain<T extends DbConnectionImpl<any>>(key: string, builder: DbConnectionBuilder<T>): T;
    /**
     * Tears down the current connection and builds a fresh one from `builder`,
     * preserving the entry's ref count and listener set.
     *
     * `retain()` deliberately ignores the builder once a connection is live —
     * the right behaviour for ref-counting, but it blocks "reconnect with a
     * fresh token" flows (e.g. swapping an anonymous session for a signed-in one
     * after an auth change). `rebuild()` is the supported escape hatch: pass a
     * builder carrying the new token and the pool swaps the live connection
     * under the same subscribers, so framework hooks (`useTable`, `useReducer`,
     * …) re-bind to the new connection automatically.
     *
     * The old connection's callbacks are detached before it is closed, so its
     * disconnect event never leaks into pool state, and any pending rebuild is
     * cancelled (the caller is driving the replacement explicitly). Returns the
     * newly-built connection, or `null` if the key has no retained entry.
     *
     * @param key - Unique identifier for the connection (use getKey to generate)
     * @param builder - Fresh connection builder; its handlers are rewired into the pool
     */
    rebuild<T extends DbConnectionImpl<any>>(key: string, builder: DbConnectionBuilder<T>): T | null;
    release(key: string): void;
    subscribe(key: string, listener: Listener): () => void;
    getSnapshot(key: string): ConnectionState | undefined;
    getConnection<T extends DbConnectionImpl<any>>(key: string): T | null;
}
export declare const ConnectionManager: ConnectionManagerImpl;
export {};
//# sourceMappingURL=connection_manager.d.ts.map