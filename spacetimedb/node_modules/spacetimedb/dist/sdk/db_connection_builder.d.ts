import { DbConnectionImpl, type AutomaticReconnectOptions, type TokenProvider } from './db_connection_impl';
import type { DbConnectionConfig, ErrorContextInterface, Identity, RemoteModuleOf } from '../';
import type { WebSocketFactory } from './ws';
/**
 * The database client connection to a SpacetimeDB server.
 * NOTE: DbConnectionImpl<any> is used here because UntypedRemoteModule causes
 * variance issues with function paramters, and the end user will never be
 * constructing a DbConnectionBuilder directly since it's code generated. We will
 * always have a concrete RemoteModule type in those cases. Even if they user
 * did do this, they would just lose type safety on the RemoteModule.
 */
export declare class DbConnectionBuilder<DbConnection extends DbConnectionImpl<any>> {
    #private;
    private remoteModule;
    private dbConnectionCtor;
    /**
     * Creates a new `DbConnectionBuilder` database client and set the initial parameters.
     *
     * Users are not expected to call this constructor directly. Instead, use the static method `DbConnection.builder()`.
     *
     * @param remoteModule The remote module to use to connect to the SpacetimeDB server.
     * @param dbConnectionConstructor The constructor to use to create a new `DbConnection`.
     */
    constructor(remoteModule: RemoteModuleOf<DbConnection>, dbConnectionCtor: (config: DbConnectionConfig<RemoteModuleOf<DbConnection>>) => DbConnection);
    /**
     * Set the URI of the SpacetimeDB server to connect to.
     *
     * @param uri The URI of the SpacetimeDB server to connect to.
     *
     **/
    withUri(uri: string | URL): this;
    /**
     * Set the name or Identity of the remote database to connect to.
     *
     * @param nameOrAddress
     *
     * @returns The `DbConnectionBuilder` instance.
     */
    withDatabaseName(nameOrAddress: string): this;
    /**
     * Set the identity of the client to connect to the database.
     *
     * @param token The credentials to use to authenticate with SpacetimeDB. This
     * is optional. You can store the token returned by the `onConnect` callback
     * to use in future connections.
     *
     * @returns The `DbConnectionBuilder` instance.
     */
    withToken(token?: string): this;
    withWSFn(createWSFn: WebSocketFactory): this;
    /**
     * Set the compression algorithm to use for the connection.
     *
     * @param compression The compression algorithm to use for the connection.
     */
    withCompression(compression: 'gzip' | 'brotli' | 'none'): this;
    /**
     * Sets the connection to operate in light mode.
     *
     * Light mode is a mode that reduces the amount of data sent over the network.
     *
     * @param lightMode The light mode for the connection.
     */
    withLightMode(lightMode: boolean): this;
    /**
     * Sets the connection to use confirmed reads.
     *
     * When enabled, the server will send query results only after they are
     * confirmed to be durable.
     *
     * What durable means depends on the server configuration: a single node
     * server may consider a transaction durable once it is `fsync`'ed to disk,
     * whereas a cluster may require that some number of replicas have
     * acknowledge that they have stored the transactions.
     *
     * Note that enabling confirmed reads will increase the latency between a
     * reducer call and the corresponding subscription update arriving at the
     * client.
     *
     * If this method is not called, not preference is sent to the server, and
     * the server will choose the default.
     *
     * @param confirmedReads `true` to enable confirmed reads, `false` to disable.
     */
    withConfirmedReads(confirmedReads: boolean): this;
    /**
     * Reconnect after an established connection drops, preserving handles and callbacks.
     * Retries use exponential backoff from `minDelayMs` (default 1 s) up to
     * `maxDelayMs` (default 30 s) until disconnect() or a terminal failure.
     * Values below the 500 ms and 1 s floors are raised with a warning, so
     * that retrying clients cannot overwhelm the database.
     * Initial connection failures are not retried. Lifecycle callbacks report
     * the next attempt and delay, or undefined when no retry is scheduled.
     */
    withAutomaticReconnect(options?: AutomaticReconnectOptions): this;
    /**
     * Refresh the retained token before reconnecting when it is near expiry or
     * rejected. The provider must return a token for the same identity.
     */
    withTokenProvider(provider: TokenProvider): this;
    /**
     * Register a callback for the first successful connection to the database.
     * Automatic reconnects invoke {@link DbConnectionBuilder.onAutomaticReconnect} instead.
     *
     * @param identity A unique identifier for a client connected to a database.
     * @param token The credentials to use to authenticate with SpacetimeDB.
     *
     * @returns The `DbConnectionBuilder` instance.
     *
     * The callback will be invoked with the `Identity` and private authentication `token` provided by the database to identify this connection.
     *
     * If credentials were supplied to connect, those passed to the callback will be equivalent to the ones used to connect.
     *
     * If the initial connection was anonymous, a new set of credentials will be generated by the database to identify this user.
     *
     * The credentials passed to the callback can be saved and used to authenticate the same user in future connections.
     *
     * @example
     *
     * ```ts
     * DbConnection.builder().onConnect((ctx, identity, token) => {
     *  console.log("Connected to SpacetimeDB with identity:", identity.toHexString());
     * });
     * ```
     */
    onConnect(callback: (connection: DbConnection, identity: Identity, token: string) => void): this;
    /**
     * Register a callback for each successful automatic reconnect after the
     * initial connection. Receives the current identity and authentication token.
     * Runs before subscription replay; use subscription `onApplied` callbacks
     * to observe refreshed data.
     */
    onAutomaticReconnect(callback: (connection: DbConnection, identity: Identity, token: string) => void): this;
    /**
     * Register a callback to be invoked upon an error.
     *
     * @example
     *
     * ```ts
     * DbConnection.builder().onConnectError((ctx, error) => {
     *   console.log("Error connecting to SpacetimeDB:", error);
     * });
     * ```
     *
     * With {@link DbConnectionBuilder.withAutomaticReconnect} enabled, this
     * callback also reports each failed reconnect attempt:
     * `nextReconnectAttempt` is the number of the upcoming attempt and
     * `nextReconnectDelayMs` the wait before it. Both are `undefined` when the
     * SDK will not retry, as for a failed initial connection.
     */
    onConnectError(callback: (ctx: ErrorContextInterface<RemoteModuleOf<DbConnection>>, error: Error, nextReconnectAttempt?: number, nextReconnectDelayMs?: number) => void): this;
    /**
     * Registers a callback to run when a {@link DbConnection} whose connection initially succeeded
     * is disconnected, either after a {@link DbConnection.disconnect()} call or due to an error.
     *
     * If the connection ended because of an error, the error is passed to the callback.
     *
     * The `callback` will be installed on the `DbConnection` created by `build`
     * before initiating the connection, ensuring there's no opportunity for the disconnect to happen
     * before the callback is installed.
     *
     * Note that this does not trigger if `build` fails
     * or in cases where {@link DbConnectionBuilder.onConnectError} would trigger.
     * This callback only triggers if the connection closes after `build` returns successfully
     * and {@link DbConnectionBuilder.onConnect} is invoked, i.e., after the initial connection
     * message is received.
     *
     * To simplify SDK implementation, at most one such callback can be registered.
     * Calling `onDisconnect` on the same `DbConnectionBuilder` multiple times throws an error.
     *
     * Unlike callbacks registered via {@link DbConnection},
     * no mechanism is provided to unregister the provided callback.
     * This is a concession to ergonomics; there's no clean place to return a `CallbackId` from this method
     * or from `build`.
     *
     * With {@link DbConnectionBuilder.withAutomaticReconnect} enabled, this
     * callback also reports connections lost mid-session, and the SDK keeps
     * reconnecting afterwards: `nextReconnectAttempt` is the number of the
     * upcoming attempt and `nextReconnectDelayMs` the wait before it. Both are
     * `undefined` when the SDK will not retry, which is always the case without
     * automatic reconnection.
     *
     * @param {function(error?: Error): void} callback - The callback to invoke upon disconnection.
     * @throws {Error} Throws an error if called multiple times on the same `DbConnectionBuilder`.
     */
    onDisconnect(callback: (ctx: ErrorContextInterface<RemoteModuleOf<DbConnection>>, error?: Error | undefined, nextReconnectAttempt?: number, nextReconnectDelayMs?: number) => void): this;
    getUri(): string;
    getModuleName(): string;
    /**
     * Builds a new `DbConnection` with the parameters set on this `DbConnectionBuilder` and attempts to connect to the SpacetimeDB server.
     *
     * @returns A new `DbConnection` with the parameters set on this `DbConnectionBuilder`.
     *
     * @example
     *
     * ```ts
     * const host = "http://localhost:3000";
     * const name_or_address = "database_name"
     * const auth_token = undefined;
     * DbConnection.builder().withUri(host).withDatabaseName(name_or_address).withToken(auth_token).build();
     * ```
     */
    build(): DbConnection;
}
//# sourceMappingURL=db_connection_builder.d.ts.map