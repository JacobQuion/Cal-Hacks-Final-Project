import { DbConnectionBuilder, type DbConnectionImpl } from '../sdk/db_connection_impl';
export interface SpacetimeDBProviderProps<DbConnection extends DbConnectionImpl<any>> {
    connectionBuilder: DbConnectionBuilder<DbConnection>;
    children?: any;
}
export declare function SpacetimeDBProvider<DbConnection extends DbConnectionImpl<any>>(props: SpacetimeDBProviderProps<DbConnection>): import("solid-js").JSX.Element;
//# sourceMappingURL=SpacetimeDBProvider.d.ts.map