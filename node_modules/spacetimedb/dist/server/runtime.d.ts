import { type EnvironmentFor } from './environment';
import * as _syscalls2_0 from 'spacetime:sys@2.0';
import type { ModuleHooks, u128, u16, u256, u32 } from 'spacetime:sys@2.0';
import { type RawTableDefV10, type Typespace } from '../lib/autogen/types';
import { ConnectionId } from '../lib/connection_id';
import { Identity } from '../lib/identity';
import { Timestamp } from '../lib/timestamp';
import { Uuid } from '../lib/uuid';
import { type HttpClient } from './http_internal';
import { type AliasViews, type AuthCtx, type JsonObject, type JwtClaims } from '../lib/reducers';
import { type UntypedSchemaDef } from '../lib/schema';
import { type Table } from '../lib/table';
import type { DbView } from './db_view';
import { type Random } from './rng';
import type { SubmoduleDispatchInfo, SchemaInner } from './schema';
import { type DatastoreBackend } from './backend';
export declare const sys: {
    datastore_clear(table_id: u32): u64;
    register_hooks(hooks: ModuleHooks): any;
    table_id_from_name(name: string): u32;
    index_id_from_name(name: string): u32;
    datastore_table_row_count(table_id: u32): _syscalls2_0.u64;
    datastore_table_scan_bsatn(table_id: u32): u32;
    datastore_index_scan_range_bsatn(index_id: u32, buf: ArrayBuffer, prefix_len: u32, prefix_elems: u16, rstart_len: u32, rend_len: u32): u32;
    row_iter_bsatn_advance(iter: u32, buffer: ArrayBuffer): u32;
    row_iter_bsatn_close(iter: u32): void;
    datastore_insert_bsatn(table_id: u32, row: ArrayBuffer, row_len: u32): u32;
    datastore_update_bsatn(table_id: u32, index_id: u32, row: ArrayBuffer, row_len: u32): u32;
    datastore_delete_by_index_scan_range_bsatn(index_id: u32, buf: ArrayBuffer, prefix_len: u32, prefix_elems: u16, rstart_len: u32, rend_len: u32): u32;
    datastore_delete_all_by_eq_bsatn(table_id: u32, relation: ArrayBuffer, relation_len: u32): u32;
    volatile_nonatomic_schedule_immediate(reducer_name: string, args: Uint8Array): void;
    console_log(level: _syscalls2_0.u8, message: string): void;
    console_timer_start(name: string): u32;
    console_timer_end(span_id: u32): void;
    identity(): u256;
    get_jwt_payload(connection_id: u128): Uint8Array;
    procedure_http_request(request: Uint8Array, body: Uint8Array | string): [response: Uint8Array, body: Uint8Array];
    procedure_start_mut_tx(): bigint;
    procedure_commit_mut_tx(): any;
    procedure_abort_mut_tx(): any;
    datastore_index_scan_point_bsatn(index_id: u32, point: ArrayBuffer, point_len: u32): u32;
    datastore_delete_by_index_scan_point_bsatn(index_id: u32, point: ArrayBuffer, point_len: u32): u32;
    moduleHooks: typeof _syscalls2_0.moduleHooks;
};
export declare function parseJsonObject(json: string): JsonObject;
export declare const ReducerCtxImpl: {
    new <SchemaDef extends UntypedSchemaDef>(sender: Identity, timestamp: Timestamp, connectionId: ConnectionId | null, dbView: DbView<any>, backendOrAsViews?: DatastoreBackend | object, senderAuth?: AuthCtx, random?: Random, asViews?: object): {
        "__#private@#identity": Identity | undefined;
        "__#private@#senderAuth": Readonly<{
            isInternal: boolean;
            hasJWT: boolean;
            jwt: JwtClaims | null;
        }> | undefined;
        "__#private@#uuidCounter": {
            value: number;
        } | undefined;
        "__#private@#random": Random | undefined;
        "__#private@#backend": DatastoreBackend;
        sender: Identity;
        timestamp: Timestamp;
        connectionId: ConnectionId | null;
        db: DbView<SchemaDef>;
        readonly env: EnvironmentFor<SchemaDef>;
        as: AliasViews<SchemaDef>;
        get databaseIdentity(): Identity;
        get identity(): Identity;
        get senderAuth(): Readonly<{
            isInternal: boolean;
            hasJWT: boolean;
            jwt: JwtClaims | null;
        }>;
        get random(): Random;
        /**
         * Create a new random {@link Uuid} `v4` using this `ReducerCtx`'s RNG.
         */
        newUuidV4(): Uuid;
        /**
         * Create a new sortable {@link Uuid} `v7` using this `ReducerCtx`'s RNG, counter,
         * and timestamp.
         */
        newUuidV7(): Uuid;
    };
    /** Reset the `ReducerCtx` to be used for a new transaction */
    resetHost(me: InstanceType</*elided*/ any>, sender: Identity, timestamp: Timestamp, connectionId: ConnectionId | null, dbView?: DbView<any>, asViews?: object): void;
    /** Reset the `ReducerCtx` to be used with an injectable backend. */
    reset(me: InstanceType</*elided*/ any>, sender: Identity, timestamp: Timestamp, connectionId: ConnectionId | null, backendOrDbView?: DatastoreBackend | DbView<any>, senderAuth?: AuthCtx | object, random?: Random, dbView?: DbView<any>, asViews?: object): void;
};
/**
 * Call into a user function `fn` - the backtrace from an exception thrown in
 * `fn` or one of its descendants in the callgraph will be stripped by host
 * code in `crates/core/src/host/v8/error.rs` such that `fn` will be shown to
 * be the root of the call stack.
 */
export declare const callUserFunction: <Args extends any[], R>(fn: (...args: Args) => R, ...args: Args) => R;
export declare function runWithTx<T, Ctx>(makeCtx: (timestamp: Timestamp) => Ctx, body: (ctx: Ctx) => T, backend?: DatastoreBackend): T;
export declare const makeHooks: (schema: SchemaInner) => ModuleHooks;
type ProcCtxRef = {
    sender: Identity;
    connectionId: ConnectionId | null;
    timestamp: Timestamp;
    get databaseIdentity(): Identity;
    get identity(): Identity;
    get http(): HttpClient;
    get random(): Random;
    sleep(duration: {
        __time_duration_micros__: bigint;
    }): void;
    newUuidV4(): Uuid;
    newUuidV7(): Uuid;
};
export declare function buildProcedureAliasCtxMap(parent: ProcCtxRef, dispatches: SubmoduleDispatchInfo[], parentPrefix: string): object;
/** Builds and assigns reducer-style alias views onto a freshly created TransactionCtx.
 *  Must be called while inside a transaction (after sys.procedure_start_mut_tx). */
export declare function assignTxAliasViews(tx: InstanceType<typeof ReducerCtxImpl>, dispatches: SubmoduleDispatchInfo[], parentPrefix?: string): void;
export declare function makeTableView(typespace: Typespace, table: RawTableDefV10, backendOrNamePrefix?: DatastoreBackend | string, namePrefix?: string): Table<any>;
export {};
//# sourceMappingURL=runtime.d.ts.map