# js-kit

Small, focused JavaScript and TypeScript packages from Uppercut Labs, each published on its own under the `@uppercut-labs` scope on npm.

| Package | What it does |
| --- | --- |
| [`@uppercut-labs/read-body-with-size-limit`](packages/read-body-with-size-limit) | Reads a fetch Request or Response body as bytes, text or JSON without buffering more than a byte limit |

## Working in this repo

```sh
npm install
npm run check   # build every package, then run all tests
```

Each package lives in `packages/<name>` with its own `package.json`, `README.md` and tests in `test/`. Packages have no runtime dependencies on each other unless their README says so.

See [RELEASING.md](RELEASING.md) for how a version is published.

## License

MIT
