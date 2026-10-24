import type { TestRuntime, TestRuntimeTx } from './runtime';
export type WasmCommitMode = 'Normal' | 'DropEventTableRows';
export interface WasmValidatedAuth {
    readonly senderHex: string;
    readonly connectionIdHex: string | undefined;
}
export interface WasmPortableTransaction extends TestRuntimeTx {
    readonly __wasmTxBrand?: unique symbol;
}
export interface WasmPortableDatastore {
    tableId(name: string): number;
    indexId(name: string): number;
    beginMutTx(): WasmPortableTransaction;
    commitTx(tx: WasmPortableTransaction, mode: WasmCommitMode): void;
    rollbackTx(tx: WasmPortableTransaction): void;
    reset(): void;
    tableRowCount(tableId: number): number;
    tableRowCountTx(tx: WasmPortableTransaction, tableId: number): number;
    tableRowsBsatn(tableId: number): Uint8Array[];
    tableRowsBsatnTx(tx: WasmPortableTransaction, tableId: number): Uint8Array[];
    indexScanPointBsatn(indexId: number, point: Uint8Array): Uint8Array[];
    indexScanPointBsatnTx(tx: WasmPortableTransaction, indexId: number, point: Uint8Array): Uint8Array[];
    indexScanRangeBsatn(indexId: number, prefix: Uint8Array, prefixElems: number, rstart: Uint8Array, rend: Uint8Array): Uint8Array[];
    indexScanRangeBsatnTx(tx: WasmPortableTransaction, indexId: number, prefix: Uint8Array, prefixElems: number, rstart: Uint8Array, rend: Uint8Array): Uint8Array[];
    insertBsatnGeneratedCols(tx: WasmPortableTransaction, tableId: number, row: Uint8Array): Uint8Array;
    updateBsatnGeneratedCols(tx: WasmPortableTransaction, tableId: number, indexId: number, row: Uint8Array): Uint8Array;
    deleteByRelBsatn(tx: WasmPortableTransaction, tableId: number, relation: Uint8Array): number;
    deleteByIndexScanPointBsatn(tx: WasmPortableTransaction, indexId: number, point: Uint8Array): number;
    deleteByIndexScanRangeBsatn(tx: WasmPortableTransaction, indexId: number, prefix: Uint8Array, prefixElems: number, rstart: Uint8Array, rend: Uint8Array): number;
    clearTable(tx: WasmPortableTransaction, tableId: number): number;
    validateJwtPayload(payload: string, connectionIdHex: string): WasmValidatedAuth;
    runQuery(sql: string, databaseIdentityHex: string): Uint8Array[];
}
export interface WasmPortableDatastoreModule {
    WasmPortableDatastore: new (rawModuleDefBsatn: Uint8Array, moduleIdentityHex: string) => WasmPortableDatastore;
}
export declare function createWasmTestRuntime(wasm: WasmPortableDatastoreModule): TestRuntime;
//# sourceMappingURL=wasm.d.ts.map