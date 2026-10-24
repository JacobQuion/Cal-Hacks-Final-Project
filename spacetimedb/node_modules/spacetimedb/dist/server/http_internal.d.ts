import type { TimeDuration } from '../lib/time_duration';
import { type BodyInit, type HeadersInit, Headers, SyncResponse } from './http_shared';
export { Headers };
export interface RequestOptions {
    /** A BodyInit object or null to set request's body. */
    body?: BodyInit | null;
    /** A Headers object, an object literal, or an array of two-item arrays to set request's headers. */
    headers?: HeadersInit;
    /** A string to set request's method. */
    method?: string;
    /** A duration, after which the request will timeout */
    timeout?: TimeDuration;
}
export interface HttpClient {
    fetch(url: URL | string, init?: RequestOptions): SyncResponse;
}
export declare const httpClient: HttpClient;
//# sourceMappingURL=http_internal.d.ts.map