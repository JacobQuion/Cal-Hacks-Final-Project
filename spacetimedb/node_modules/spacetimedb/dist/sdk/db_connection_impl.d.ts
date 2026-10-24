import { ConnectionId, ProductType } from '../';
import { AlgebraicType } from '../';
import { DbConnectionBuilder } from './db_connection_builder.ts';
import { INTERNAL_REMOTE_MODULE } from './internal.ts';
import { type DbContext } from './db_context.ts';
import type { Event } from './event.ts';
import { type ErrorContextInterface, type EventContextInterface, type ReducerEventContextInterface, type SubscriptionEventContextInterface } from './event_context.ts';
import { EventEmitter } from './event_emitter.ts';
import type { Identity } from '../';
import type { ReducerEvent } from './reducer_event.ts';
import { type UntypedRemoteModule } from './spacetime_module.ts';
import { type NamespacedQueryBuilder } from '../lib/query';
import { type TableCache } from './table_cache.ts';
import { SubscriptionBuilderImpl, SubscriptionHandleImpl, type SubscribeEvent } from './subscription_builder_impl.ts';
import type { ReducersView, SubscriptionEventCallback } from './reducers.ts';
import type { ClientDbView } from './db_view.ts';
import type { UntypedSchemaDef } from '../lib/schema';
import type { ProceduresView } from './procedures.ts';
import { type WebSocketFactory } from './ws.ts';
export { DbConnectionBuilder, SubscriptionBuilderImpl, SubscriptionHandleImpl, type TableCache, type Event, };
export type RemoteModuleOf<C> = C extends DbConnectionImpl<infer RM> ? RM : never;
export type { DbContext, EventContextInterface, ReducerEventContextInterface, SubscriptionEventContextInterface, ErrorContextInterface, ReducerEvent, };
export type ConnectionEventArgs = {
    connect: [identity: Identity, token: string];
    automaticReconnect: [identity: Identity, token: string];
    disconnect: [
        error?: Error,
        nextReconnectAttempt?: number,
        nextReconnectDelayMs?: number
    ];
    connectError: [
        error: Error,
        nextReconnectAttempt?: number,
        nextReconnectDelayMs?: number
    ];
};
export type ConnectionEvent = keyof ConnectionEventArgs;
export type DbConnectionConfig<RemoteModule extends UntypedRemoteModule> = {
    uri: URL;
    nameOrAddress: string;
    identity?: Identity;
    token?: string;
    emitter: EventEmitter<ConnectionEvent>;
    createWSFn: WebSocketFactory;
    compression: 'gzip' | 'brotli' | 'none';
    lightMode: boolean;
    confirmedReads?: boolean;
    remoteModule: RemoteModule;
    /**
     * Whether the connection reconnects on its own after losing its socket.
     * Set by {@link DbConnectionBuilder.withAutomaticReconnect}.
     */
    automaticReconnect?: boolean;
    /**
     * Supplies a fresh token for a reconnect attempt.
     * Set by {@link DbConnectionBuilder.withTokenProvider}.
     */
    tokenProvider?: TokenProvider;
    /**
     * Backoff bounds for reconnect attempts.
     * Set by {@link DbConnectionBuilder.withAutomaticReconnect}.
     */
    reconnectPolicy?: ReconnectPolicy;
};
/**
 * Supplies an authentication token, called before a reconnect attempt whose
 * retained token is close to expiring.
 */
