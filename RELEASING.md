# Releasing

Every package is versioned and published on its own. A release only goes out after the release gate passes on the source tree, the git history and the exact tarball that will be uploaded.

1. Bump `version` in `packages/<name>/package.json` and note the change in the package README if behavior changed.
2. `npm install && npm run check`
3. `npm pack --workspace packages/<name> --pack-destination dist-pack`
4. `python tools/release_gate.py --artifact dist-pack/<tarball>.tgz`
   - The gate needs `RELEASE_GATE_DENYLIST` (a private file of strings that must never ship, kept outside this repo) and `gitleaks` on `PATH` or in `GITLEAKS`.
   - Exit code 0 is the only passing result.
5. `npm publish dist-pack/<tarball>.tgz --access public`
6. Tag the commit `<name>@<version>` and push the tag.

Releases are made from a maintainer machine. This repository does not use hosted CI for publishing.
