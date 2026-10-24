/**
 * Returns the object holding a dotted accessor key and the key's last segment,
 * creating intermediate objects as needed: `myAuth.login` -> `[root.myAuth, 'login']`.
 */
export declare function accessorSlot(root: object, accessorName: string): [Record<string, unknown>, string];
/** Reads a dotted accessor key from nested objects: `myAuth.login` -> `root.myAuth.login`. */
export declare function getByAccessorPath<T = unknown>(root: object, accessorName: string): T;
//# sourceMappingURL=accessor_path.d.ts.map