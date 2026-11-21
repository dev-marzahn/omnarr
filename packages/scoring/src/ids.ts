// Document IDs as Convex types them (`GenericId<T>` is `string & { __tableName: T }`),
// so scoring needs no `convex` dependency.
export type Id<TableName extends string> = string & { __tableName: TableName };
