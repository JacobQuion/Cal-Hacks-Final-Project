import type { u128, u16, u256, u32 } from 'spacetime:sys@2.0';
import type { DatastoreBackend } from '../backend';
import type { TestRuntimeContext, TestRuntimeTarget, TestRuntimeTx } from './runtime';
export declare class TestDatastoreBackend implements DatastoreBackend {
    #private;
    constructor(ctx: TestRuntimeContext, target: TestRuntimeTarget, moduleIdentity: bigint);
    withTransaction(tx: TestRuntimeTx): TestDatastoreBackend;
    setJwtPayload(connectionId: bigint, payload: string): void;
    identity(): u256;
    getJwtPayload(connectionId: u128): Uint8Array;
    tableIdFromName(name: string): u32;
    indexIdFromName(name: string): u32;
    datastoreTableRowCount(tableId: u32): number;
    datastoreTableScanBsatn(tableId: u32): u32;
    datastoreInsertBsatn(tableId: u32, row: ArrayBuffer, rowLen: number): Uint8Array<ArrayBufferLike>;
    datastoreDeleteAllByEqBsatn(tableId: u32, row: ArrayBuffer, rowLen: number): u32;
    datastoreIndexScanPointBsatn(indexId: u32, point: ArrayBuffer, pointLen: number): u32;
    datastoreIndexScanRangeBsatn(indexId: u32, prefix: ArrayBuffer, prefixLen: u32, prefixElems: u16, rstartLen: u32, rendLen: u32): u32;
    datastoreDeleteByIndexScanPointBsatn(indexId: u32, point: ArrayBuffer, pointLen: number): u32;
    datastoreDeleteByIndexScanRangeBsatn(indexId: u32, prefix: ArrayBuffer, prefixLen: u32, prefixElems: u16, rstartLen: u32, rendLen: u32): u32;
    datastoreUpdateBsatn(tableId: u32, indexId: u32, row: ArrayBuffer, rowLen: number): Uint8Array<ArrayBufferLike>;
    datastoreClear(tableId: u32): void;
    rowIterBsatnAdvance(iterId: u32, out: ArrayBuffer): number;
    rowIterBsatnClose(iterId: u32): void;
    procedureStartMutTx(): bigint;
    procedureCommitMutTx(): void;
    procedureAbortMutTx(): void;
    procedureHttpRequest(): [Uint8Array, Uint8Array];
}
//# sourceMappingURL=backend.d.ts.map