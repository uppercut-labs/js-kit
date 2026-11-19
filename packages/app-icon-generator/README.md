# @uppercut-labs/app-icon-generator

Builds the icon files an app needs from one source image. It writes PNG sizes, maskable icons with a safe-zone margin, a Windows ICO, a macOS ICNS, Android launcher icons, a Linux size set and a web manifest `icons` array. The source can be a PNG, JPEG, WebP or SVG. The ICO and ICNS containers are written directly; [sharp](https://sharp.pixelplumbing.com) does the resizing.

```sh
npm install @uppercut-labs/app-icon-generator
```

```ts
import { generate } from '@uppercut-labs/app-icon-generator';

const { files, manifestIcons } = await generate('logo.svg', {
  outDir: 'public/icons',
  targets: ['pwa', 'apple-touch', 'favicon', 'ico'],
  maskableBackground: '#101820',
  manifest: true,
});
```

The same from the command line:

```sh
npx app-icon-generator logo.svg --out public/icons --targets pwa,ico,icns --manifest
```

## Targets

| Target | Files written under `outDir` |
| --- | --- |
| `pwa` | `icon-<size>.png` and `icon-maskable-<size>.png` for each PWA size (192 and 512) |
| `apple-touch` | `apple-touch-icon.png` (180 px, opaque) |
| `favicon` | `favicon.ico` (16, 32, 48 px) and `favicon.png` (32 px) |
| `android` | `mipmap-<density>/ic_launcher.png` and `ic_launcher_round.png`, mdpi to xxxhdpi |
| `ico` | `icon.ico` (16, 20, 24, 32, 40, 48, 64, 128, 256 px) |
| `icns` | `icon.icns` (16 to 1024 px, artwork at 824/1024 of the canvas) |
| `linux` | `linux/<size>x<size>.png` (16, 24, 32, 48, 64, 128, 256, 512 px) |

## Functions

| Function | Returns |
| --- | --- |
| `generate(source, options)` | `{ files, manifestIcons }` after writing the chosen targets |
| `renderPng(source, size, options?)` | square PNG `Buffer` |
| `renderMaskable(source, size, options?)` | opaque PNG with the art inset on each side |
| `renderScaled(source, size, scale, options?)` | PNG with the art scaled and centred on transparency |
| `renderRound(source, size, options?)` | circular PNG |
| `renderOpaque(source, size, options?)` | PNG flattened onto `background` |
| `packIco(frames)` | ICO `Buffer` from `{ size, data }` PNG frames |
| `packIcns(frames)` | ICNS `Buffer` from `{ type, data }` PNG frames |
| `webManifestIcons(sizes?, base?)` | manifest `icons` array |
| `runCli(argv, log?, logError?)` | exit code |

`source` is a file path or the image bytes as a `Uint8Array`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `outDir` | required | Folder to write into |
| `targets` | all | Any of `pwa`, `apple-touch`, `favicon`, `android`, `ico`, `icns`, `linux` |
| `fit` | `cover` | `cover` crops to fill the square; `contain` fits the whole image |
| `background` | `transparent` | Fill behind a contained image |
| `maskableInset` | `0.1` | Margin on each side of maskable icons, from 0 to 0.45 |
| `maskableBackground` | `#ffffff` | Background of maskable and apple-touch icons |
| `macArtScale` | `824/1024` | Share of the ICNS canvas the artwork fills |
| `icoSizes` | 16 to 256 | Pixel sizes in `icon.ico` |
| `linuxSizes` | 16 to 512 | Pixel sizes of the Linux PNG set |
| `pwaSizes` | `[192, 512]` | Sizes of the PWA icons |
| `manifest` | `false` | Also write `icons.manifest.json` |
| `manifestBase` | `/icons/` | URL prefix used in the manifest |

The command line takes the same settings as `--out`, `--targets`, `--fit`, `--background`, `--maskable-inset`, `--maskable-background`, `--mac-art-scale`, `--manifest` and `--manifest-base`.

## Errors

`generate` throws `Error` for an unknown target. The render and pack functions throw `RangeError` for sizes, insets or scales out of range, and sharp's error when the source cannot be read. The command line prints the message and exits 1 for those failures, or 2 for bad arguments.

## License

MIT
