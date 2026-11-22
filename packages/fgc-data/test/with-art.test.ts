import { describe, expect, it } from 'vitest';
import { catalog, findCharacter, withArt, type GameVersion } from '../src/index.js';

interface Portrait {
  path: string;
}

describe('withArt', () => {
  it('attaches the art a lookup returns and leaves other characters without an art field', () => {
    const games: GameVersion<Portrait>[] = withArt(catalog, (gameSlug, characterSlug) =>
      gameSlug === 'mvc2' && characterSlug === 'cable' ? { path: '/art/cable.png' } : undefined);
    const mvc2 = games.find((game) => game.slug === 'mvc2')!;
    expect(mvc2.characters.find((character) => character.slug === 'cable')?.art).toEqual({ path: '/art/cable.png' });
    expect(mvc2.characters.find((character) => character.slug === 'wolverine')).not.toHaveProperty('art');
    expect(games).toHaveLength(catalog.length);
  });

  it('does not change the catalog it was given', () => {
    withArt(catalog, () => ({ path: '/art/x.png' }));
    expect(findCharacter('mvc2', 'cable')).not.toHaveProperty('art');
    expect(catalog.every((game) => game.characters.every((character) => !('art' in character)))).toBe(true);
  });

  it('passes the game, the character and the character record to the lookup', () => {
    const seen: string[] = [];
    withArt(catalog, (gameSlug, characterSlug, character) => {
      expect(character.slug).toBe(characterSlug);
      seen.push(`${gameSlug}/${characterSlug}`);
      return undefined;
    });
    expect(seen).toContain('mvc2/cable');
    expect(seen).toHaveLength(catalog.reduce((sum, game) => sum + game.characters.length, 0));
  });

  it('copies a game without sharing its characters array', () => {
    const [first] = withArt(catalog, () => undefined);
    expect(first!.characters).not.toBe(catalog[0]!.characters);
    expect(first!.characters).toEqual(catalog[0]!.characters);
  });
});
