import type { ParamsObj } from '../lib/reducers';
import type { Infer, InferTypeOfParams, TypeBuilder } from '../lib/type_builders';
import type { CamelCase, NestAccessors } from '../lib/type_util';
import { type CoerceParams } from '../lib/util';
import type { UntypedRemoteModule } from './spacetime_module';
type IfAny<T, Y, N> = 0 extends 1 & T ? Y : N;
type ProceduresViewLoose = {
    readonly [k: string]: any;
};
export type ProceduresView<RemoteModule> = IfAny<RemoteModule, ProceduresViewLoose, RemoteModule extends UntypedRemoteModule ? NestAccessors<{
    [K in RemoteModule['procedures'][number] as K['accessorName']]: (params: InferTypeOfParams<K['params']>) => Promise<Infer<K['returnType']>>;
}> : never>;
export type UntypedProcedureDef = {
    name: string;
    accessorName: string;
    params: CoerceParams<ParamsObj>;
    returnType: TypeBuilder<any, any>;
};
export type UntypedProceduresDef = {
    procedures: readonly UntypedProcedureDef[];
};
export declare function procedures<const H extends readonly UntypedProcedureDef[]>(...handles: H): {
    procedures: H;
};
export declare function procedures<const H extends readonly UntypedProcedureDef[]>(handles: H): {
    procedures: H;
};
type ProcedureDef<Name extends string, Params extends ParamsObj, ReturnType extends TypeBuilder<any, any>, AccessorName extends string = CamelCase<Name>> = {
    name: Name;
    accessorName: AccessorName;
    params: CoerceParams<Params>;
    returnType: ReturnType;
};
export declare function procedureSchema<ProcedureName extends string, Params extends ParamsObj, ReturnType extends TypeBuilder<any, any>, AccessorName extends string = CamelCase<ProcedureName>>(name: ProcedureName, params: Params, returnType: ReturnType, accessorName?: AccessorName): ProcedureDef<ProcedureName, Params, ReturnType, AccessorName>;
export {};
//# sourceMappingURL=procedures.d.ts.map