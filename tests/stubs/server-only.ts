/**
 * Test stub for the `server-only` package.
 *
 * That package deliberately throws when it is resolved outside a React Server
 * Component graph, which is what makes it useful in the app — and what makes it
 * unloadable in a Node test runner. Aliased here so integration tests can
 * import server modules directly.
 *
 * The guarantee it provides is a build-time one and is unaffected: `npm run
 * build` still fails if a client component imports one of those modules.
 */
export {};
