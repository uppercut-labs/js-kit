import { characterSummariesByGame } from './characterSummaries.js';
import type { RosterEntry } from './rosters.js';
import type { Character, RosterRole, SelectionSchema } from './types.js';

/** Date the rosters in this package were last checked against their sources. */
export const ROSTER_CHECKED_AT = '2026-08-25';

export const fighter = (
  slug: string,
  name: string,
  summary: string,
  sourceUrl: string,
  extra: Partial<Character> = {},
): Character => ({ slug, name, summary, sourceUrl, role: 'fighter', ...extra });

/** The gameplay summary for a character. Throws when there is none, so a roster cannot outgrow its summaries. */
export const summaryFor = (
  gameSlug: string,
  characterSlug: string,
  summaries: Readonly<Record<string, Readonly<Record<string, string>>>> = characterSummariesByGame,
): string => {
  const summary = summaries[gameSlug]?.[characterSlug];
  if (!summary) throw new Error(`Missing gameplay summary for ${gameSlug}/${characterSlug}.`);
  return summary;
};

export interface SourcedRosterOptions {
  /** Defaults to {@link ROSTER_CHECKED_AT}. */
  checkedAt?: string;
  /** Defaults to the summaries shipped in this package. */
  summaries?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Turns roster entries into characters that carry a summary and the source they were checked against. */
export const sourcedRoster = (
  gameSlug: string,
  sourceUrl: string,
  sourcePublisher: string,
  entries: readonly RosterEntry[],
  role: RosterRole = 'fighter',
  options: SourcedRosterOptions = {},
): Character[] => entries.map(({ slug, name }) => fighter(
  slug,
  name,
  summaryFor(gameSlug, slug, options.summaries),
  sourceUrl,
  { role, sourcePublisher, sourceCheckedAt: options.checkedAt ?? ROSTER_CHECKED_AT },
));

/** One character per pick. */
export const soloSchema = (verified = true): SelectionSchema => ({
  version: 1,
  noun: 'Character',
  verified,
  ordered: false,
  uniqueCharacters: true,
  slots: [{ id: 'fighter', label: 'Character', allowedRoles: ['fighter'] }],
});

/** An ordered team of `count` slots. */
export const teamSchema = (count: number, verified = true): SelectionSchema => ({
  version: 1,
  noun: 'Team',
  verified,
  ordered: true,
  uniqueCharacters: true,
  slots: Array.from({ length: count }, (_, index) => ({
    id: `slot-${index + 1}`,
    label: `Slot ${index + 1}`,
    allowedRoles: ['fighter'] as const,
  })),
});

/** A three-character Marvel vs. Capcom team where each slot also picks an assist. */
export const mvcSchema = (assistValues: string[]): SelectionSchema => ({
  version: 1,
  noun: 'Team',
  verified: true,
  ordered: true,
  uniqueCharacters: true,
  slots: Array.from({ length: 3 }, (_, index) => ({
    id: `slot-${index + 1}`,
    label: ['Point', 'Middle', 'Anchor'][index]!,
    allowedRoles: ['fighter'] as const,
    optionLabel: 'Assist',
    optionValues: assistValues,
  })),
});
