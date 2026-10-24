import type { Environment, EnvironmentSchema } from '../lib/environment';
import type { EnvironmentDeclaration } from '../lib/autogen/types';
/** Values are not cached: transaction and procedure reads retain host semantics. */
export declare const environment: Environment;
export type { Environment, EnvironmentFor, EnvironmentSchema, } from '../lib/environment';
/** Produce metadata only. No environment value is embedded in the artifact. */
export declare function environmentDeclarations(schema: EnvironmentSchema): EnvironmentDeclaration[];
//# sourceMappingURL=environment.d.ts.map