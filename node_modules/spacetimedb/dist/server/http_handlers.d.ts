import type { EnvironmentFor } from '../lib/environment';
import type { Identity } from '../lib/identity';
import type { HttpVersion, MethodOrAny } from '../lib/autogen/types';
import type { UntypedSchemaDef } from '../lib/schema';
import type { Timestamp } from '../lib/timestamp';
import type { Uuid } from '../lib/uuid';
import type { TransactionCtx } from './procedures';
import type { HttpClient } from './http_internal';
import type { Random } from './rng';
import { type ModuleExport, type SchemaInner } from './schema';
import { Headers, makeResponse, SyncResponse, type BodyInit, type HeadersInit, type ResponseInit } from './http_shared';
export { Headers };
export { SyncResponse };
export type { BodyInit, HeadersInit, ResponseInit };
export { makeResponse };
export declare const httpHandlerFn: unique symbol;
export interface RequestInit {
    body?: BodyInit | null;
    headers?: HeadersInit;
    method?: string;
    version?: HttpVersion;
}
type RequestInner = {
    headers: Headers;
    method: string;
    uri: string;
    version: HttpVersion;
};
type RouteSpec = {
    handler: HttpHandlerExport<any>;
    method: MethodOrAny;
    path: string;
};
export declare const makeRequest: unique symbol;
export declare class Request {
    #private;
    constructor(url: URL | string, init?: RequestInit);
    static [makeRequest](body: BodyInit | null, inner: RequestInner): Request;
    get headers(): Headers;
    get method(): string;
    get uri(): string;
    get url(): string;
    get version(): HttpVersion;
    arrayBuffer(): ArrayBuffer;
    bytes(): Uint8Array;
    json(): any;
    text(): string;
}
export type HandlerAliasViews<SchemaDef extends UntypedSchemaDef> = SchemaDef extends {
    namespaces: infer NS extends Record<string, UntypedSchemaDef>;
} ? {
    readonly [K in keyof NS]: HandlerContext<NS[K]>;
} : {};
export interface HandlerContext<S extends UntypedSchemaDef = UntypedSchemaDef> {
    readonly env: EnvironmentFor<S>;
    readonly timestamp: Timestamp;
    readonly http: HttpClient;
    readonly identity: Identity;
    readonly random: Random;
    readonly as: HandlerAliasViews<S>;
    withTx<T>(body: (ctx: TransactionCtx<S>) => T): T;
    newUuidV4(): Uuid;
    newUuidV7(): Uuid;
}
export type HandlerFn<S extends UntypedSchemaDef = UntypedSchemaDef> = (ctx: HandlerContext<S>, req: Request) => SyncResponse;
export interface HttpHandlerExport<S extends UntypedSchemaDef = UntypedSchemaDef> extends HandlerFn<S>, ModuleExport {
    [httpHandlerFn]: HandlerFn<S>;
}
export interface HttpHandlerOpts {
    name: string;
}
export declare class Router {
    #private;
    constructor(routes?: RouteSpec[]);
    get(path: string, handler: HttpHandlerExport<any>): Router;
    head(path: string, handler: HttpHandlerExport<any>): Router;
    options(path: string, handler: HttpHandlerExport<any>): Router;
    put(path: string, handler: HttpHandlerExport<any>): Router;
    delete(path: string, handler: HttpHandlerExport<any>): Router;
    post(path: string, handler: HttpHandlerExport<any>): Router;
    patch(path: string, handler: HttpHandlerExport<any>): Router;
    any(path: string, handler: HttpHandlerExport<any>): Router;
    nest(path: string, subRouter: Router): Router;
    merge(otherRouter: Router): Router;
    intoRoutes(): RouteSpec[];
    private addRoute;
}
export declare function makeHttpHandlerExport<S extends UntypedSchemaDef>(ctx: SchemaInner, opts: HttpHandlerOpts | undefined, fn: HandlerFn<S>): HttpHandlerExport<S>;
export declare function makeHttpRouterExport(ctx: SchemaInner, router: Router): ModuleExport;
//# sourceMappingURL=http_handlers.d.ts.map