/**
 * @rutekit/translator — the pivot, and the two directions across it.
 *
 * Every client surface is ingested into one canonical request
 * (`canonical-request.ts`) and every provider dialect is rendered out of it, so
 * nothing downstream of here — routing, the pool, compression — has to know
 * which SDK the caller happened to use.
 *
 * Nothing in this package performs I/O. A codec is handed bytes or a parsed
 * body and returns a value; the server owns the socket, which is what keeps this
 * exercisable without a runtime standing behind it.
 */

export * from './blocks.ts';
export * from './canonical-request.ts';
export * from './canonical-result.ts';
export * from './canonical-stream.ts';
export * from './codecs/index.ts';
export * from './ingest/index.ts';
export * from './render/index.ts';
export * from './route.ts';
export * from './surface.ts';
