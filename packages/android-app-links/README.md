# @uppercut-labs/android-app-links

Serves Android App Links for a web product from one function. It answers two paths and returns `null` for every other:

- `GET /.well-known/assetlinks.json`: the Digital Asset Links statements for the product's debug and release Android apps, built from package names and signing-certificate fingerprints.
- `GET /android/callback`: the sign-in return path an installed app intercepts as a verified App Link. In a browser, where the app is not installed, it is a branded page that says to open the app. The page is built only from the brand you pass, never from the URL, so it cannot reflect the authorization code or state it was sent.

```sh
npm install @uppercut-labs/android-app-links
```

## What runs where

TypeScript compiled to ESM JavaScript. It is server code that takes a standard `Request` and returns a `Response`, so it runs in Node 18 or later, Deno, Bun and Cloudflare Workers with Node compatibility turned on (it imports `node:crypto` to hash the page style). It runs on any OS. Nothing here is PowerShell or Bash. The commands under Working on it work in PowerShell on Windows and in Bash on macOS and Linux.

## Example

```ts
import { handleAndroidLinks, type CallbackBrand } from '@uppercut-labs/android-app-links';

const brand: CallbackBrand = {
  name: 'Notes',
  logo: '/icon.svg',
  homeHref: '/',
  colors: { base: '#0c1016', glow: '#1b2b43', button: '#dceafd', buttonBorder: '#cadcf5', buttonText: '#0c203c', focus: '#8db8f2' },
};

export default {
  async fetch(request: Request, env: Record<string, string>) {
    const answered = handleAndroidLinks(request, {
      debugPackage: env.ANDROID_DEBUG_PACKAGE,
      debugCertSha256: env.ANDROID_DEBUG_CERT_SHA256,
      releasePackage: env.ANDROID_RELEASE_PACKAGE,
      releaseCertSha256: env.ANDROID_RELEASE_CERT_SHA256,
    }, brand);
    if (answered) return answered; // null for every other path
    return new Response('Not found', { status: 404 });
  },
};
```

`assetlinks.json` lists each build whose package and fingerprints are both set. It is 404 when none is, and 503 when a value is malformed. A build with a package but no fingerprints yet (a release key that does not exist yet) is left out. The callback page carries a Content-Security-Policy that allows only its own hashed style; keep that policy when you add your own headers. Both paths answer `GET` and `HEAD`; any other method gets 405.

## Exports

| Export | What it is |
| --- | --- |
| `handleAndroidLinks(request, settings, brand)` | Answers the two paths, or returns `null` |
| `androidTargets(settings)` | The apps to declare, as `{ packageName, fingerprints }`. Throws `AndroidLinksConfigError` on a malformed package name or fingerprint |
| `assetLinks(targets)` | The Digital Asset Links statement list for those apps |
| `parseFingerprints(value)` | Splits, upper-cases and de-duplicates a comma-separated list of SHA-256 fingerprints (`AA:BB:...`, 32 bytes); throws on a malformed entry |
| `callbackPage(brand)` | `{ html, styleHash }`: the page and the base64 SHA-256 of its inline style, for a CSP |
| `ASSET_LINKS_PATH`, `ANDROID_CALLBACK_PATH` | The two paths |
| `AndroidLinksConfigError` | Thrown for malformed configuration |

Types: `AndroidAppSettings`, `AndroidAppTarget`, `CallbackBrand`.

The logo is shown at its own proportions, with no rounding, mask or clipping. The brand values are HTML-escaped.

## Working on it

From the repository root:

```sh
npm install
npm run check
```

## License

MIT
