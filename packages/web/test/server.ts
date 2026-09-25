import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { APP_VERSION, addLocalDays, getEventType, toLocalDate } from '@dongfan/shared';
import type {
  BabyDto, EventDto, MeDto, SummaryDto, TypeSummaryDto,
} from '@dongfan/shared';
import { USER_CONTENT } from './fixtures/user-content.js';

/**
 * A stand-in for the API, intercepted at the network boundary.
 *
 * It holds events and answers the endpoints the screens call. What it does
 * not do is settle any question the real handlers settle: the arithmetic in
 * the summary, the version guard and the idempotency rules are tested
 * against a real D1 in the api package, where they actually live (spec 11.3).
 *
 * What these tests are for is the wiring: whether the screen sends the body
 * the contract describes, and whether it can show what comes back.
 */

const TZ = 'Asia/Taipei';
export const TOKEN = 'test-session-token';

export const BABY: BabyDto = {
  id: 'baby-1',
  nickname: USER_CONTENT.nickname,
  gender: 'other',
  birthDate: '2026-03-08',
  timezone: TZ,
  role: 'owner',
};

const ME: { user: MeDto['user']; babies: MeDto['babies'] } = { user: { id: 'user-1', username: 'parent' }, babies: [BABY] };

type Failure = { status: number; code: string; fields?: { field: string; code: string; params: Record<string, unknown> }[] };

type Recorded = {
  method: string;
  path: string;
  /** Kept apart from the path, so assertions on either stay readable. */
  query: URLSearchParams;
  body: unknown;
};

class Api {
  events: EventDto[] = [];
  requests: Recorded[] = [];
  /** Consumed by the next write, whichever endpoint it reaches. */
  nextFailure: Failure | null = null;
  /**
   * Stores the next event and then loses the reply, which is the case the
   * client cannot tell apart from a refusal (spec 6.1).
   */
  loseNextResponse = false;
  loginFails = false;
  /** Makes the statistics endpoint refuse, for the failure state. */
  failStats = false;
  /**
   * What the statistics endpoint reports for a date.
   *
   * Set by the tests rather than derived from `events`: the aggregation is
   * proved against a real database in the API suite, and deriving it here
   * would mean the screen tests were checking this file's arithmetic.
   */
  statsValues: Record<string, number> = {};
  /** Holds the next write until a test lets it go (see `holdNextWrite`). */
  private gate: Promise<void> | null = null;
  /** Holds the next pull of the sync feed (see `holdNextSync`). */
  private syncGate: Promise<void> | null = null;
  /** Pulls of the sync feed in flight right now, and the most there ever were. */
  private syncing = 0;
  maxConcurrentSyncs = 0;
  private rev = 0;

  /** The next rev, allocated the way the server does (spec 5.4). */
  nextRev(): number {
    this.rev += 1;
    return this.rev;
  }

  /**
   * A different account for every test.
   *
   * Everything the app stores is scoped by account, so a test that starts
   * where the last one left off can have the previous test's still-running
   * work reading and writing its queue. Giving each test its own account
   * makes that impossible rather than unlikely: a leftover drain looks in
   * a scope nothing has put anything into.
   */
  private accounts = 0;

  /** The account the token currently belongs to. */
  get userId(): string {
    return ME.user.id;
  }

  /** Switches which account the token belongs to, for isolation tests. */
  signInAs(userId: string): void {
    ME.user = { id: userId, username: userId };
  }

  /**
   * Makes the next write hang until the returned function is called.
   *
   * For the window between a request leaving and its answer arriving,
   * which is long enough on a real phone for somebody to keep typing.
   */
  holdNextWrite(): () => void {
    let release = (): void => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    return release;
  }

  async waitForRelease(): Promise<void> {
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
  }

  /** Makes the next pull of the sync feed hang until it is let go. */
  holdNextSync(): () => void {
    let release = (): void => undefined;
    this.syncGate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    return release;
  }

