import { Headers } from 'headers-polyfill';
import type { HttpHeaders, HttpMethod, HttpVersion } from '../lib/autogen/types';
export { Headers };
export type BodyInit = ArrayBuffer | ArrayBufferView | string;
export type HeadersInit = [string, string][] | Record<string, string> | Headers;
export declare const textEncoder: TextEncoder;
export declare const textDecoder: TextDecoder;
export declare function deserializeMethod(method: HttpMethod): string;
export declare function serializeMethod(method?: string): HttpMethod;
export declare function serializeHeaders(headers: Headers): HttpHeaders;
export declare function deserializeHeaders(headers: HttpHeaders): Headers;
export interface ResponseInit {
    headers?: HeadersInit;
    status?: number;
    statusText?: string;
    version?: HttpVersion;
}
export interface InnerResponse {
    type: 'basic' | 'cors' | 'default' | 'error' | 'opaque' | 'opaqueredirect';
    url: string | null;
    status: number;
    statusText: string;
    headers: Headers;
    aborted: boolean;
    version: HttpVersion;
}
export declare const makeResponse: unique symbol;
export declare class SyncResponse {
    #private;
    constructor(body?: BodyInit | null, init?: ResponseInit);
    static [makeResponse](body: BodyInit | null, inner: InnerResponse): SyncResponse;
    get headers(): Headers;
    get status(): number;
    get statusText(): string;
    get ok(): boolean;
    get url(): string;
    get type(): "default" | "basic" | "cors" | "error" | "opaque" | "opaqueredirect";
    get version(): HttpVersion;
    arrayBuffer(): ArrayBuffer;
    bytes(): Uint8Array<ArrayBuffer>;
    json(): any;
    text(): string;
}
//# sourceMappingURL=http_shared.d.ts.map