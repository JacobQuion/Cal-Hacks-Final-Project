import type { UntypedProcedureDef } from '../sdk/procedures';
import type { ProcedureParamsType, ProcedureReturnType } from '../sdk/type_utils';
export declare function useProcedure<ProcedureDef extends UntypedProcedureDef>(procedureDef: ProcedureDef): (...params: ProcedureParamsType<ProcedureDef>) => Promise<ProcedureReturnType<ProcedureDef>>;
//# sourceMappingURL=useProcedure.d.ts.map