import { type WebSocketAdapter, type WebSocketArgs } from './ws';
export declare class WebsocketDecompressAdapter implements WebSocketAdapter {
    #private;
    get protocol(): string;
    get readyState(): number;
    set onclose(handler: (ev: CloseEvent) => void);
    set onopen(handler: () => void);
    set onmessage(handler: (msg: {
        data: Uint8Array;
    }) => void);
    set onerror(handler: (msg: ErrorEvent) => void);
    send(msg: Uint8Array<ArrayBuffer>): void;
    close(): void;
    constructor(ws: WebSocket);
    static openWebSocket(args: WebSocketArgs): Promise<WebsocketDecompressAdapter>;
}
//# sourceMappingURL=websocket_decompress_adapter.d.ts.map