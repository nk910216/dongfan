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

export type LoginDto = { token: string; user: UserDto };