  /**
   * Counts how many pulls overlap.
   *
   * The one thing a unit test of the queue cannot see is whether every
   * entrance is actually wired to it, so it is counted here instead.
   */
  async duringSync<T>(work: () => Promise<T> | T): Promise<T> {
    this.syncing += 1;
    this.maxConcurrentSyncs = Math.max(this.maxConcurrentSyncs, this.syncing);
    try {
      const gate = this.syncGate;
      this.syncGate = null;
      if (gate) await gate;
      return await work();
    } finally {
      this.syncing -= 1;
    }
  }

  /**
   * The build the API says it is.
   *
   * The same as the client's by default: a test that wants the update
   * strip sets it to something else, which is what a deploy looks like
   * from a phone that has been open since Tuesday.
   */
  serverVersion: string = APP_VERSION;

  /**
   * Who can see the baby, and any code that has been handed out.
   *
   * Modelled only as far as the contract goes. Whether a code can be spent
   * twice, or survives an hour, or lets somebody into a different baby, is
   * decided by SQL and tested against a real D1 -- re-implementing those
   * rules here would only prove this file agrees with itself (spec 11.3).
   */
  members: { userId: string; username: string; role: 'owner' | 'member' }[] = [
    { userId: 'user-1', username: 'parent', role: 'owner' },
  ];

  /** Codes handed out and not yet spent, with the baby each opens. */
  invites = new Map<string, string>();

  /** Set when the next join should be refused, as an unknown code would be. */
  joinFails = false;

  /** A freshly deployed database: an account, and nothing else. */
  startWithNoBaby(): void {
    ME.babies = [];
  }

  /** A second baby on the account, for the switcher (spec 7.10). */
  alsoHasBaby(baby: BabyDto): void {
    ME.babies = [...ME.babies, baby];
  }

  /** What the next join answers with, when it is not this account's own. */
  joinsInto: BabyDto | null = null;

  reset(): void {
    // The baby is a shared object the settings screen edits in place, so
    // one test's rename must not become the next one's fixture.
    Object.assign(BABY, {
      nickname: USER_CONTENT.nickname, gender: 'other', birthDate: '2026-03-08', role: 'owner',
    });
    this.members = [{ userId: `user-${this.accounts + 1}`, username: 'parent', role: 'owner' }];
    this.invites = new Map();
    this.joinFails = false;
    this.joinsInto = null;
    this.serverVersion = APP_VERSION;
    this.accounts += 1;
    ME.user = { id: `user-${this.accounts}`, username: 'parent' };
    ME.babies = [BABY];
    this.events = [];
    this.requests = [];
    this.nextFailure = null;
    this.loseNextResponse = false;
    this.failStats = false;
    this.statsValues = {};
    this.loginFails = false;
    this.gate = null;
    this.syncGate = null;
    this.syncing = 0;
    this.maxConcurrentSyncs = 0;
    this.rev = 0;
  }

  add(partial: Partial<EventDto> & { typeId: string }): EventDto {
    this.rev += 1;
    const now = Date.now();
    const startedAt = partial.startedAt ?? now;
    const event: EventDto = {
      id: partial.id ?? `event-${this.rev}`,
      babyId: BABY.id,
      createdBy: ME.user.id,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      localDate: toLocalDate(startedAt, TZ),
      value: 1,
      note: '',
      metadata: {},
      version: 1,
      active: false,
      deletedAt: null,
      tagIds: [],
      ...partial,
      startedAt,
      rev: this.rev,
    };
    this.events.push(event);
    return event;
  }

  find(id: string): EventDto | undefined {
    return this.events.find((event) => event.id === id && event.deletedAt === null);
  }

  /**
   * The last write to a path containing the given fragment.
   *
   * Reads are skipped: `/events` also matches the summary and the day, and
   * a test asking what was sent means the body of a write. Reads are still
   * recorded, and `requests` has all of them in order.
   */
  lastRequest(fragment: string): Recorded | undefined {
    return [...this.requests]
      .reverse()
      .find((entry) => entry.method !== 'GET' && entry.path.includes(fragment));
  }

  /** The same for reads, which is what a chart makes. */
  lastGet(fragment: string): Recorded | undefined {
    return [...this.requests]
      .reverse()
      .find((entry) => entry.method === 'GET' && entry.path.includes(fragment));
  }

