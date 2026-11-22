import { describe, expect, it } from 'vitest';
import {
  avatarSupportOptions,
  avatarSupportOptionsByFighter,
  catalog,
  catalogBySlug,
  characterSummariesByGame,
  completeRosters,
  findCharacter,
  getGame,
  listGames,
} from '../src/index.js';

/** Which catalog game each roster list feeds. A game may be fed by more than one list. */
const rosterGames: Record<keyof typeof completeRosters, string> = {
  marvelTokon: 'marvel-tokon',
  mvc2: 'mvc2',
  umvc3: 'umvc3',
  avatarFighters: 'avatar-legends',
  melee: 'melee',
  ggxxacpr: 'ggxxacpr',
  vampireSavior: 'vampire-savior',
  sf6: 'sf6',
  mk1Fighters: 'mk1',
  mk1Kameos: 'mk1',
  tekken8: 'tekken-8',
  ggst: 'ggst',
};

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const slugShape = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('rosters', () => {
  it('maps every roster list to a game in the catalog', () => {
    expect(Object.keys(rosterGames).sort()).toEqual(Object.keys(completeRosters).sort());
    for (const game of Object.values(rosterGames)) expect(catalogBySlug.has(game), game).toBe(true);
  });

  it('has unique, well-formed slugs and non-empty names in every list', () => {
    for (const [key, entries] of Object.entries(completeRosters)) {
      const slugs = entries.map((entry) => entry.slug);
      expect(new Set(slugs).size, `${key} has duplicate slugs`).toBe(slugs.length);
      expect(entries.length, `${key} is empty`).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.slug, `${key}/${entry.slug}`).toMatch(slugShape);
        expect(entry.name.trim(), `${key}/${entry.slug}`).not.toBe('');
      }
    }
  });

  it('gives every roster entry a summary', () => {
    for (const [key, entries] of Object.entries(completeRosters)) {
      const game = rosterGames[key as keyof typeof completeRosters];
      for (const { slug } of entries) {
        const summary = characterSummariesByGame[game]?.[slug];
        expect(summary, `${game}/${slug} has no summary`).toBeTruthy();
      }
    }
  });

  it('has no summary for a character that is not on the roster', () => {
    for (const [game, summaries] of Object.entries(characterSummariesByGame)) {
      const slugs = new Set(
        Object.entries(completeRosters)
          .filter(([key]) => rosterGames[key as keyof typeof completeRosters] === game)
          .flatMap(([, entries]) => entries.map((entry) => entry.slug)),
      );
      for (const slug of Object.keys(summaries)) expect(slugs.has(slug), `${game}/${slug} is an orphan summary`).toBe(true);
    }
  });

  it('keeps summaries as non-empty sentences', () => {
    for (const [game, summaries] of Object.entries(characterSummariesByGame)) {
      for (const [slug, summary] of Object.entries(summaries)) {
        expect(summary.trim(), `${game}/${slug}`).toBe(summary);
        expect(summary.length, `${game}/${slug}`).toBeGreaterThan(20);
      }
    }
  });
});

describe('catalog', () => {
  it('has unique game slugs and well-formed fields', () => {
    const slugs = catalog.map((game) => game.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const game of catalog) {
      expect(game.slug).toMatch(slugShape);
      expect(game.name).not.toBe('');
      expect(game.sourceUrl).toMatch(/^https:\/\//);
      expect(game.sourceCheckedAt).toMatch(isoDate);
      expect(game.characters.length, game.slug).toBeGreaterThan(0);
    }
  });

  it('has unique character slugs inside each game and a summary, source and role for each', () => {
    for (const game of catalog) {
      const slugs = game.characters.map((character) => character.slug);
      expect(new Set(slugs).size, `${game.slug} has duplicate characters`).toBe(slugs.length);
      const allowed = new Set(game.schema.slots.flatMap((slot) => slot.allowedRoles));
      for (const character of game.characters) {
        const where = `${game.slug}/${character.slug}`;
        expect(character.slug, where).toMatch(slugShape);
        expect(character.name.trim(), where).not.toBe('');
        expect(character.summary.trim(), where).not.toBe('');
        expect(character.sourceUrl, where).toMatch(/^https:\/\//);
        expect(allowed.has(character.role), `${where} has role ${character.role} that no slot accepts`).toBe(true);
      }
    }
  });

  it('contains every roster entry for the games fed by a roster list', () => {
    for (const [key, entries] of Object.entries(completeRosters)) {
      const game = catalogBySlug.get(rosterGames[key as keyof typeof completeRosters])!;
      const slugs = new Set(game.characters.map((character) => character.slug));
      for (const { slug, name } of entries) {
        expect(slugs.has(slug), `${game.slug} is missing ${slug}`).toBe(true);
        expect(game.characters.find((character) => character.slug === slug)?.name).toBe(name);
      }
    }
  });

  it('marks Kameo entries with the kameo role and fighters with the fighter role', () => {
    const mk1 = catalogBySlug.get('mk1')!;
    for (const { slug } of completeRosters.mk1Kameos) expect(findCharacter('mk1', slug)?.role).toBe('kameo');
    for (const { slug } of completeRosters.mk1Fighters) expect(findCharacter('mk1', slug)?.role).toBe('fighter');
    expect(mk1.characters).toHaveLength(completeRosters.mk1Fighters.length + completeRosters.mk1Kameos.length);
  });

  it('has a selection schema whose slots are well formed', () => {
    for (const game of catalog) {
      const { schema } = game;
      expect(schema.version).toBe(1);
      expect(schema.slots.length, game.slug).toBeGreaterThan(0);
      const ids = schema.slots.map((slot) => slot.id);
      expect(new Set(ids).size, `${game.slug} has duplicate slot ids`).toBe(ids.length);
      for (const slot of schema.slots) {
        expect(slot.allowedRoles.length, `${game.slug}/${slot.id}`).toBeGreaterThan(0);
        if (slot.optionLabel) expect(slot.optionValues?.length, `${game.slug}/${slot.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('resolves the support options of the avatar game to its fighters', () => {
    const avatar = catalogBySlug.get('avatar-legends')!;
    const slugs = new Set(avatar.characters.map((character) => character.slug));
    for (const [fighterSlug, options] of Object.entries(avatarSupportOptionsByFighter)) {
      expect(slugs.has(fighterSlug), `${fighterSlug} is not an avatar fighter`).toBe(true);
      expect(options.length).toBe(3);
    }
    const slot = avatar.schema.slots[0]!;
    expect(slot.optionValuesByCharacter).toBe(avatarSupportOptionsByFighter);
    expect([...avatarSupportOptions].sort()).toEqual([...new Set(Object.values(avatarSupportOptionsByFighter).flat())].sort());
  });

  it('finds games and characters by slug', () => {
    expect(getGame('mvc2')?.shortName).toBe('MVC2');
    expect(getGame('nope')).toBeUndefined();
    expect(findCharacter('mvc2', 'cable')?.name).toBe('Cable');
    expect(findCharacter('mvc2', 'nope')).toBeUndefined();
    expect(findCharacter('nope', 'cable')).toBeUndefined();
    expect(listGames()).toBe(catalog);
  });
});
