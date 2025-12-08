## Vitesse

## :coffee:

[buy me a cup of coffee](https://github.com/Simon-He95/sponsor)

## License

[MIT](./license)

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.svg">
    <img src="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.png"/>
  </a>
</p>

## TODO

- [x] Stage heavy tarball fallbacks so CDN/private resources get a chance to finish before `runFromOther` starts.
- [x] Cache resolved tarball URLs per `name@version` to skip redundant metadata downloads.
- [x] Stream tarball downloads directly into extraction to avoid writing and rereading `.tgz` files.
- [x] Reuse keep-alive HTTP agents and explicit request aborts/timeouts for every registry/mirror call.
- [x] Move `npm pack`/CLI fallbacks behind opt-in flags or final retry tiers to keep the fast path lightweight.

## Configuration

- `allowCliFallback`: per-call override that defaults to the environment flag (or `true` when unset). Set to `false` to skip the CLI fallback entirely, or `true` to force it even if the environment disabled it.
- `FETCH_NPM_ALLOW_CLI_FALLBACK`: global default for whether the `npm pack` fallback is allowed. Leave unset (or set to `true`) to keep compatibility, set to `false` to disable the CLI path everywhere without touching code.
- `signal`: pass an `AbortSignal` to the CJS fetch helpers to cancel CDN races early. When aborted, all in-flight CDN requests are stopped and heavy fallbacks are skipped.
- `allowRemoteImport`: ESM fetch option that lets you disable remote `import()` attempts (defaults to automatic detection). Set to `false` in Node environments to skip unsupported HTTPS imports and go straight to the CJS-based fallback, or `true` to force remote imports when running in runtimes that support them.
- `FETCH_NPM_ALLOW_REMOTE_ESM`: environment flag that controls the default `allowRemoteImport` behavior. Leave unset for auto-detection, set to `false` to always skip network imports, or `true` to attempt them even when the runtime might not support HTTPS specifiers.