export type TokenProvider = () => Promise<string>;
/** The default delay before the first reconnect attempt. */
export declare const RECONNECT_INITIAL_DELAY_MS = 1000;
/** The default upper bound on the delay between reconnect attempts. */
export declare const RECONNECT_MAX_DELAY_MS = 30000;
/** The random spread applied to each reconnect delay. */
export declare const RECONNECT_JITTER = 0.5;
/** The lowest `minDelayMs` accepted; smaller values are raised to this. */
export declare const RECONNECT_MIN_DELAY_FLOOR_MS = 500;
/** The lowest `maxDelayMs` accepted; smaller values are raised to this. */
export declare const RECONNECT_MAX_DELAY_FLOOR_MS = 1000;
/** Options for {@link DbConnectionBuilder.withAutomaticReconnect}. */
export type AutomaticReconnectOptions = {
    /**
     * The delay before the first reconnect attempt, and the floor for every
     * later one. Defaults to 1000 ms; values below 500 ms are raised to 500 ms.
     */
    minDelayMs?: number;
    /**
     * The cap on the delay between reconnect attempts. Defaults to 30000 ms;
     * values below 1000 ms (or below `minDelayMs`) are raised to that bound.
     */
    maxDelayMs?: number;
};
export type ReconnectPolicy = Required<AutomaticReconnectOptions>;
export declare const DEFAULT_RECONNECT_POLICY: ReconnectPolicy;
/** Fill in defaults and enforce the floors, warning when a value is raised. */
export declare function resolveReconnectPolicy(options?: AutomaticReconnectOptions): ReconnectPolicy;
/** Exponential backoff with jitter; attempt numbers start at one. */
export declare function computeReconnectDelayMs(attempt: number, random?: () => number, { minDelayMs, maxDelayMs }?: ReconnectPolicy): number;
/** Refresh unreadable tokens, or tokens within 5% of expiry (at least 30 seconds). */
export declare function tokenNeedsRefresh(token: string | undefined, nowMs?: number): boolean;
export declare class DbConnectionImpl<RemoteModule extends UntypedRemoteModule> implements DbContext<RemoteModule> {
    #private;
    /**
     * Whether or not the connection is active.
     */
    isActive: boolean;
    /**
     * Whether `disconnect()` has been called on this connection.
     * Once requested, the connection will not be reused: managed environments
     * (such as the React `SpacetimeDBProvider`) use this to avoid reconnecting
     * after an intentional disconnect.
     */
    isDisconnectRequested: boolean;
    /**
     * Whether the underlying websocket has entered `CLOSING` (2) or `CLOSED`
     * (3). This becomes true even when the browser never delivered an
     * `onclose` event, for example if the socket was torn down while the tab was
     * frozen or the machine was asleep. The liveness listeners (see
     * {@link DbConnectionImpl.#installLivenessListeners}) use this to detect
     * such "zombie" sockets when the page resumes and to force a reconnect.
     *
     * Returns false while the socket is still `CONNECTING`/`OPEN`, or before
     * the socket has been created.
     */
    get isSocketClosed(): boolean;
    /**
     * This connection's public identity.
     */
    identity?: Identity;
    /**
     * This connection's private authentication token.
     */
    token?: string;
    /** @internal */
    [INTERNAL_REMOTE_MODULE](): RemoteModule;
    /**
     * The accessor field to access the tables in the database and associated
     * callback functions.
     */
    db: ClientDbView<RemoteModule>;
    /**
     * The accessor field to access the reducers in the database.
     */
    reducers: ReducersView<RemoteModule>;
    /**
     * The accessor field to access the procedures in the database.
     */
    procedures: ProceduresView<RemoteModule>;
    /**
     * The `ConnectionId` of the connection to to the database.
     */
    connectionId: ConnectionId;
    private clientCache;
    private ws?;
    private wsPromise;
    constructor({ uri, nameOrAddress, identity, token, emitter, remoteModule, createWSFn, compression, lightMode, confirmedReads, automaticReconnect, tokenProvider, reconnectPolicy, }: DbConnectionConfig<RemoteModule>);
    /** True while the SDK is between a lost connection and a completed reconnect. */
    get isReconnecting(): boolean;
    subscriptionBuilder: () => SubscriptionBuilderImpl<RemoteModule>;
    getFromBuilder<SchemaDef extends UntypedSchemaDef>(): NamespacedQueryBuilder<SchemaDef>;
    registerSubscription(handle: SubscriptionHandleImpl<RemoteModule>, handleEmitter: EventEmitter<SubscribeEvent, SubscriptionEventCallback<RemoteModule>>, querySql: string[]): number;
    unregisterSubscription(querySetId: number): void;
    /**
     * Call a reducer on your SpacetimeDB module.
     *
     * @param reducerName The name of the reducer to call
     * @param argsSerializer The arguments to pass to the reducer
     */
    callReducer(reducerName: string, argsBuffer: Uint8Array, reducerArgs?: object): Promise<void>;
    /**
     * Call a reducer on your SpacetimeDB module with typed arguments.
     * @param reducerSchema The schema of the reducer to call
     * @param callReducerFlags The flags for the reducer call
     * @param params The arguments to pass to the reducer
     */
    callReducerWithParams(reducerName: string, _paramsType: ProductType, params: object): Promise<void>;
    /**
     * Call a reducer on your SpacetimeDB module.
     *
     * @param procedureName The name of the reducer to call
     * @param argsBuffer The arguments to pass to the reducer
     */
    callProcedure(procedureName: string, argsBuffer: Uint8Array): Promise<Uint8Array>;
    /**
     * Call a reducer on your SpacetimeDB module with typed arguments.
     * @param reducerSchema The schema of the reducer to call
     * @param callReducerFlags The flags for the reducer call
     * @param params The arguments to pass to the reducer
     */
    callProcedureWithParams(procedureName: string, _paramsType: ProductType, params: object, _returnType: AlgebraicType): Promise<any>;
    /**
     * Close the current connection.
     *
     * @example
     *
     * ```ts
     * const connection = DbConnection.builder().build();
     * connection.disconnect()
     * ```
     */
    disconnect(): void;
    private on;
    private off;
    private onConnect;
    private onAutomaticReconnect;
    private onDisconnect;
    private onConnectError;
    removeOnConnect(callback: (ctx: DbConnectionImpl<RemoteModule>, ...args: ConnectionEventArgs['connect']) => void): void;
    removeOnAutomaticReconnect(callback: (ctx: DbConnectionImpl<RemoteModule>, ...args: ConnectionEventArgs['automaticReconnect']) => void): void;
    removeOnDisconnect(callback: (ctx: DbConnectionImpl<RemoteModule>, ...args: ConnectionEventArgs['disconnect']) => void): void;
    removeOnConnectError(callback: (ctx: DbConnectionImpl<RemoteModule>, ...args: ConnectionEventArgs['connectError']) => void): void;
}
//# sourceMappingURL=db_connection_impl.d.ts.map