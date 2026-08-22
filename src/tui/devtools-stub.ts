/**
 * Ink imports react-devtools-core unconditionally but only calls it when
 * `DEV=true`. The package is optional and usually absent, so the bundle aliases
 * this stub in its place rather than shipping several megabytes of dev tooling.
 */
export default { connectToDevTools: () => {} }
