import type { Aggregation } from './types.js';

/**
 * What the API sends back.
 *
 * The request schemas already live here, and the responses belong beside
 * them for the same reason: the web layer renders these fields and the API
 * builds them, and a field that means one thing on each side is a bug that
 * type checking would otherwise never see.
 *
 * Values are in stored units and timestamps are UTC epoch milliseconds
 * throughout. Conversion to something a parent reads happens in the input
 * and display layers, never here (spec 5.3).
 */

export type EventDto = {
  id: string;
  babyId: string;
  typeId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  endedAt: number | null;
  /** Computed by the server from startedAt and the baby timezone. */
  localDate: string;
  value: number;
  note: string;
  metadata: Record<string, string>;
  version: number;
  /** The sync cursor. Monotonic per baby, never a timestamp (spec 5.4). */
  rev: number;
  /** A running timer. Not the same as having no end time (spec 3.5). */
  active: boolean;
  /** Non-null marks a tombstone the client keeps but hides (spec 6.2). */
  deletedAt: number | null;
  tagIds: string[];
};

export type EventPageDto = {
  events: EventDto[];
  /** Store this and send it back; never derive a cursor from a clock. */
  nextRev: number;
  hasMore: boolean;
};

export type DayDto = { date: string; events: EventDto[] };

export type TypeSummaryDto = {
  typeId: string;
  lastStartedAt: number;
  lastValue: number;
  activeEventId: string | null;
  activeStartedAt: number | null;
  /** Stopping a timer is a PATCH, and a PATCH needs a version (spec 5.5). */
  activeVersion: number | null;
};

export type DiaperCountsDto = {
  /** Includes the combined ones, which are also counted under `both`. */
  pee: number;
  poo: number;
  both: number;
  /** Recorded without a kind. Never folded into pee or poo. */
  unknown: number;
  /** The number of events: pee + poo - both + unknown. */
  total: number;
};

export type SummaryDto = {
  /** The local date the totals cover, decided by the server. */
  date: string;
  types: TypeSummaryDto[];
  today: { totalBottleMl: number; diaper: DiaperCountsDto };
  /** Not limited to today: at half past midnight the last feed was yesterday. */
  lastFeedAt: number | null;
};

export type StatPointDto = {
  /** `YYYY-MM-DD` in the baby's timezone, as stored. */
  date: string;
  /**
   * Always an integer, in the type's stored unit (spec 5.3).
   *
   * `avg` is rounded to that unit, so a mean temperature comes back as 365
   * and is displayed as 36.5 -- the same contract as every other value the
   * API returns, and the reason no chart has to know about scaling.
   */
  value: number;
};

export type StatSeriesDto = {
  typeId: string;
  aggregation: Aggregation;
  /** The stored unit's symbol, or null for a type that has no value. */
  unit: string | null;
  /**
   * One point per local date, oldest first.
   *
   * Whether a day with nothing recorded appears here at all depends on the
   * aggregation, and the rule is spec 7.7's: a day with no feeds really had
   * no feeds, so `count` and `sum` carry a zero; a day nobody weighed the
   * baby is not a day the baby weighed nothing, so `last`, `avg` and `max`
   * leave it out and let the line join the points either side. Filling it
   * with zero there drops the weight curve to the floor.
   */
  points: StatPointDto[];
};

export type StatsDto = {
  from: string;
  to: string;
  series: StatSeriesDto[];
};

export type TagDto = { id: string; name: string; createdAt: number };

export type BabyDto = {
  id: string;
  nickname: string;
  gender: string;
  birthDate: string;
  timezone: string;
  role: 'owner' | 'member';
};

export type UserDto = { id: string; username: string };

export type MeDto = { user: UserDto; babies: BabyDto[] };

/**
 * One person with access to a baby.
 *
 * The username travels with it because the list is there to be read by a
 * family: a column of opaque ids answers none of the questions somebody
 * opens that screen with (spec 7.8).
 */
export type MemberDto = {
  userId: string;
  username: string;
  role: 'owner' | 'member';
  createdAt: number;
};

export type MembersDto = { members: MemberDto[] };

/**
 * A freshly made invitation.
 *
 * The code itself is returned exactly once, here. Only its digest is
 * stored, so there is nowhere to read it back from afterwards -- which is
 * the point of storing a digest (spec 6.5).
 */
export type InviteDto = { code: string; expiresAt: number };

export type LoginDto = { token: string; user: UserDto };
