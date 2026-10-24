import { ClientMessage, ServerMessage } from './client_api/types';
import type { WebSocketAdapter, WebSocketArgs, WebSocketFactory } from './ws';
declare class WebsocketTestAdapter implements WebSocketAdapter {
    #private;
    protocol: string;
    /** The arguments the connection passed to `openWebSocket`, for assertions. */
    connectArgs?: WebSocketArgs;
    get readyState(): number;
    messageQueue: Uint8Array<ArrayBuffer>[];
    outgoingMessages: ClientMessage[];
    closed: boolean;
    supportedProtocols: string[];
    constructor();
    set onclose(handler: (ev: CloseEvent) => void);
    set onopen(handler: () => void);
    set onmessage(handler: (msg: {
        data: Uint8Array;
    }) => void);
    set onerror(handler: (msg: ErrorEvent) => void);
    error(error: Error): void;
    send(message: Uint8Array<ArrayBuffer>): void;
    close(): void;
    /**
     * Simulate a close initiated by the server or the network, with an
     * arbitrary close code (e.g. an abnormal closure or an
     * application-specific code such as session-expired).
     */
    serverClose(code: number, reason?: string, wasClean?: boolean): void;
    /**
     * Mark the socket as closed without delivering any event, simulating a
     * socket that died while the page was suspended (a "zombie" socket).
     */
    dieSilently(): void;
    acceptConnection(): void;
    sendToClient(message: ServerMessage): void;
    openWebSocket: WebSocketFactory;
}
/**
 * A websocket factory that hands out a fresh {@link WebsocketTestAdapter} per
 * connection attempt and records them all. Used to test automatic
 * reconnection, where each attempt opens a new socket.
 */
export declare class WebsocketTestAdapterFactory {
    /** Every adapter created so far, in creation order. */
    sockets: WebsocketTestAdapter[];
    /**
     * When set, the next `openWebSocket` calls reject with this error instead
     * of producing a socket (simulating an unreachable server or a failed
     * token exchange).
     */
    connectError?: Error;
    /** The most recently created adapter. */
    get current(): WebsocketTestAdapter;
    openWebSocket: WebSocketFactory;
}
export default WebsocketTestAdapter;
//# sourceMappingURL=websocket_test_adapter.d.ts.map