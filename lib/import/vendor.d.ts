// SPDX-License-Identifier: MIT
/** Ambient declarations for untyped third-party modules used by the backend. */

declare module 'sql.js' {
  const initSqlJs: (options?: { wasmBinary?: Uint8Array | ArrayBuffer }) => Promise<unknown>;
  export default initSqlJs;
}

declare module 'jsonld' {
  const jsonld: {
    expand: (doc: unknown, options?: unknown) => Promise<unknown[]>;
    compact: (doc: unknown, ctx: unknown, options?: unknown) => Promise<unknown>;
  };
  export default jsonld;
}

declare module 'n3' {
  import { Duplex } from 'node:stream';
  export class StreamParser extends Duplex {
    constructor(options?: { format?: string });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: 'data', cb: (quad: any) => void): this;
    on(event: 'prefix', cb: (prefix: string, iri: { value: string }) => void): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: 'end' | 'error', cb: (arg?: any) => void): this;
  }
  export const Parser: unknown;
}

declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  const libheif: unknown;
  export default libheif;
}
