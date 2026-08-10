// Ambient slice of bun:ffi — the module exists only under the Bun runtime,
// and tsc carries no Bun types. Only the sliver figure-image.ts touches is
// declared; the import stays behind a runtime guard.
declare module 'bun:ffi' {
  export const FFIType: { readonly i32: unknown; readonly u64: unknown; readonly ptr: unknown }
  export function ptr(view: ArrayBufferView): number
  export function dlopen<
    Defs extends Record<string, { args: readonly unknown[]; returns: unknown }>,
  >(
    path: string,
    definitions: Defs,
  ): { symbols: { [Name in keyof Defs]: (...args: (number | bigint)[]) => number } }
}
