# @uppercut-labs/fgc-data

Typed fighting-game data in one place: the character rosters of twelve game lists, a gameplay summary for each character, a catalog of games with their team-selection rules, and the small builder functions that assemble them. Everything is plain data plus functions, so the package has no runtime dependencies and no side effects.

The catalog carries no character art. Art differs from app to app, so `withArt` attaches whatever art you have, of whatever type you choose, to a copy of the catalog.

```sh
npm install @uppercut-labs/fgc-data
```

## What runs where

All of it is TypeScript compiled to ESM JavaScript. It runs in Node 18 or later, browsers, Deno, Bun and Cloudflare Workers on any OS. Nothing here is PowerShell or Bash. The commands under Working on it work in PowerShell on Windows and in Bash on macOS and Linux.

## Example

```ts
import { catalog, findCharacter, getGame, withArt } from '@uppercut-labs/fgc-data';

const mvc2 = getGame('mvc2');
console.log(mvc2?.characters.length, mvc2?.schema.slots.map((slot) => slot.label));
console.log(findCharacter('mvc2', 'cable')?.summary);

// Attach your own art, of any type, to a copy of the catalog.
const withPortraits = withArt(catalog, (gameSlug, characterSlug) => ({ src: `/art/${gameSlug}-${characterSlug}.png` }));
console.log(withPortraits[0]?.characters[0]?.art?.src);
```

## Exports

| Export | What it is |
| --- | --- |
| `completeRosters` | Roster lists keyed by `marvelTokon`, `mvc2`, `umvc3`, `avatarFighters`, `melee`, `ggxxacpr`, `vampireSavior`, `sf6`, `mk1Fighters`, `mk1Kameos`, `tekken8`, `ggst`. Each entry is `{ slug, name }` |
| `avatarSupportOptionsByFighter`, `avatarSupportOptions` | The three support picks for each fighter of the Avatar game, and the combined list |
| `characterSummariesByGame` | `Record<gameSlug, Record<characterSlug, string>>`. The per-game objects (`mvc2CharacterSummaries` and so on) are exported too |
| `catalog`, `catalogBySlug` | Every game as a `GameVersion`: names, source and check date, selection schema, and characters with summary and source |
| `getGame(slug)`, `listGames()`, `findCharacter(gameSlug, characterSlug)` | Lookups |
| `withArt(games, lookup)` | Returns a copy of the games whose characters carry the art that `lookup(gameSlug, characterSlug, character)` returns. Characters with no art get no `art` field. The input is not changed |
| `fighter`, `sourcedRoster`, `summaryFor` | Build characters from roster entries. `sourcedRoster(gameSlug, sourceUrl, publisher, entries, role?, { checkedAt?, summaries? })` throws when an entry has no summary |
| `soloSchema`, `teamSchema(count)`, `mvcSchema(assists)` | Selection schemas |
| `ROSTER_CHECKED_AT` | Date the rosters were last checked against their sources |

Types: `Character<Art>`, `GameVersion<Art>`, `SelectionSchema`, `SelectionSlot`, `RosterRole`, `RosterEntry`, `SourcedRosterOptions`, `ArtLookup<Art>`. `Art` is `never` for the plain catalog and the type your lookup returns after `withArt`.

## Data and sources

Rosters come from each game's official pages, which each `Character.sourceUrl` names, and were last checked on the date in `ROSTER_CHECKED_AT`. The gameplay summaries are original text written for this package. Game names and character names belong to their publishers.

## Working on it

From the repository root:

```sh
npm install
npm run check
```

The tests check that ids are unique, every roster entry has a summary and no summary lacks a roster entry, every catalog character is on its roster, selection schemas are well formed, and `withArt` copies instead of changing the catalog.

## License

MIT
