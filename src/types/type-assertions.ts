/** Compile-time assertion helpers. These types emit no runtime code. */

/** Fails compilation unless T is exactly `true`. */
export type Assert<T extends true> = T;

/** Resolves to `true` iff A is assignable to B. */
export type IsExtends<A, B> = A extends B ? true : false;

/** Resolves to `true` iff A and B are mutually assignable (structurally identical). */
export type IsExact<A, B> = IsExtends<A, B> extends true
    ? IsExtends<B, A>
    : false;