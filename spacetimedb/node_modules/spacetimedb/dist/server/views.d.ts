import type { EnvironmentFor } from '../lib/environment';
import { type AlgebraicTypeVariants, type Deserializer, type Serializer } from '../lib/algebraic_type';
import type { Identity } from '../lib/identity';
import type { OptionAlgebraicType } from '../lib/option';
import type { ParamsObj } from '../lib/reducers';
import { type UntypedSchemaDef } from '../lib/schema';
import { ArrayBuilder, OptionBuilder, RowBuilder, type ColumnBuilder, type Infer, type InferSpacetimeTypeOfTypeBuilder, type InferTypeOfRow, type RowObj, type TypeBuilder } from '../lib/type_builders';
import type { IsUnion } from '../lib/type_util';
import type { ReadonlyDbView } from './db_view';
import { type QueryBuilder, type RowTypedQuery } from './query';
import { type ModuleExport, type SchemaInner } from './schema';
export type ViewExport<ViewFn> = ViewFn & ModuleExport;
export declare function makeViewExport<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends ViewReturnTypeBuilder, F extends ViewFn<S, Params, Ret>>(ctx: SchemaInner, opts: ViewOpts, params: Params, ret: Ret, fn: F): ViewExport<F>;
export declare function makeAnonViewExport<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends ViewReturnTypeBuilder, F extends AnonymousViewFn<S, Params, Ret>>(ctx: SchemaInner, opts: ViewOpts, params: Params, ret: Ret, fn: F): ViewExport<F>;
export type ViewCtx<S extends UntypedSchemaDef> = Readonly<{
    sender: Identity;
    db: ReadonlyDbView<S>;
    env: EnvironmentFor<S>;
    from: QueryBuilder<S>;
}>;
export type AnonymousViewCtx<S extends UntypedSchemaDef> = Readonly<{
    db: ReadonlyDbView<S>;
    env: EnvironmentFor<S>;
    from: QueryBuilder<S>;
}>;
export type ViewOpts = {
    name?: string;
    public: true;
};
type FlattenedArray<T> = T extends readonly (infer E)[] ? E : never;
type ViewReturnRow<Ret extends ViewReturnTypeBuilder> = Ret extends ArrayBuilder<infer Element> ? Element extends RowBuilder<infer Row> ? Row : never : Ret extends OptionBuilder<infer Value> ? Value extends RowBuilder<infer Row> ? Row : never : never;
type PrimaryKeyColumnNames<Row extends RowObj> = {
    [K in keyof Row & string]: Row[K] extends ColumnBuilder<any, any, infer M> ? M extends {
        isPrimaryKey: true;
    } ? K : never : never;
}[keyof Row & string];
type HasMultiplePrimaryKeys<Row extends RowObj> = string extends PrimaryKeyColumnNames<Row> ? false : IsUnion<PrimaryKeyColumnNames<Row>>;
type MultiplePrimaryKeyColumns<Ret extends ViewReturnTypeBuilder> = PrimaryKeyColumnNames<ViewReturnRow<Ret>>;
type ERROR_view_return_type_can_have_at_most_one_primaryKey<Columns extends string> = {
    _primaryKeyColumns: Columns;
    _fix: 'Remove primaryKey() from all but one column on the returned row type';
};
export type ValidateViewPrimaryKey<Ret extends ViewReturnTypeBuilder> = HasMultiplePrimaryKeys<ViewReturnRow<Ret>> extends true ? [
    error: ERROR_view_return_type_can_have_at_most_one_primaryKey<MultiplePrimaryKeyColumns<Ret>>
] : [];
export type ViewFn<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends ViewReturnTypeBuilder> = ((ctx: ViewCtx<S>, params: InferTypeOfRow<Params>) => Infer<Ret>) | ((ctx: ViewCtx<S>, params: InferTypeOfRow<Params>) => RowTypedQuery<FlattenedArray<Infer<Ret>>, ExtractArrayProduct<Ret>>);
export type AnonymousViewFn<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends ViewReturnTypeBuilder> = ((ctx: AnonymousViewCtx<S>, params: InferTypeOfRow<Params>) => Infer<Ret>) | ((ctx: AnonymousViewCtx<S>, params: InferTypeOfRow<Params>) => RowTypedQuery<FlattenedArray<Infer<Ret>>, ExtractArrayProduct<Ret>>);
export type ViewReturnTypeBuilder = TypeBuilder<readonly object[], {
    tag: 'Array';
    value: AlgebraicTypeVariants.Product;
}> | TypeBuilder<object | undefined, OptionAlgebraicType<AlgebraicTypeVariants.Product>>;
export declare function registerView<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends ViewReturnTypeBuilder>(ctx: SchemaInner, opts: ViewOpts, exportName: string, params: Params, ret: Ret, fn: ViewFn<S, Params, Ret>): void;
export declare function registerAnonymousView<S extends UntypedSchemaDef, Params extends ParamsObj, Ret extends ViewReturnTypeBuilder>(ctx: SchemaInner, opts: ViewOpts, exportName: string, params: Params, ret: Ret, fn: AnonymousViewFn<S, Params, Ret>): void;
type ViewInfo<F> = {
    fn: F;
    deserializeParams: Deserializer<any>;
    serializeReturn: Serializer<any>;
    returnTypeBaseSize: number;
};
type AnyViewFn = (ctx: ViewCtx<any>, params: any) => any;
type AnyAnonymousViewFn = (ctx: AnonymousViewCtx<any>, params: any) => any;
export type Views = ViewInfo<AnyViewFn>[];
export type AnonViews = ViewInfo<AnyAnonymousViewFn>[];
type ExtractArrayProduct<T extends TypeBuilder<any, any>> = InferSpacetimeTypeOfTypeBuilder<T> extends {
    tag: 'Array';
    value: infer V;
} ? V extends {
    tag: 'Product';
    value: infer P;
} ? P : never : never;
export {};
//# sourceMappingURL=views.d.ts.map