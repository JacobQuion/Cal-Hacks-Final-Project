import type { ConnectionId } from '../../lib/connection_id';
import { Identity } from '../../lib/identity';
import type { ReducerCtx } from '../../lib/reducers';
import type { UntypedSchemaDef } from '../../lib/schema';
import { Timestamp } from '../../lib/timestamp';
import type { TimeDuration } from '../../lib/time_duration';
import { type HttpRequest, type HttpResponse } from '../../lib/autogen/types';
import type { DbView } from '../db_view';
import type { ProcedureCtx } from '../procedures';
import type { Schema } from '../schema';
import type { AnonymousViewCtx, ViewCtx } from '../views';
import { type Query } from '../query';
declare const nextSeed: unique symbol;
export interface ModuleTestHarness<S extends UntypedSchemaDef> {
    readonly db: DbView<S>;
    readonly clock: TestClock;
    readonly rng: TestRng;
    readonly moduleIdentity: Identity;
    withReducerTx<T>(auth: TestAuth, body: (ctx: ReducerCtx<S>) => T): T;
    procedureContext(auth: TestAuth): ProcedureCtx<S>;
    procedureContextBuilder(auth: TestAuth): ProcedureContextBuilder<S>;
    viewContext(auth: TestAuth): ViewCtx<S>;
    anonymousViewContext(): AnonymousViewCtx<S>;
    runQuery<Row>(query: Query<any>): Row[];
}
export declare class TestClock {
    #private;
    constructor(timestamp?: Timestamp);
    now(): Timestamp;
    set(timestamp: Timestamp): void;
    advance(duration: TimeDuration): void;
}
export declare class TestRng {
    #private;
    constructor(seed?: number | bigint | Uint8Array | null);
    seed(): number | bigint | Uint8Array | null;
    setSeed(seed: number | bigint | Uint8Array): void;
    clearSeed(): void;
    [nextSeed](): bigint;
}
declare class TestAuthImpl {
    readonly kind: 'internal' | 'authenticated';
    readonly connectionId: ConnectionId | null;
    readonly jwtPayload: string | null;
    private constructor();
    static internal(): TestAuthImpl;
    static fromJwtPayload(jwtPayload: string, connectionId: ConnectionId): TestAuthImpl;
}
export type TestAuth = TestAuthImpl;
export declare const TestAuth: typeof TestAuthImpl;
/**
 * What a test HTTP responder returns: the response's status, headers and
 * version, plus its body, which `Response.text()`, `.json()` and `.bytes()`
 * then read. Omitting `body` gives an empty one.
 */
export type TestHttpResponse = HttpResponse & {
    body?: string | Uint8Array;
};
export type TestHttpResponder<S extends UntypedSchemaDef> = (test: ModuleTestHarness<S>, req: HttpRequest, body: Uint8Array) => TestHttpResponse;
export interface ProcedureContextBuilder<S extends UntypedSchemaDef> {
    http(responder: TestHttpResponder<S>): this;
    hooks(hooks: ProcedureTestHooks<S>): this;
    build(): ProcedureCtx<S>;
}
export declare class ProcedureTestHooks<S extends UntypedSchemaDef> {
    #private;
    afterTxCommit(hook: (test: ModuleTestHarness<S>) => void): this;
    onSleep(hook: (test: ModuleTestHarness<S>, wakeTime: Timestamp) => void): this;
    runAfterTxCommit(test: ModuleTestHarness<S>): void;
    runOnSleep(test: ModuleTestHarness<S>, wakeTime: Timestamp): void;
}
export declare function createProcedureTestHooks<S extends UntypedSchemaDef>(): ProcedureTestHooks<S>;
export declare function createModuleTestHarness<S extends UntypedSchemaDef>(schema: Schema<S>, moduleExports: Record<string, unknown>, opts?: {
    moduleIdentity?: Identity;
    clock?: TestClock;
    rngSeed?: bigint | number | Uint8Array | null;
}): ModuleTestHarness<S>;
export {};
//# sourceMappingURL=index.d.ts.map