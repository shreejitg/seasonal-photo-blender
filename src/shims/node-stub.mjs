/**
 * Stub for `fs` / `path` in the browser. @xenova/transformers env.js does
 * `Object.keys(fs)`; `undefined` throws — empty object is OK.
 */
const stub = Object.freeze({});
export default stub;
