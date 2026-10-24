import { type EnvironmentFor } from './environment';
import { type Deserializer, type Serializer } from '../lib/algebraic_type';
import type { ConnectionId } from '../lib/connection_id';
import { Identity } from '../lib/identity';
import type { ParamsObj, ReducerCtx } from '../lib/reducers';
import { type UntypedSchemaDef } from '../lib/schema';
import type { TimeDuration } from '../lib/time_duration';
import type { ScheduleTableForParams } from '../lib/table_schema';
import { Timestamp } from '../lib/timestamp';
import { type Infer, type InferTypeOfRow, type t, type TypeBuilder } from '../lib/type_builders';
import { Uuid } from '../lib/uuid';
import { type HttpClient } from './http_internal';
import type { DbView } from './db_view';
import { type Random } from './rng';
import { type DatastoreBackend } from './backend';
import { type SubmoduleDispatchInfo, type ModuleExport, type SchemaInner } from './schema';
export type ProcedureExport<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends TypeBuilder<any, any>> = ProcedureFn<S, Params, Ret> & ModuleExport;
export declare function makeProcedureExport<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends TypeBuilder<any, any>>(ctx: SchemaInner, opts: ProcedureOptsWithOptionalName<Params, Ret> | undefined, params: Params, ret: Ret, fn: ProcedureFn<S, Params, Ret>): ProcedureExport<S, Params, Ret>;
export type ProcedureFn<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends TypeBuilder<any, any>> = (ctx: ProcedureCtx<S>, args: InferTypeOfRow<Params>) => Infer<Ret>;
export interface ProcedureOpts<Params extends ParamsObj = ParamsObj, Ret extends TypeBuilder<any, any> = TypeBuilder<any, any>> {
    name: string;
    onSchedule?: Ret extends ReturnType<typeof t.unit> ? ScheduleTableForParams<Params> : never;
}
export type ProcedureOptsWithOptionalName<Params extends ParamsObj = ParamsObj, Ret extends TypeBuilder<any, any> = TypeBuilder<any, any>> = Omit<ProcedureOpts<Params, Ret>, 'name'> & {
    name?: string;
};
export type ProcedureAliasViews<SchemaDef extends UntypedSchemaDef> = SchemaDef extends {
    namespaces: infer NS extends Record<string, UntypedSchemaDef>;
} ? {
    readonly [K in keyof NS]: ProcedureCtx<NS[K]>;
} : {};
export interface ProcedureCtx<S extends UntypedSchemaDef> {
    readonly env: EnvironmentFor<S>;
    readonly sender: Identity;
    readonly databaseIdentity: Identity;
    /** @deprecated Use `databaseIdentity` instead. */
    readonly identity: Identity;
    readonly timestamp: Timestamp;
    readonly connectionId: ConnectionId | null;
    readonly http: HttpClient;
    readonly random: Random;
    readonly as: ProcedureAliasViews<S>;
    withTx<T>(body: (ctx: TransactionCtx<S>) => T): T;
    sleep(duration: TimeDuration): void;
    newUuidV4(): Uuid;
    newUuidV7(): Uuid;
}
export interface TransactionCtx<S extends UntypedSchemaDef> extends ReducerCtx<S> {
}
export type Procedures = Array<{
    fn: ProcedureFn<any, any, any>;
    deserializeArgs: Deserializer<any>;
    serializeReturn: Serializer<any>;
    returnTypeBaseSize: number;
}>;
export declare function callProcedure(procedures: Procedures, id: number, sender: Identity, connectionId: ConnectionId | null, timestamp: Timestamp, argsBuf: Uint8Array, dbView: () => DbView<any>, dispatches?: SubmoduleDispatchInfo[], parentPrefix?: string): Uint8Array;
export declare const ProcedureCtxImpl: {
    new <S extends UntypedSchemaDef>(sender: Identity, timestamp: Timestamp, connectionId: ConnectionId | null, dbView: () => DbView<any>, backend?: DatastoreBackend, http?: HttpClient, sleep?: (duration: TimeDuration) => void, random?: Random, childSeedRandom?: Random, dispatches?: SubmoduleDispatchInfo[], parentPrefix?: string): {
        "__#private@#identity": Identity | undefined;
        "__#private@#uuidCounter": {
            value: 0;
        } | undefined;
        "__#private@#random": Random | undefined;
        "__#private@#dbView": () => DbView<any>;
        "__#private@#backend": DatastoreBackend;
        "__#private@#http": HttpClient;
        "__#private@#sleep": (duration: TimeDuration) => void;
        "__#private@#childSeedRandom": Random | undefined;
        readonly env: EnvironmentFor<S>;
        "__#private@#dispatches": SubmoduleDispatchInfo[];
        "__#private@#parentPrefix": string;
        "__#private@#asViews": object | undefined;
        readonly sender: Identity;
        readonly timestamp: Timestamp;
        readonly connectionId: ConnectionId | null;
        get databaseIdentity(): Identity;
        get identity(): Identity;
        get random(): Random;
        get http(): HttpClient;
        sleep(duration: TimeDuration): void;
        get as(): any;
        withTx<T>(body: (ctx: TransactionCtx<S>) => T): T;
        newUuidV4(): Uuid;
        newUuidV7(): Uuid;
    };
};
//# sourceMappingURL=procedures.d.ts.map