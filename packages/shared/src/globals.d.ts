/**
 * Shared code runs in two runtimes: the Worker and the browser.
 *
 * Both provide `console`, but neither `lib: ES2022` alone declares it. This
 * narrow declaration covers what is actually used, rather than pulling in the
 * whole DOM library — which would also make `document` and `window` look
 * available here, and they are not.
 */
declare const console: {
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
