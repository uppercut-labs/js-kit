import { describe, expect, it } from 'vitest';
import {
  fighter,
  mvcSchema,
  ROSTER_CHECKED_AT,
  soloSchema,
  sourcedRoster,
  summaryFor,
  teamSchema,
} from '../src/index.js';

const summaries = { game: { a: 'Summary of a.', b: 'Summary of b.' } };

describe('builders', () => {
  it('builds a fighter with the fighter role unless extra says otherwise', () => {
    expect(fighter('a', 'A', 'S', 'https://example.test')).toEqual({ slug: 'a', name: 'A', summary: 'S', sourceUrl: 'https://example.test', role: 'fighter' });
    expect(fighter('a', 'A', 'S', 'https://example.test', { role: 'kameo' }).role).toBe('kameo');
  });

  it('looks up a summary and throws when it is missing', () => {
    expect(summaryFor('game', 'a', summaries)).toBe('Summary of a.');
    expect(() => summaryFor('game', 'z', summaries)).toThrow('Missing gameplay summary for game/z.');
    expect(() => summaryFor('nogame', 'a', summaries)).toThrow('Missing gameplay summary');
  });

  it('builds a sourced roster with the check date and publisher', () => {
    const roster = sourcedRoster('game', 'https://example.test/roster', 'Publisher', [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }], 'fighter', { summaries });
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ slug: 'a', summary: 'Summary of a.', sourcePublisher: 'Publisher', sourceCheckedAt: ROSTER_CHECKED_AT, role: 'fighter' });
    const custom = sourcedRoster('game', 'https://example.test', 'P', [{ slug: 'a', name: 'A' }], 'kameo', { summaries, checkedAt: '2030-01-02' });
    expect(custom[0]).toMatchObject({ role: 'kameo', sourceCheckedAt: '2030-01-02' });
  });

  it('refuses a roster entry that has no summary', () => {
    expect(() => sourcedRoster('game', 'https://example.test', 'P', [{ slug: 'z', name: 'Z' }], 'fighter', { summaries })).toThrow('Missing gameplay summary');
  });

  it('builds solo, team and Marvel vs. Capcom schemas', () => {
    expect(soloSchema().slots).toHaveLength(1);
    expect(soloSchema().ordered).toBe(false);
    expect(soloSchema(false).verified).toBe(false);
    const team = teamSchema(4);
    expect(team.slots.map((slot) => slot.id)).toEqual(['slot-1', 'slot-2', 'slot-3', 'slot-4']);
    expect(team.ordered).toBe(true);
    const mvc = mvcSchema(['One', 'Two']);
    expect(mvc.slots.map((slot) => slot.label)).toEqual(['Point', 'Middle', 'Anchor']);
    expect(mvc.slots.every((slot) => slot.optionLabel === 'Assist' && slot.optionValues?.length === 2)).toBe(true);
  });
});
