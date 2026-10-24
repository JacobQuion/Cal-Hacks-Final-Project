export interface WebSocketAdapter {
    readonly protocol: string;
    /**
     * The underlying socket's `readyState`, using the standard `WebSocket`
     * constants: `CONNECTING` (0), `OPEN` (1), `CLOSING` (2), `CLOSED` (3). Used
     * to detect sockets that died silently, for example after the tab was frozen
     * or the machine slept, without a clean `onclose` having fired.
     *
     * Optional so existing custom adapters stay valid without changes. When an
     * adapter does not expose it, the resume handler cannot detect a
     * silently-closed socket for that adapter and leaves it to the normal
     * `onclose` path.
     */
    readonly readyState?: number;
    send(msg: Uint8Array<ArrayBuffer>): void;
    close(): void;
    set onclose(handler: (ev: CloseEvent) => void);
    set onopen(handler: () => void);
    set onmessage(handler: (msg: {
        data: Uint8Array;
    }) => void);
    set onerror(handler: (msg: ErrorEvent) => void);
}
export declare class WebSocketTokenError extends Error {
    readonly status: number;
    constructor(status: number, statusText: string);
}
export interface WebSocketArgs {
    url: URL;
    wsProtocol: string[];
    nameOrAddress: string;
    authToken?: string;
    compression: 'gzip' | 'brotli' | 'none';
    lightMode: boolean;
    confirmedReads?: boolean;
    /** Hex-encoded id for this socket. */
    connectionId?: string;
    /** Stable session id, sent only when automatic reconnection is enabled. */
    sessionId?: string;
}
export type WebSocketFactory = (args: WebSocketArgs) => Promise<WebSocketAdapter>;
/**
 * Open a WebSocket to the database specified by the given `WebSocketArgs`.
 * @returns a WebSocket with `binaryType` set to `arraybuffer`.
 */
export declare function openWebSocket({ url, nameOrAddress, wsProtocol, authToken, compression, lightMode, confirmedReads, connectionId, sessionId, }: WebSocketArgs): Promise<WebSocket>;
//# sourceMappingURL=ws.d.ts.map