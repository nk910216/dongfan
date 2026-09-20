import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { getEventType, toLocalDate } from '@dongfan/shared';
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

const ME: MeDto = { user: { id: 'user-1', username: 'parent' }, babies: [BABY] };

type Failure = { status: number; code: string; fields?: { field: string; code: string; params: Record<string, unknown> }[] };

type Recorded = { method: string; path: string; body: unknown };

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
  private rev = 0;

  reset(): void {
    this.events = [];
    this.requests = [];
    this.nextFailure = null;
    this.loseNextResponse = false;
    this.loginFails = false;
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
  api.requests.push({ method: request.method, path: url.pathname, body });
  return body;
}

export const server = setupServer(
  http.post('/api/auth/login', async ({ request }) => {
    await record(request);
    if (api.loginFails) return refuse({ status: 401, code: 'UNAUTHENTICATED' });
    return HttpResponse.json({ token: TOKEN, user: ME.user });
  }),

  http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),

  http.get('/api/me', ({ request }) => {
    const header = request.headers.get('Authorization');
    if (header !== `Bearer ${TOKEN}`) return refuse({ status: 401, code: 'UNAUTHENTICATED' });
    return HttpResponse.json(ME);
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

  http.post('/api/babies/:babyId/events', async ({ request }) => {
    const body = (await record(request)) as Record<string, unknown>;
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
      startedAt: body['startedAt'] === undefined ? event.startedAt : Number(body['startedAt']),
      endedAt,
      value: body['value'] === undefined ? event.value : Number(body['value']),
      note: body['note'] === undefined ? event.note : String(body['note']),
      metadata: (body['metadata'] ?? event.metadata) as Record<string, string>,
      active: event.active && endedAt === null,
      version: event.version + 1,
    });
    event.localDate = toLocalDate(event.startedAt, TZ);
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
    return HttpResponse.json(event);
  }),
);