  summary(): SummaryDto {
    const today = toLocalDate(Date.now(), TZ);
    const live = this.events.filter((event) => event.deletedAt === null);

    const types = new Map<string, TypeSummaryDto>();
    for (const event of [...live].sort((a, b) => b.startedAt - a.startedAt)) {
      const entry = types.get(event.typeId);
      if (!entry) {
        types.set(event.typeId, {
          typeId: event.typeId,
          lastStartedAt: event.startedAt,
          lastValue: event.value,
          activeEventId: event.active ? event.id : null,
          activeStartedAt: event.active ? event.startedAt : null,
          activeVersion: event.active ? event.version : null,
        });
      } else if (event.active && entry.activeEventId === null) {
        entry.activeEventId = event.id;
        entry.activeStartedAt = event.startedAt;
        entry.activeVersion = event.version;
      }
    }

    const todays = live.filter((event) => event.localDate === today);
    const diaper = { pee: 0, poo: 0, both: 0, unknown: 0, total: 0 };
    for (const event of todays.filter((e) => e.typeId === 'diaper')) {
      diaper.total += 1;
      const kind = event.metadata['diaper_kind'];
      if (kind === 'pee') diaper.pee += 1;
      else if (kind === 'poo') diaper.poo += 1;
      else if (kind === 'both') { diaper.both += 1; diaper.pee += 1; diaper.poo += 1; }
      else diaper.unknown += 1;
    }

    return {
      date: today,
      types: [...types.values()],
      today: {
        totalBottleMl: todays.filter((e) => e.typeId === 'bottle').reduce((sum, e) => sum + e.value, 0),
        diaper,
      },
      lastFeedAt:
        [...live]
          .filter((e) => e.typeId === 'nursing' || e.typeId === 'bottle')
          .sort((a, b) => b.startedAt - a.startedAt)[0]?.startedAt ?? null,
    };
  }
}

export const api = new Api();

function refuse(failure: Failure): Response {
  return HttpResponse.json(
    { error: { code: failure.code, details: failure.fields ? { fields: failure.fields } : null } },
    { status: failure.status },
  );
}

/** Takes the queued failure, if the test armed one. */
function pending(): Failure | null {
  const failure = api.nextFailure;
  api.nextFailure = null;
  return failure;
}

async function record(request: Request): Promise<unknown> {
  const url = new URL(request.url);
  const body = request.method === 'GET' ? null : await request.clone().json().catch(() => null);
  api.requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body });
  return body;
}

