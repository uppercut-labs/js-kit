/** Role of a roster entry inside a team slot. Most games only have fighters. */
export type RosterRole = 'fighter' | 'kameo';

/**
 * One character of a game. `Art` is the type of the optional `art` field. It is `never` for the plain
 * catalog, which carries no art. {@link withArt} returns a catalog whose characters carry art of a type you choose.
 */
export interface Character<Art = never> {
  slug: string;
  name: string;
  summary: string;
  sourceUrl: string;
  role: RosterRole;
  sourcePublisher?: string;
  /** ISO date (YYYY-MM-DD). */
  sourceCheckedAt?: string;
  art?: Art;
}

export interface SelectionSlot {
  id: string;
  label: string;
  allowedRoles: readonly RosterRole[];
  /** Per-slot option such as an assist or support pick. */
  optionLabel?: string;
  optionValues?: readonly string[];
  optionValuesByCharacter?: Readonly<Record<string, readonly string[]>>;
}

/** The shape of a pick: a single character, or an ordered team of slots. */
export interface SelectionSchema {
  version: 1;
  noun: string;
  verified: boolean;
  ordered: boolean;
  uniqueCharacters: boolean;
  slots: readonly SelectionSlot[];
  teamOptionLabel?: string;
  teamOptionValues?: readonly string[];
  constraintNote?: string;
}

export interface GameVersion<Art = never> {
  slug: string;
  name: string;
  shortName: string;
  releaseLabel: string;
  sourceUrl: string;
  /** ISO date (YYYY-MM-DD). */
  sourceCheckedAt: string;
  catalogStatus: 'verified';
  playerCount: number | null;
  schema: SelectionSchema;
  characters: Character<Art>[];
}
