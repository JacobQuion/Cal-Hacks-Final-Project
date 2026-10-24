export declare const V2_WS_PROTOCOL = "v2.bsatn.spacetimedb";
export declare const V3_WS_PROTOCOL = "v3.bsatn.spacetimedb";
export declare const PREFERRED_WS_PROTOCOLS: readonly ["v3.bsatn.spacetimedb", "v2.bsatn.spacetimedb"];
export type NegotiatedWsProtocol = typeof V2_WS_PROTOCOL | typeof V3_WS_PROTOCOL;
export declare function normalizeWsProtocol(protocol: string): NegotiatedWsProtocol;
//# sourceMappingURL=websocket_protocols.d.ts.map