export const server = setupServer(
  http.post('/api/auth/login', async ({ request }) => {
    await record(request);
    if (api.loginFails) return refuse({ status: 401, code: 'UNAUTHENTICATED' });
    return HttpResponse.json({ token: TOKEN, user: ME.user });
  }),

  http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),

  // What the running build compares itself against, so a page left open
  // can find out it is behind (spec 2.1).
  http.get('/api/version', async ({ request }) => {
    await record(request);
    return HttpResponse.json({ version: api.serverVersion });
  }),

  http.get('/api/me', ({ request }) => {
    const header = request.headers.get('Authorization');
    if (header !== `Bearer ${TOKEN}`) return refuse({ status: 401, code: 'UNAUTHENTICATED' });
    return HttpResponse.json(ME);
  }),

  http.post('/api/babies', async ({ request }) => {
    const body = (await record(request)) as Record<string, unknown>;
    await api.waitForRelease();
    const failure = pending();
    if (failure) return refuse(failure);

    const created: BabyDto = {
      id: String(body['id'] ?? BABY.id),
      nickname: String(body['nickname']),
      gender: String(body['gender']),
      birthDate: String(body['birthDate']),
      timezone: TZ,
      role: 'owner',
    };
    // The same id twice returns what is already there, as the real handler
    // does (spec 5.8), or the retry rules on the client mean nothing.
    const already = ME.babies.find((baby) => baby.id === body['id']);
    if (already) return HttpResponse.json(already, { status: 200 });

    ME.babies = [created];

    if (api.loseNextResponse) {
      api.loseNextResponse = false;
      // Created, but the client will never hear so.
      return HttpResponse.error();
    }
    return HttpResponse.json(created, { status: 201 });
  }),

  http.get('/api/babies/:babyId/members', async ({ request }) => {
    await record(request);
    return HttpResponse.json({ members: api.members.map((m) => ({ ...m, createdAt: 0 })) });
  }),

  http.post('/api/babies/:babyId/invite', async ({ request, params }) => {
    await record(request);
    const failure = pending();
    if (failure) return refuse(failure);

    const code = `ABCDE-FGHJK-MNPQR-STVWX-YZ${api.invites.size}23-45678`;
    api.invites.set(code, String(params['babyId']));
    return HttpResponse.json({ code, expiresAt: Date.now() + 60 * 60 * 1000 }, { status: 201 });
  }),

  http.post('/api/babies/join', async ({ request }) => {
    const body = (await record(request)) as Record<string, unknown>;
    const failure = pending();
    if (failure) return refuse(failure);

    const code = String(body['code'] ?? '');
    if (api.joinFails || !api.invites.has(code)) return refuse({ status: 404, code: 'NOT_FOUND' });

    api.invites.delete(code);
    const joined = api.joinsInto ?? BABY;
    if (!ME.babies.some((baby) => baby.id === joined.id)) ME.babies = [...ME.babies, joined];
    return HttpResponse.json(joined, { status: 201 });
  }),

  http.delete('/api/babies/:babyId/members/:userId', async ({ request, params }) => {
    await record(request);
    const failure = pending();
    if (failure) return refuse(failure);

    const target = String(params['userId']);
    api.members = api.members.filter((member) => member.userId !== target);
    if (target === ME.user.id) ME.babies = [];
    return new HttpResponse(null, { status: 204 });
  }),

  http.patch('/api/babies/:babyId', async ({ request }) => {
    const body = (await record(request)) as Record<string, unknown>;
    const failure = pending();
    if (failure) return refuse(failure);

    if (body['nickname'] !== undefined) BABY.nickname = String(body['nickname']);
    if (body['gender'] !== undefined) BABY.gender = String(body['gender']);
    if (body['birthDate'] !== undefined) BABY.birthDate = String(body['birthDate']);
    return HttpResponse.json(BABY);
  }),

  http.get('/api/babies/:babyId/events', async ({ request }) => {
    await record(request);
    const url = new URL(request.url);
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 200);

    return api.duringSync(() => {
      // Tombstones travel too, or the other phone never learns about a
      // deletion (spec 5.4).
      const ordered = [...api.events].sort((a, b) => a.rev - b.rev).filter((e) => e.rev > since);
      const page = ordered.slice(0, limit);
      const last = page[page.length - 1];

      return HttpResponse.json({
        events: page,
        // The last rev of the page, never the highest in the table, and the
        // cursor it was given when the page is empty (spec 5.4).
        nextRev: last ? last.rev : since,
        hasMore: ordered.length > page.length,
      });
    });
  }),

  http.get('/api/babies/:babyId/events/summary', async ({ request }) => {
    await record(request);
    return HttpResponse.json(api.summary());
  }),

  http.get('/api/babies/:babyId/events/day/:date', async ({ request, params }) => {
    await record(request);
    const date = String(params['date']);
    const events = api.events.filter((event) => event.deletedAt === null && event.localDate === date);
    const allDay = events.filter((event) => getEventType(event.typeId)?.allDay === true);
    const timed = events.filter((event) => !allDay.includes(event)).sort((a, b) => b.startedAt - a.startedAt);
    return HttpResponse.json({ date, events: [...allDay, ...timed] });
  }),

  /**
   * The statistics endpoint, answering what was asked for.
   *
   * Deliberately thin: the aggregation is tested against a real D1 in the
   * API suite, and re-implementing it here would test this file. What the
   * screen tests need is the shape of the contract -- one point per day,
   * integers in stored units, the aggregation named -- and the query
   * actually reaching the server.
   */
  http.get('/api/babies/:babyId/stats', async ({ request }) => {
    await record(request);
    const url = new URL(request.url);
    const from = String(url.searchParams.get('from'));
    const to = String(url.searchParams.get('to'));
    const types = String(url.searchParams.get('types')).split(',').filter((t) => t !== '');

    if (api.failStats) return new HttpResponse(null, { status: 500 });

    return HttpResponse.json({
      from,
      to,
      series: types.map((typeId) => {
        const type = getEventType(typeId);
        const aggregation = type?.aggregation ?? 'count';
        const filled = ['count', 'sum', 'duration_sum'].includes(aggregation);

        const points: { date: string; value: number }[] = [];
        for (let date = from; date <= to; date = addLocalDays(date, 1)) {
          const value = api.statsValues[date] ?? 0;
          if (filled || value > 0) points.push({ date, value });
        }

        return {
          typeId,
          aggregation,
          unit: aggregation === 'duration_sum' ? 'min' : type?.value?.unit ?? null,
          points,
        };
      }),
    });
  }),

  http.post('/api/babies/:babyId/events', async ({ request }) => {
    const body = (await record(request)) as Record<string, unknown>;
    await api.waitForRelease();
    const failure = pending();
    if (failure) return refuse(failure);

    // Idempotency, because the retry rules on the client are meaningless
    // without it: the same id must reach the same row (spec 5.8).
    const already = api.find(String(body['id']));
    if (already) return HttpResponse.json(already, { status: 200 });

    const created = api.add({
      id: String(body['id']),
      typeId: String(body['typeId']),
      startedAt: Number(body['startedAt']),
      endedAt: body['endedAt'] === null ? null : Number(body['endedAt']),
      value: body['value'] === undefined ? 1 : Number(body['value']),
      note: String(body['note'] ?? ''),
      metadata: (body['metadata'] ?? {}) as Record<string, string>,
      active: body['intent'] === 'start_timer',
    });
    if (api.loseNextResponse) {
      api.loseNextResponse = false;
      // Stored, but the client will never hear so.
      return HttpResponse.error();
    }
    return HttpResponse.json(created, { status: 201 });
  }),

  http.get('/api/events/:eventId', ({ params }) => {
    const event = api.find(String(params['eventId']));
    return event ? HttpResponse.json(event) : refuse({ status: 404, code: 'NOT_FOUND' });
  }),

  http.patch('/api/events/:eventId', async ({ request, params }) => {
    const body = (await record(request)) as Record<string, unknown>;
    const failure = pending();
    if (failure) return refuse(failure);

    const event = api.find(String(params['eventId']));
    if (!event) return refuse({ status: 404, code: 'NOT_FOUND' });
    if (event.version !== Number(body['version'])) return refuse({ status: 409, code: 'VERSION_CONFLICT' });

    const endedAt = body['endedAt'] === undefined
      ? event.endedAt
      : body['endedAt'] === null ? null : Number(body['endedAt']);

    Object.assign(event, {
      rev: api.nextRev(),
      startedAt: body['startedAt'] === undefined ? event.startedAt : Number(body['startedAt']),
      endedAt,
      value: body['value'] === undefined ? event.value : Number(body['value']),
      note: body['note'] === undefined ? event.note : String(body['note']),
      metadata: (body['metadata'] ?? event.metadata) as Record<string, string>,
      active: event.active && endedAt === null,
      version: event.version + 1,
    });
    event.localDate = toLocalDate(event.startedAt, TZ);

    if (api.loseNextResponse) {
      api.loseNextResponse = false;
      // Applied, but the client will never hear so. For a stop, that
      // leaves the phone holding a moment the server has already recorded
      // (spec 7.2).
      return HttpResponse.error();
    }
    return HttpResponse.json(event);
  }),

  http.delete('/api/events/:eventId', async ({ request, params }) => {
    const body = (await record(request)) as Record<string, unknown>;
    const failure = pending();
    if (failure) return refuse(failure);

    const event = api.find(String(params['eventId']));
    if (!event) return refuse({ status: 404, code: 'NOT_FOUND' });
    if (event.version !== Number(body['version'])) return refuse({ status: 409, code: 'VERSION_CONFLICT' });

    event.deletedAt = Date.now();
    event.active = false;
    event.version += 1;
    // A tombstone with the old rev never reaches the other device.
    event.rev = api.nextRev();
    return HttpResponse.json(event);
  }),
);
