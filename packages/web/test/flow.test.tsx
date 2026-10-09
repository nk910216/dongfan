import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HttpResponse, http } from 'msw';
import {
  addLocalDays, eventTypeName, fromLocalInput, interpolate, metadataLabel,
  metadataOptionLabel,
  startOfLocalDay, toLocalDate, toLocalInput, toStored, valueLabel, zhTW,
} from '@dongfan/shared';
import { App } from '../src/App.js';
import { BABY, TOKEN, api, server } from './server.js';
import { resetLanes } from '../src/lib/lane.js';
import { offerUpdate, setWorkerCheck } from '../src/lib/update.js';
import { formKey, readForm, saveForm } from '../src/lib/form-draft.js';
import { findEvent as findLocalEvent, scopeOf } from '../src/lib/db.js';
import { queueAdd } from '../src/lib/outbox.js';
import { earlierToday as atEarlierToday } from './fixtures/clock.js';
import { formatClock } from '../src/lib/format.js';
import { daysIn } from '../src/lib/stats-range.js';
import { breakStorage, setMeasuredWidth, setOnline, setViewportWidth } from './setup.js';
import { USER_CONTENT } from './fixtures/user-content.js';

/**
 * Screen tests, driven the way a parent would drive them.
 *
 * What is under test is the wiring: whether a tap produces the request the
 * contract describes, and whether the screen can show what comes back. The
 * rules themselves are tested where they live, against a real D1.
 */

const HOUR = 3_600_000;

/**
 * An instant earlier today, in the baby's timezone.
 *
 * Its rules, and the midnight boundary they exist for, are pinned in
 * `clock.test.ts` rather than left to be discovered by this suite failing
 * at two in the morning.
 */
function earlierToday(msAgo: number): number {
  return atEarlierToday(msAgo, BABY.timezone);
}

function open(path = '/'): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return user;
}

/**
 * Flight mode, as a phone actually presents it.
 *
 * Both halves matter. `navigator.onLine` is what the app asks before it
 * writes anything, and the handlers are what would happen if it asked
 * wrongly -- so a guard that stopped working shows up here as a request
 * that should never have been attempted.
 */
function goOffline(): void {
  setOnline(false);
  server.use(
    http.post('*', () => HttpResponse.error()),
    http.patch('*', () => HttpResponse.error()),
    http.delete('*', () => HttpResponse.error()),
  );
}

function comeBack(): void {
  setOnline(true);
  server.resetHandlers();
  window.dispatchEvent(new Event('online'));
}

function posts(): { method: string; path: string; body: unknown }[] {
  return api.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/events'));
}

function patches(): { method: string; path: string; body: unknown }[] {
  return api.requests.filter((entry) => entry.method === 'PATCH');
}

/**
 * Closes the app, as navigating away or reloading would.
 *
 * The sync lane is module state and outlives the component tree, which in
 * a browser never happens: there is only ever one app. Unmounting without
 * clearing it lets the next mount join a task belonging to the tree that
 * was just thrown away -- so the new one's refresh never runs, and it sits
 * on a loading screen or reports a sync that was somebody else's.
 */
function closeApp(): void {
  cleanup();
  resetLanes();
}

/**
 * Somebody else picking up the same phone.
 *
 * The remembered description of the account goes with them. In the app
 * that is what signing in does; these tests put a session straight into
 * storage instead, so they have to do it themselves.
 */
function signedInAs(userId: string): void {
  api.signInAs(userId);
  localStorage.removeItem('dongfan.me');
}

/** Renders already signed in, which is where most of these tests start. */
function openSignedIn(path = '/'): ReturnType<typeof userEvent.setup> {
  localStorage.setItem('dongfan.session', TOKEN);
  return open(path);
}

async function waitForHome(): Promise<void> {
  await screen.findByText(zhTW.home.lastFeed);
}

describe('signing in', () => {
  it('asks for credentials when there is no session', async () => {
    open();
    expect(await screen.findByLabelText(zhTW.auth.username)).toBeInTheDocument();
  });

  it('shows the app once the server accepts them', async () => {
    const user = open();

    await user.type(await screen.findByLabelText(zhTW.auth.username), 'parent');
    await user.type(screen.getByLabelText(zhTW.auth.password), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: zhTW.auth.submit }));

    await waitForHome();
    expect(screen.getByText(BABY.nickname)).toBeInTheDocument();
  });

  it('says the sign-in failed without saying which half was wrong', async () => {
    api.loginFails = true;
    const user = open();

    await user.type(await screen.findByLabelText(zhTW.auth.username), 'parent');
    await user.type(screen.getByLabelText(zhTW.auth.password), 'wrong');
    await user.click(screen.getByRole('button', { name: zhTW.auth.submit }));

    expect(await screen.findByText(zhTW.error.UNAUTHENTICATED)).toBeInTheDocument();
    expect(screen.queryByText(/UNAUTHENTICATED/)).not.toBeInTheDocument();
  });

  it('drops a session the server no longer recognises', async () => {
    localStorage.setItem('dongfan.session', 'a-revoked-token');
    open();

    // Back to the sign-in form rather than an app that cannot load anything.
    expect(await screen.findByLabelText(zhTW.auth.username)).toBeInTheDocument();
  });
});

describe('an account with no baby yet', () => {
  it('offers the form to make one rather than a dead end', async () => {
    api.startWithNoBaby();
    openSignedIn();

    // On a freshly deployed database the owner is the only person there is,
    // so "ask someone to create one" would leave them stuck.
    expect(await screen.findByText(zhTW.baby.createTitle)).toBeInTheDocument();
    expect(screen.getByLabelText(zhTW.baby.nickname)).toBeInTheDocument();
  });

  it('gets all the way from an empty database to a recorded event', async () => {
    api.startWithNoBaby();
    const user = openSignedIn();

    await user.type(await screen.findByLabelText(zhTW.baby.nickname), USER_CONTENT.nickname);
    await user.click(screen.getByRole('button', { name: zhTW.baby.female }));
    fireEvent.change(screen.getByLabelText(zhTW.baby.birthDate), { target: { value: '2026-03-08' } });
    await user.click(screen.getByTestId('submit'));

    // Straight into the app, with the baby it just made.
    await waitForHome();
    expect(screen.getByText(USER_CONTENT.nickname)).toBeInTheDocument();

    const sent = api.lastRequest('/api/babies')?.body as Record<string, unknown>;
    expect(sent['nickname']).toBe(USER_CONTENT.nickname);
    expect(sent['gender']).toBe('female');
    expect(sent['birthDate']).toBe('2026-03-08');

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));

    await waitForHome();
    expect(api.events).toHaveLength(1);
  });

  it('does not make a second one when the refresh afterwards fails', async () => {
    api.startWithNoBaby();
    const user = openSignedIn();

    await user.type(await screen.findByLabelText(zhTW.baby.nickname), USER_CONTENT.nickname);

    // The baby is created, and then reading the account back fails. The
    // screen must not reopen as though nothing had happened: pressing
    // create again would make a second baby, and nothing merges those.
    server.use(http.get('/api/me', () => HttpResponse.error()));
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByTestId('created-pending-refresh')).toBeInTheDocument();
    expect(screen.getByLabelText(zhTW.baby.nickname)).toBeDisabled();

    server.resetHandlers();
    await user.click(screen.getByTestId('submit'));
    await waitForHome();

    const creations = api.requests.filter(
      (entry) => entry.method === 'POST' && entry.path === '/api/babies',
    );
    expect(creations).toHaveLength(1);
  });

  it('keeps the name it sent when the reply to the creation is lost', async () => {
    api.startWithNoBaby();
    api.loseNextResponse = true;
    const user = openSignedIn();

    const field = await screen.findByLabelText(zhTW.baby.nickname);
    await user.type(field, USER_CONTENT.nickname);
    await user.click(screen.getByTestId('submit'));

    // Created on the server; the reply never arrived. Changing the name
    // now and pressing again would send it under the same id, the server
    // would answer with the name it already has, and the screen would go
    // to the home page as though the change had been saved.
    expect(await screen.findByTestId('outcome-unknown')).toBeInTheDocument();
    expect(field).toBeDisabled();

    await user.click(screen.getByTestId('submit'));
    await waitForHome();

    expect(screen.getByText(USER_CONTENT.nickname)).toBeInTheDocument();

    const creations = api.requests.filter(
      (entry) => entry.method === 'POST' && entry.path === '/api/babies',
    );
    expect(creations).toHaveLength(2);
    for (const attempt of creations) {
      expect((attempt.body as Record<string, unknown>)['nickname']).toBe(USER_CONTENT.nickname);
    }
  });

  it('cannot be edited while the request is still in the air', async () => {
    api.startWithNoBaby();
    api.loseNextResponse = true;
    const release = api.holdNextWrite();
    const user = openSignedIn();

    const field = await screen.findByLabelText(zhTW.baby.nickname);
    await user.type(field, USER_CONTENT.nickname);

    const pressing = user.click(screen.getByTestId('submit'));

    // On a slow connection this window is seconds long. Clearing the name
    // here used to leave it frozen empty when the reply was lost: not what
    // was sent, not what gets resent, and the required-field check then
    // refused the retry -- no way forward and no way back.
    await waitFor(() => expect(field).toBeDisabled());
    release();
    await pressing;

    await screen.findByTestId('outcome-unknown');
    await user.click(screen.getByTestId('submit'));
    await waitForHome();

    expect(screen.getByText(USER_CONTENT.nickname)).toBeInTheDocument();
    const creations = api.requests.filter(
      (entry) => entry.method === 'POST' && entry.path === '/api/babies',
    );
    for (const attempt of creations) {
      expect((attempt.body as Record<string, unknown>)['nickname']).toBe(USER_CONTENT.nickname);
    }
  });

  it('keeps the doubt when the retry only says the account lost access', async () => {
    api.startWithNoBaby();
    api.loseNextResponse = true;
    const user = openSignedIn();

    await user.type(await screen.findByLabelText(zhTW.baby.nickname), USER_CONTENT.nickname);
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // Being refused afterwards says nothing about whether the first
    // attempt landed (spec 6.1).
    api.nextFailure = { status: 404, code: 'NOT_FOUND' };
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByTestId('outcome-unknown')).toBeInTheDocument();
    expect(screen.getByLabelText(zhTW.baby.nickname)).toBeDisabled();
  });

  it('lets the parent edit again once the server says it refused', async () => {
    api.startWithNoBaby();
    api.loseNextResponse = true;
    const user = openSignedIn();

    await user.type(await screen.findByLabelText(zhTW.baby.nickname), USER_CONTENT.nickname);
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // A validation failure comes after the id read-back, so reaching one
    // means the server looked and found nothing (spec 5.8).
    api.nextFailure = { status: 422, code: 'VALIDATION_FAILED' };
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument());
    expect(screen.getByLabelText(zhTW.baby.nickname)).not.toBeDisabled();
  });

  it('sends the same id if the creation itself has to be retried', async () => {
    api.startWithNoBaby();
    const user = openSignedIn();

    await user.type(await screen.findByLabelText(zhTW.baby.nickname), USER_CONTENT.nickname);

    api.nextFailure = { status: 500, code: 'INTERNAL' };
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('form-error');

    await user.click(screen.getByTestId('submit'));
    await waitForHome();

    // The server deduplicates on it, so a lost response cannot turn into
    // two babies (spec 5.8).
    const creations = api.requests.filter(
      (entry) => entry.method === 'POST' && entry.path === '/api/babies',
    );
    expect(creations).toHaveLength(2);
    const ids = new Set(creations.map((entry) => (entry.body as Record<string, unknown>)['id']));
    expect(ids.size).toBe(1);
  });

  it('works on a device that refuses to store anything', async () => {
    api.startWithNoBaby();
    breakStorage();

    // No stored session, so this one signs in by hand and the token lives
    // only in memory. Reading it back from storage would find nothing, and
    // the refresh after creating would never happen (spec 9.6).
    const user = open();
    await user.type(await screen.findByLabelText(zhTW.auth.username), 'parent');
    await user.type(screen.getByLabelText(zhTW.auth.password), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: zhTW.auth.submit }));

    await user.type(await screen.findByLabelText(zhTW.baby.nickname), USER_CONTENT.nickname);
    await user.click(screen.getByTestId('submit'));

    await waitForHome();
    expect(screen.getByText(USER_CONTENT.nickname)).toBeInTheDocument();
  });

  it('will not create one without a name', async () => {
    api.startWithNoBaby();
    const user = openSignedIn();

    await user.click(await screen.findByTestId('submit'));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.fieldError.REQUIRED);
    expect(api.lastRequest('/api/babies')).toBeUndefined();
  });

  it('will not create one born on a day that does not exist', async () => {
    api.startWithNoBaby();
    const user = openSignedIn();

    await user.type(await screen.findByLabelText(zhTW.baby.nickname), USER_CONTENT.nickname);
    fireEvent.change(screen.getByLabelText(zhTW.baby.birthDate), { target: { value: '2026-02-31' } });
    await user.click(screen.getByTestId('submit'));

    // The date control hands over days that do not exist, and a round trip
    // is a poor way to be told so.
    expect(await screen.findByTestId('form-error')).toBeInTheDocument();
    expect(api.lastRequest('/api/babies')).toBeUndefined();
  });
});

describe('the home screen', () => {
  it('shows the figures the server sent, not ones worked out locally', async () => {
    api.add({ typeId: 'bottle', value: 140, startedAt: earlierToday(2 * HOUR) });
    api.add({ typeId: 'bottle', value: 120, startedAt: earlierToday(HOUR) });
    api.add({ typeId: 'diaper', metadata: { diaper_kind: 'both' } });

    openSignedIn();
    await waitForHome();

    // Waited for: the screen appears as soon as there is anything to show,
    // and the figures arrive when the pull finishes.
    await waitFor(() => expect(screen.getByText('260')).toBeInTheDocument());
    const breakdown = screen.getByTestId('diaper-breakdown').textContent ?? '';
    expect(breakdown).toMatch(/1/);
  });

  it('shows a parent’s own words unchanged', async () => {
    api.add({ typeId: 'solid_food', metadata: { food_name: USER_CONTENT.foodName } });

    openSignedIn();
    await waitForHome();

    expect(screen.getByText(new RegExp(USER_CONTENT.foodName))).toBeInTheDocument();
  });

  it('offers a retry when the first load never arrives', async () => {
    server.use(http.get('/api/babies/:babyId/events/summary', () => HttpResponse.error()));
    const user = openSignedIn();

    // An empty home screen would read as "nothing has been recorded today",
    // which is a different and much worse thing to tell a parent.
    expect(await screen.findByText(zhTW.home.syncFailed)).toBeInTheDocument();

    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: zhTW.error.retry }));
    await waitForHome();
  });

  it('marks itself out of date when a later refresh fails', async () => {
    const user = openSignedIn();
    await waitForHome();

    server.use(http.get('/api/babies/:babyId/events', () => HttpResponse.error()));

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));

    // The write landed; only the refresh after it did not. Saying "synced"
    // here would be a lie about data the other phone may already have.
    //
    // Waited for: a save now takes its turn behind whatever the queue is
    // doing, so it is not necessarily finished by the time the tap is.
    await waitFor(() => expect(api.events).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('sync-state')).toHaveTextContent(zhTW.home.syncFailed),
    );
  });
});

describe('when the API cannot be reached', () => {
  /**
   * Every request fails to arrive.
   *
   * The app itself is already loaded, which is what this covers: the page
   * is open, or is being re-rendered, and the server is unreachable.
   * Whether the HTML and the scripts can be fetched at all with no network
   * is a service worker's job and belongs to the PWA stage.
   */
  function goOffline(): void {
    server.use(
      http.get('*', () => HttpResponse.error()),
      http.post('*', () => HttpResponse.error()),
      http.patch('*', () => HttpResponse.error()),
      http.delete('*', () => HttpResponse.error()),
    );
  }

  it('renders what was pulled before, without asking again', async () => {
    api.add({ typeId: 'bottle', value: 140, startedAt: earlierToday(2 * HOUR) });
    api.add({ typeId: 'diaper', metadata: { diaper_kind: 'pee' } });

    openSignedIn();
    await waitForHome();
    await waitFor(() => expect(screen.getAllByTestId('event-row-bottle')).toHaveLength(1));

    // A fresh start with the network gone: a reload in a tunnel, or the
    // app reopened from the home screen.
    closeApp();
    goOffline();
    openSignedIn();

    // Not the sign-in screen. Only the server saying "not signed in" ends
    // a session; a tunnel does not (spec 9.2).
    await waitForHome();
    await waitFor(() => expect(screen.getAllByTestId('event-row-bottle')).toHaveLength(1));
    expect(screen.getAllByTestId('event-row-bottle')[0]).toHaveTextContent('140');
    expect(screen.getAllByTestId('event-row-diaper')).toHaveLength(1);
  });

  it('says its figures are out of date rather than pretending', async () => {
    api.add({ typeId: 'bottle', value: 140 });
    openSignedIn();
    await waitForHome();

    closeApp();
    goOffline();
    openSignedIn();
    await waitForHome();

    // Waited for rather than read once: the screen shows what is stored
    // before it knows the network is gone, which is the whole point of the
    // order, and "out of date" arrives a moment later.
    await waitFor(() =>
      expect(screen.getByTestId('sync-state')).toHaveTextContent(zhTW.home.syncFailed),
    );
  });

  it('does not wait on a request that never answers', async () => {
    api.add({ typeId: 'bottle', value: 140 });
    openSignedIn();
    await waitForHome();

    // Not a failure: a request that hangs. A phone with one bar does this
    // rather than erroring, and waiting for it held the whole app on a
    // loading screen with the records sitting on the device.
    closeApp();
    server.use(http.get('/api/me', () => new Promise<never>(() => undefined)));
    openSignedIn();

    await waitForHome();
    expect(screen.getAllByTestId('event-row-bottle')).toHaveLength(1);
  });

  it('still signs out when the server says the session is over', async () => {
    openSignedIn();
    await waitForHome();

    closeApp();
    server.use(http.get('/api/me', () => HttpResponse.json(
      { error: { code: 'UNAUTHENTICATED', details: null } },
      { status: 401 },
    )));
    openSignedIn();

    // A revoked session is not an offline one, and keeping the cached
    // account here would leave a signed-out device showing records.
    expect(await screen.findByLabelText(zhTW.auth.username)).toBeInTheDocument();
  });

  it('shows nothing at all once somebody has signed out', async () => {
    api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn();
    await waitForHome();

    // Signing out lives on the settings page now, with the rest of what
    // is about the family rather than about the records (spec 7.8).
    await user.click(screen.getByRole('link', { name: zhTW.a11y.openSettings }));
    await user.click(await screen.findByTestId('sign-out'));
    expect(await screen.findByLabelText(zhTW.auth.username)).toBeInTheDocument();

    // Signing out has to take the remembered account with it, or the next
    // person to open the app without a network is shown the records of the
    // one who signed out.
    closeApp();
    goOffline();
    open();

    expect(await screen.findByLabelText(zhTW.auth.username)).toBeInTheDocument();
  });
});

describe('a write that lands while the pull afterwards does not', () => {
  it('keeps the new event on screen', async () => {
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    // The POST will land; the sync that follows will not.
    server.use(http.get('/api/babies/:babyId/events', () => HttpResponse.error()));
    await user.click(screen.getByTestId('submit'));

    await waitForHome();

    // The screen said it was saved. A record that then disappears from the
    // list because a *different* request failed is the app losing it, as
    // far as anyone using it can tell.
    expect(api.events).toHaveLength(1);
    await waitFor(() => expect(screen.getAllByTestId('event-row-bottle')).toHaveLength(1));
  });

  it('keeps an edit on screen', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByRole('link', {
      name: interpolate(zhTW.event.open, { name: eventTypeName('bottle') }),
    }));

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '160');

    server.use(http.get('/api/babies/:babyId/events', () => HttpResponse.error()));
    await user.click(screen.getByTestId('submit'));

    await waitForHome();
    await waitFor(() =>
      expect(screen.getAllByTestId('event-row-bottle')[0]).toHaveTextContent('160'),
    );
    expect(api.find(event.id)?.value).toBe(160);
  });

  it('hides a deleted event', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    await user.click(await screen.findByRole('button', { name: zhTW.addEvent.delete }));
    server.use(http.get('/api/babies/:babyId/events', () => HttpResponse.error()));
    await user.click(screen.getByRole('button', { name: zhTW.event.deleteConfirmYes }));

    await waitForHome();
    await waitFor(() => expect(screen.queryByTestId('event-row-bottle')).not.toBeInTheDocument());
  });
});

describe('keeping up with the other parent', () => {
  it('pulls again when the app is brought back to the front', async () => {
    openSignedIn();
    await waitForHome();
    const before = api.requests.filter((entry) => entry.path.endsWith('/events')).length;

    // The other parent records a feed while this phone is in a pocket.
    api.add({ typeId: 'bottle', value: 140 });
    fireEvent(document, new Event('visibilitychange'));

    // Without this the only thing that ever syncs is this device's own
    // writing, and the screen sits unchanged with nothing to say so.
    await waitFor(() => {
      const after = api.requests.filter((entry) => entry.path.endsWith('/events')).length;
      expect(after).toBeGreaterThan(before);
    });
    await waitFor(() => expect(screen.getAllByTestId('event-row-bottle')).toHaveLength(1));
  });

  it('pulls again when the connection comes back', async () => {
    openSignedIn();
    await waitForHome();
    const before = api.requests.filter((entry) => entry.path.endsWith('/events')).length;

    fireEvent(window, new Event('online'));

    await waitFor(() => {
      const after = api.requests.filter((entry) => entry.path.endsWith('/events')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('can be told to pull by hand', async () => {
    const user = openSignedIn();
    await waitForHome();

    api.add({ typeId: 'bottle', value: 140 });
    await user.click(screen.getByRole('button', { name: zhTW.a11y.sync }));

    // The automatic pulls cover coming back to the app and coming back
    // online. Neither covers standing there wondering whether the feed has
    // been recorded yet.
    await waitFor(() => expect(screen.getAllByTestId('event-row-bottle')).toHaveLength(1));
  });

  /** Resolves once the app has actually asked the server for changes. */
  async function pullStarted(): Promise<void> {
    await waitFor(() =>
      expect(
        api.requests.some((entry) => entry.method === 'GET' && entry.path.endsWith('/events')),
      ).toBe(true),
    );
  }

  /** How many times the app has asked the server for changes. */
  function pulls(): number {
    return api.requests.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/events'))
      .length;
  }

  it('does not let the first pull overlap with another entrance', async () => {
    const release = api.holdNextSync();
    openSignedIn();

    // Waited for on purpose: the listeners are registered when the store
    // mounts, which is after the account has been fetched. Firing before
    // that lands on nothing and the test proves nothing.
    await pullStarted();

    // The first sync is still in the air. Every other way in asks for one
    // while it is: coming to the front, and coming back online.
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(window, new Event('online'));

    // Long enough for a second request to be issued if anything were going
    // to issue one. Asserting that something did *not* happen needs time
    // for it to have happened; releasing immediately proves nothing,
    // because the first reply comes back before the second request is even
    // assembled.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Still just the one that is being held. Counted at the server,
    // because the one thing a unit test of the queue cannot see is whether
    // every entrance is wired to it -- and calling refresh directly on
    // mount was the entrance that was not.
    expect(pulls()).toBe(1);
    expect(api.maxConcurrentSyncs).toBe(1);

    release();
    await waitForHome();

    // And the ones that were asked for did happen, once released.
    await waitFor(() => expect(pulls()).toBeGreaterThan(1));
    expect(api.maxConcurrentSyncs).toBe(1);
  });

  it('does not drop a request that arrived during the first pull', async () => {
    const release = api.holdNextSync();
    openSignedIn();
    await pullStarted();

    // Recorded by the other parent while this phone was still starting up.
    api.add({ typeId: 'bottle', value: 140 });
    fireEvent(document, new Event('visibilitychange'));

    release();
    await waitForHome();

    // Queued behind the first, not discarded: the pull that was already in
    // the air had asked the server before this existed.
    await waitFor(() => expect(screen.getAllByTestId('event-row-bottle')).toHaveLength(1));
    expect(api.maxConcurrentSyncs).toBe(1);
  });

  it('says when it last succeeded rather than always saying just now', async () => {
    openSignedIn();
    await waitForHome();

    // "Just synced", permanently, is an assurance that is wrong at exactly
    // the moment it matters.
    //
    // Waited for rather than asserted outright: the home screen appears as
    // soon as there is a summary to show, which is a render or two before
    // the pull that produced it has finished. Read at that moment this said
    // "syncing", and the test failed perhaps one run in ten.
    await waitFor(() =>
      expect(screen.getByTestId('sync-state')).toHaveTextContent(zhTW.home.syncedJustNow),
    );

    closeApp();
    server.use(http.get('/api/babies/:babyId/events', () => HttpResponse.error()));
    openSignedIn();
    await waitForHome();

    await waitFor(() =>
      expect(screen.getByTestId('sync-state')).toHaveTextContent(zhTW.home.syncFailed),
    );
  });
});

describe('the quick nappy buttons', () => {
  it('record the moment of the tap, not the moment the page opened', async () => {
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') });

    // A picker left sitting would otherwise file the change early, and
    // across midnight it would land on the wrong day entirely.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const beforeTap = Date.now();
    await user.click(screen.getByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.startedAt).toBeGreaterThanOrEqual(beforeTap);
  });

  it('send one event with the kind that was tapped', async () => {
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));

    await waitForHome();
    const sent = api.lastRequest('/events')?.body as Record<string, unknown>;

    expect(sent['typeId']).toBe('diaper');
    expect(sent['intent']).toBe('record');
    expect(sent['metadata']).toEqual({ diaper_kind: 'poo' });
    // A client-generated UUID, because the id is the idempotency key.
    expect(String(sent['id'])).toMatch(/^[0-9a-f-]{36}$/);
    // The server owns this field; sending one would be ignored anyway, and
    // having it in the body at all invites someone to start trusting it.
    expect(sent).not.toHaveProperty('localDate');
    expect(api.events).toHaveLength(1);
  });
});

describe('the bottle form', () => {
  it('labels the amount in Chinese rather than by its id', async () => {
    openSignedIn('/add/bottle');
    expect(await screen.findByLabelText(valueLabel('bottle'))).toBeInTheDocument();
    expect(screen.queryByText(/\bbottle\b/)).not.toBeInTheDocument();
  });

  it('offers the last amount for confirmation', async () => {
    api.add({ typeId: 'bottle', value: 140 });
    openSignedIn();
    await waitForHome();

    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: `${zhTW.addEvent.title} ${eventTypeName('bottle')}` }));

    expect(await screen.findByDisplayValue('140')).toBeInTheDocument();
  });

  it('sends the amount in stored units', async () => {
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect((api.lastRequest('/events')?.body as Record<string, unknown>)['value']).toBe(150);
  });

  it('cannot be edited while the request is still in the air', async () => {
    api.loseNextResponse = true;
    const release = api.holdNextWrite();
    const user = openSignedIn('/add/bottle');

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.type(amount, '150');

    const pressing = user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(amount).toBeDisabled());
    release();
    await pressing;

    // Frozen at an amount the range check would refuse, the retry would be
    // blocked by a draft that is not what gets sent anyway.
    await screen.findByTestId('outcome-unknown');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument());
    expect(api.events).toHaveLength(1);
    expect(api.events[0]?.value).toBe(150);
  });

  it('refuses an amount outside the range before asking the server', async () => {
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '900');
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByTestId('form-error')).toHaveTextContent('500');
    expect(api.events).toHaveLength(0);
  });

  it('keeps one millilitre, which is an amount and not a placeholder', async () => {
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '1');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.value).toBe(1);
  });

  it('sends a note exactly as it was typed', async () => {
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '100');
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.note).toBe(USER_CONTENT.note);
  });
});

describe('the time picker', () => {
  it('reads and writes wall clock time in the baby timezone', async () => {
    const user = openSignedIn('/add/bottle');

    const field = await screen.findByTestId('started-at');
    // Whatever the device believes the time is, the control shows Taipei.
    expect((field as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    // Set in one go rather than typed: a datetime control is not a complete
    // moment halfway through being typed, and nothing should read one.
    const earlier = toLocalInput(Date.now() - 3 * HOUR, BABY.timezone);
    fireEvent.change(field, { target: { value: earlier } });
    await user.type(screen.getByLabelText(valueLabel('bottle')), '100');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    // Converted back through the baby's timezone, not the device's: those
    // agree only by accident on any given machine (spec 3.4).
    expect(api.events[0]?.startedAt).toBe(fromLocalInput(earlier, BABY.timezone));
  });
});

describe('a temperature', () => {
  it('is sent scaled to an integer, never as a fraction', async () => {
    const user = openSignedIn('/add/temperature');

    await user.type(await screen.findByLabelText(valueLabel('temperature')), '36.5');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.value).toBe(toStored(36.5, { unit: 'C', scale: 10, min: 34, max: 42 }));
  });
});

describe('timers', () => {
  it('start with the intent spelled out', async () => {
    const user = openSignedIn('/add/sleep');

    await user.click(await screen.findByTestId('submit'));
    await waitFor(() => expect(api.events).toHaveLength(1));

    const sent = api.lastRequest('/events')?.body as Record<string, unknown>;
    expect(sent['intent']).toBe('start_timer');
    expect(sent['endedAt']).toBeNull();
    expect(api.events[0]?.active).toBe(true);
  });

  it('are stopped from the home screen with the version the summary gave', async () => {
    const running = api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(HOUR) });
    const versionWhenRead = running.version;

    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));

    await waitFor(() => expect(api.find(running.id)?.active).toBe(false));
    const sent = api.lastRequest(`/events/${running.id}`)?.body as Record<string, unknown>;
    expect(sent['version']).toBe(versionWhenRead);
    expect(typeof sent['endedAt']).toBe('number');
  });

  it('can be stopped even when the type is not a shortcut', async () => {
    // Walk is timer-enabled but not in the strip, so without this it could
    // be started with no way to end it.
    api.add({ typeId: 'walk', active: true, startedAt: earlierToday(HOUR) });

    openSignedIn();
    await waitForHome();

    expect(screen.getAllByRole('button', { name: zhTW.timer.stop })).toHaveLength(1);
  });

  it('report the slot being taken in words, not as a code', async () => {
    api.nextFailure = { status: 409, code: 'ACTIVE_TIMER_EXISTS' };
    const user = openSignedIn('/add/sleep');

    await user.click(await screen.findByTestId('submit'));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.error.ACTIVE_TIMER_EXISTS);
  });
});

describe('an error code this build has never met', () => {
  it('falls back to the generic message rather than showing the code', async () => {
    api.nextFailure = { status: 422, code: 'SOMETHING_ADDED_LATER' };
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '100');
    await user.click(screen.getByTestId('submit'));

    const error = await screen.findByTestId('form-error');
    expect(error).toHaveTextContent(zhTW.error.UNKNOWN);
    expect(error).not.toHaveTextContent('SOMETHING_ADDED_LATER');
  });
});

describe('editing an event', () => {
  it('opens from the list and saves with the version it read', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByRole('link', {
      name: interpolate(zhTW.event.open, { name: eventTypeName('bottle') }),
    }));

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '160');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.find(event.id)?.value).toBe(160));
    expect((api.lastRequest(`/events/${event.id}`)?.body as Record<string, unknown>)['version']).toBe(1);
  });

  it('offers a reload instead of merging when someone else saved first', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '200');

    api.nextFailure = { status: 409, code: 'VERSION_CONFLICT' };
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByRole('dialog')).toHaveTextContent(zhTW.error.VERSION_CONFLICT);
    // Still on the form, and the stored value is untouched.
    expect(api.find(event.id)?.value).toBe(140);
  });

  it('reloads from the server after a conflict, not from the device', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '200');

    // Somebody else got there first, so the version this screen holds is
    // now the old one.
    api.nextFailure = { status: 409, code: 'VERSION_CONFLICT' };
    await user.click(screen.getByTestId('submit'));
    await screen.findByRole('dialog');

    Object.assign(event, { value: 160, version: 2, rev: api.nextRev() });
    await user.click(screen.getByRole('button', { name: zhTW.conflict.reload }));

    // Reading the local copy here would hand back the stale version, send
    // it again, and collect the same 409 for ever (spec 6.3).
    await waitFor(() => expect(screen.getByLabelText(valueLabel('bottle'))).toHaveValue('160'));

    await user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(api.find(event.id)?.version).toBe(3));

    const sent = api.lastRequest(`/events/${event.id}`)?.body as Record<string, unknown>;
    expect(sent['version']).toBe(2);
  });

  it('asks before deleting, then sends the version', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    await user.click(await screen.findByRole('button', { name: zhTW.addEvent.delete }));
    expect(screen.getByText(zhTW.event.deleteConfirm)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: zhTW.event.deleteConfirmYes }));

    await waitFor(() => expect(api.find(event.id)).toBeUndefined());
    expect((api.lastRequest(`/events/${event.id}`)?.body as Record<string, unknown>)['version']).toBe(1);
  });

  it('does not delete on the first tap', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    await user.click(await screen.findByRole('button', { name: zhTW.addEvent.delete }));

    expect(api.find(event.id)).toBeDefined();
  });

  it('stops a running timer by supplying an end time', async () => {
    const running = api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(2 * HOUR) });
    const user = openSignedIn(`/event/${running.id}`);

    const endField = await screen.findByTestId('ended-at');
    fireEvent.change(endField, { target: { value: toLocalInput(Date.now(), BABY.timezone) } });
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.find(running.id)?.active).toBe(false));
    expect(api.find(running.id)?.endedAt).not.toBeNull();
  });
});

describe('touch targets', () => {
  it('keeps every control tappable at arm’s length in the dark', async () => {
    api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(HOUR) });
    openSignedIn();
    await waitForHome();

    for (const button of screen.getAllByRole('button', { name: zhTW.timer.stop })) {
      expect(button.className).toMatch(/min-h-11/);
    }

    const shortcuts = screen.getAllByRole('link', { name: new RegExp(`${zhTW.a11y.addEvent} .+`) });
    expect(shortcuts.length).toBeGreaterThan(0);
    for (const link of shortcuts) expect(link.className).toMatch(/min-h-11/);

    expect(screen.getByRole('link', { name: zhTW.a11y.addEvent }).className).toMatch(/size-15/);
  });
});

describe('looking back at one day', () => {
  /**
   * Days named in calendar space, never as an offset from now.
   *
   * `Date.now() - 3 * DAY` is a different local date for a few minutes
   * every night, and every instant below is anchored to the start of a
   * named day rather than counted backwards from the clock.
   */
  const today = (): string => toLocalDate(Date.now(), BABY.timezone);
  const daysAgo = (days: number): string => addLocalDays(today(), -days);
  const onDay = (date: string, hour: number, minute = 0): number =>
    startOfLocalDay(date, BABY.timezone) + hour * 3_600_000 + minute * 60_000;

  /** Pixels from the top of the axis, as the screen actually placed it. */
  const topOf = (element: HTMLElement): number => Number.parseFloat(element.style.top);

  it('shows the night that ran into the morning, starting at midnight', async () => {
    // Its local_date is the evening before, so a screen asking only for
    // this morning's date would lose seven hours of it (spec 3.4.1). On a
    // timeline it has to start at the top of the day and be seven hours
    // tall, not sit wherever a list would have put it.
    const evening = daysAgo(3);
    const morning = daysAgo(2);
    api.add({
      typeId: 'sleep',
      startedAt: onDay(evening, 23, 10),
      endedAt: onDay(morning, 7, 5),
    });

    openSignedIn(`/day/${morning}`);

    const slot = await screen.findByTestId('slot-sleep');
    expect(topOf(slot)).toBe(0);
    expect(slot).toHaveAccessibleName(new RegExp(zhTW.calendar.carriedOver));
  });

  it('draws the evening end of that same night on the evening', async () => {
    const evening = daysAgo(3);
    api.add({
      typeId: 'sleep',
      startedAt: onDay(evening, 23, 10),
      endedAt: onDay(daysAgo(2), 7, 5),
    });

    openSignedIn(`/day/${evening}`);

    const slot = await screen.findByTestId('slot-sleep');
    // 23:10, and fifty minutes of it, on a 96px hour.
    expect(topOf(slot)).toBeCloseTo((23 * 60 + 10) / 60 * 96, 1);
    expect(slot).toHaveAccessibleName(new RegExp(zhTW.calendar.continues));
  });

  it('positions by the clock and sizes a finished range by its duration', async () => {
    // Spec 7.5's own example: an hour of sleep occupies an hour and a bottle
    // half an hour in sits in the middle of it.
    const day = daysAgo(2);
    api.add({ typeId: 'sleep', startedAt: onDay(day, 9), endedAt: onDay(day, 10) });
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9, 30) });

    openSignedIn(`/day/${day}`);

    const sleep = await screen.findByTestId('slot-sleep');
    const bottle = await screen.findByTestId('slot-bottle');

    expect(topOf(sleep)).toBeCloseTo(9 * 96, 1);
    expect(Number.parseFloat(sleep.style.height)).toBeCloseTo(96, 1);
    // Half an hour later is half an hour down, whatever the card's height.
    expect(topOf(bottle) - topOf(sleep)).toBeCloseTo(48, 1);
  });

  it('draws a range as colour and a moment as none, both starting at their minute', async () => {
    // Two marks on a card and no more: its top edge is the minute it began,
    // and the colour inside it is how long it lasted. A card with no colour
    // in it is a moment (spec 7.5, docs/timeline-design.md).
    const day = daysAgo(2);
    api.add({ typeId: 'sleep', startedAt: onDay(day, 9), endedAt: onDay(day, 10, 30) });
    api.add({ typeId: 'bottle', startedAt: onDay(day, 13) });

    openSignedIn(`/day/${day}`);
    await screen.findByTestId('slot-bottle');

    const sleep = screen.getByTestId('slot-sleep');
    const bottle = screen.getByTestId('slot-bottle');

    // Both cards begin at their own minute, and the range is as tall as it
    // was long.
    expect(topOf(sleep)).toBeCloseTo(9 * 96, 1);
    expect(topOf(bottle)).toBeCloseTo(13 * 96, 1);
    expect(Number.parseFloat(sleep.style.height)).toBeCloseTo(1.5 * 96, 1);

    // The range is tinted; the moment is the plain surface.
    expect(sleep.style.background).toContain('color-mix');
    expect(bottle.style.background).not.toContain('color-mix');
  });

  it('puts a long record\u2019s words at the minute it began', async () => {
    // Centred, the type and start time of a three-hour sleep sat an hour
    // and a half below the line it started on -- which is the one number
    // the card is there to carry.
    //
    // jsdom lays nothing out, so this pins the rule the card asks for and
    // not the picture. The picture is a phone check.
    const day = daysAgo(2);
    api.add({ typeId: 'sleep', startedAt: onDay(day, 20), endedAt: onDay(day, 23) });

    openSignedIn(`/day/${day}`);
    const card = await screen.findByTestId('slot-sleep');

    expect(Number.parseFloat(card.style.height)).toBeCloseTo(3 * 96, 1);
    expect(card.className).toContain('justify-start');
    expect(card.className).not.toContain('justify-center');
  });

  it('keeps an empty afternoon empty rather than closing the gap', async () => {
    // The shape of a day is what the page is for. Six hours apart must be
    // six hours apart, however little is in between.
    const day = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(day, 3) });
    api.add({ typeId: 'diaper', startedAt: onDay(day, 9) });

    openSignedIn(`/day/${day}`);

    const early = await screen.findByTestId('slot-bottle');
    const later = await screen.findByTestId('slot-diaper');
    expect(topOf(later) - topOf(early)).toBeCloseTo(6 * 96, 1);
  });

  it('does not say a record of the day itself was carried over', async () => {
    const day = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9) });

    openSignedIn(`/day/${day}`);

    const slot = await screen.findByTestId('slot-bottle');
    expect(slot.getAttribute('aria-label')).not.toContain(zhTW.calendar.carriedOver);
  });

  it('puts an all-day event above the hours instead of at midnight', async () => {
    // It is stored at local midnight (spec 3.9), so on an hour axis it would
    // sit under the night feeds rather than heading the day.
    const day = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9) });
    api.add({ typeId: 'milestone', startedAt: onDay(day, 0) });

    openSignedIn(`/day/${day}`);
    await screen.findByTestId('slot-bottle');

    const band = screen.getByTestId('all-day');
    expect(band).toContainElement(screen.getByTestId('slot-milestone'));
    expect(band).not.toContainElement(screen.getByTestId('slot-bottle'));
  });

  it('marks the current time on today, and on no other day', async () => {
    api.add({ typeId: 'bottle', startedAt: earlierToday(HOUR) });
    openSignedIn('/day');
    await screen.findByTestId('slot-bottle');
    expect(screen.getByTestId('now-line')).toBeInTheDocument();

    closeApp();
    openSignedIn(`/day/${daysAgo(2)}`);
    await screen.findByTestId('timeline');
    expect(screen.queryByTestId('now-line')).not.toBeInTheDocument();
  });

  it('offers a way into an hour too crowded to lay out side by side', async () => {
    // Six moments inside ten minutes is past what fits beside each other on
    // a phone. Nothing may be silently dropped (spec 7.5), so the ones with
    // no column left are behind an entry and every one of them is in it.
    setViewportWidth(390);
    const day = daysAgo(2);
    for (let i = 0; i < 6; i += 1) {
      api.add({ typeId: 'diaper', startedAt: onDay(day, 9, i * 2) });
    }

    const user = openSignedIn(`/day/${day}`);

    const entry = await screen.findByTestId('crowded');
    // Some of them are still cards; the rest are behind this.
    const behind = Number(/(\d+)/.exec(entry.textContent ?? '')?.[1] ?? '0');
    expect(behind).toBeGreaterThan(1);

    await user.click(entry);
    expect(screen.getAllByTestId('slot-diaper')).toHaveLength(6);
  });

  it('says what is behind a crowded entry without it being opened', async () => {
    // A count on its own is not an answer: three records could be three
    // nappies or a bath, a feed and a mood, over four minutes or over seven
    // hours. The entry names the types it holds and the stretch it covers
    // (docs/timeline-design.md).
    //
    // Six inside one hour at a phone's width. When an hour will not fit,
    // that whole hour becomes one entry -- which is the simplest rule that
    // a parent can see the boundary of on the axis.
    setViewportWidth(390);
    const day = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9), value: 90 });
    api.add({ typeId: 'diaper', startedAt: onDay(day, 9, 2) });
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9, 4), value: 110 });
    api.add({ typeId: 'solid_food', startedAt: onDay(day, 9, 6) });
    api.add({ typeId: 'diaper', startedAt: onDay(day, 9, 8) });
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9, 10), value: 120 });

    openSignedIn(`/day/${day}`);
    const entry = await screen.findByTestId('crowded');

    expect(entry).toHaveTextContent(interpolate(zhTW.calendar.crowded, { count: 6 }));
    // Where the stretch begins, so a ten-minute huddle cannot read like an
    // evening. At a column this narrow the end is given up before the
    // beginning is, rather than half a range being printed with an
    // ellipsis after it.
    expect(entry).toHaveTextContent(formatClock(onDay(day, 9), BABY.timezone));
    // And every type inside it: as badges for the eye, in start order and
    // one per type however many of that type there are...
    expect([...entry.querySelectorAll('[data-testid="chip-type"]')]
      .map((one) => (one as HTMLElement).dataset['type']))
      .toEqual(['bottle', 'diaper', 'solid_food']);
    // ...and named in full for a screen reader.
    for (const typeId of ['bottle', 'diaper', 'solid_food']) {
      expect(entry).toHaveTextContent(eventTypeName(typeId));
    }
  });

  it('says both ends of the stretch where there is room for both', async () => {
    // The same entry on a wider screen. What the width takes away is the
    // end of the range, and nothing else.
    const day = daysAgo(2);
    for (let i = 0; i < 6; i += 1) {
      api.add({ typeId: 'diaper', startedAt: onDay(day, 9, i * 2) });
    }

    openSignedIn(`/day/${day}`);
    const entry = await screen.findByTestId('crowded');

    expect(entry).toHaveTextContent(
      `${formatClock(onDay(day, 9), BABY.timezone)} - ${formatClock(onDay(day, 9, 10), BABY.timezone)}`,
    );
  });

  it('opens one list, not two, when an hour was busy twice', async () => {
    // Two huddles forty minutes apart do not overlap, so they are laid out
    // separately -- but they are one clock hour, and an hour is one entry.
    // Folded separately they became two entries with the same name in the
    // URL, and pressing either opened both, on top of each other.
    setViewportWidth(390);
    const day = daysAgo(2);
    for (let i = 0; i < 5; i += 1) {
      api.add({ typeId: 'diaper', startedAt: onDay(day, 9, i) });
      api.add({ typeId: 'bottle', startedAt: onDay(day, 9, 40 + i), value: 100 });
    }

    const user = openSignedIn(`/day/${day}`);
    const entries = await screen.findAllByTestId('crowded');
    expect(entries).toHaveLength(1);

    await user.click(entries[0] as HTMLElement);
    expect(screen.getAllByTestId('crowded-open')).toHaveLength(1);
  });

  it('never draws a collapsed entry over the record below it', async () => {
    // The entry carries three rows whatever stretch it covers, so five
    // records in five minutes is still 58px on the screen. Colliding
    // against 44px while drawing 58 put ten pixels of it over the next
    // card -- the layout and the screen have to agree on one number.
    setViewportWidth(390);
    const day = daysAgo(2);
    for (let i = 0; i < 5; i += 1) api.add({ typeId: 'diaper', startedAt: onDay(day, 9, 40 + i) });
    api.add({ typeId: 'bottle', startedAt: onDay(day, 10, 10), value: 100 });

    openSignedIn(`/day/${day}`);
    const entry = await screen.findByTestId('crowded');
    const after = screen.getByTestId('slot-bottle');

    const bottom = topOf(entry) + Number.parseFloat(entry.style.height);
    expect(Number.parseFloat(entry.style.height)).toBeGreaterThanOrEqual(58);
    // Either clear of it, or somewhere else across the band -- never on top.
    if (topOf(after) < bottom) expect(after.style.left).not.toBe(entry.style.left);
  });

  it('lists a crowded stretch as rows, with no duration drawn in any of them', async () => {
    // A row in the list stands for a record, not for a stretch of time. A
    // stripe scaled by duration in here would say one of them lasted longer
    // than another because its row happened to be taller (spec 7.5).
    setViewportWidth(390);
    const day = daysAgo(2);
    for (let i = 0; i < 6; i += 1) {
      api.add({ typeId: 'bottle', startedAt: onDay(day, 9, i * 2), value: 100 });
    }

    const user = openSignedIn(`/day/${day}`);
    await user.click(await screen.findByTestId('crowded'));

    const list = await screen.findByTestId('crowded-open');
    // The whole band, not the entry's column: the rows inside are laid out
    // for the width they are given, and an entry's column can be a fifth of
    // it.
    expect(list.style.left).toBe('0px');
    expect(list.style.right).toBe('4px');

    const rows = [...list.querySelectorAll('[data-testid^="slot-"]')] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(1);

    for (const row of rows) {
      expect(row.style.top, row.dataset['testid']).toBe('');
      expect(row.style.height, row.dataset['testid']).toBe('');
      // And no gradient: a row has no time in its height, so nothing in it
      // may be scaled by one.
      expect(row.style.background, row.dataset['testid']).not.toContain('gradient');
    }
  });

  it('never puts a range behind a crowded entry, however narrow the band', async () => {
    // The owner's rule, made structural: only moments merge. A nursing in
    // the middle of a busy hour keeps its own block at any width.
    setViewportWidth(390);
    const day = daysAgo(2);
    api.add({ typeId: 'nursing', startedAt: onDay(day, 9), endedAt: onDay(day, 9, 13) });
    for (let i = 1; i <= 6; i += 1) {
      api.add({ typeId: 'diaper', startedAt: onDay(day, 9, i * 2) });
    }

    const user = openSignedIn(`/two/${day}`);
    const entry = await screen.findByTestId('crowded');

    // The nursing is a card on the axis, not a row in a list.
    expect(screen.getByTestId('slot-nursing').style.top).not.toBe('');
    await user.click(entry);
    expect(screen.getByTestId('slot-nursing').style.top).not.toBe('');
  });

  it('lays three out side by side rather than hiding them', async () => {
    const day = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9) });
    api.add({ typeId: 'diaper', startedAt: onDay(day, 9, 2) });
    api.add({ typeId: 'solid_food', startedAt: onDay(day, 9, 4) });

    openSignedIn(`/day/${day}`);
    await screen.findByTestId('slot-bottle');

    expect(screen.queryByTestId('crowded')).not.toBeInTheDocument();
    // Three columns, none on top of another.
    const lefts = ['slot-bottle', 'slot-diaper', 'slot-solid_food']
      .map((id) => screen.getByTestId(id).style.left);
    expect(new Set(lefts).size).toBe(3);
  });

  it('shows a record still on this phone once, and in its own place', async () => {
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    await screen.findByTestId('unsynced-count');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.calendar }));

    const slot = await screen.findByTestId('slot-diaper');
    expect(slot.dataset['kind']).toBe('queued');
    expect(slot).toHaveAccessibleName(new RegExp(zhTW.unsynced.badge));

    // And one of it, not two, once the queue has emptied (spec 6.2).
    comeBack();
    await waitFor(() => expect(screen.getAllByTestId('slot-diaper')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('slot-diaper').dataset['kind']).toBe('event'));
  });

  it('draws a timer stopped here as ended and awaiting confirmation', async () => {
    // Not as a timer still running: a parent who cannot tell those apart
    // either stops it twice or leaves it going all night (spec 7.2).
    const started = earlierToday(2 * HOUR);
    api.add({ typeId: 'sleep', startedAt: started, active: true });

    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(await screen.findByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('stop-drafts');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.calendar }));

    const slot = await screen.findByTestId('slot-sleep');
    expect(slot.dataset['kind']).toBe('draft');
    expect(slot.getAttribute('aria-label')).not.toContain(zhTW.event.inProgress);
    // And it leads to the confirmation screen rather than the edit form.
    expect(slot.getAttribute('href')).toContain('/stop/');

    // The moment the button was pressed, printed. The event the server knows
    // about is a running timer with no end, and formatting that null as a
    // clock said 08:00 -- the epoch, in Taipei.
    expect(slot).toHaveAccessibleName(new RegExp(
      interpolate(zhTW.calendar.draftEndedAt, { time: formatClock(Date.now(), BABY.timezone) })
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
  });

  it('does not put a card past the right-hand edge of the day', async () => {
    // The hour labels take a strip off the left. Adding it to each card's
    // offset while the widths still divided the whole container put a
    // single column 40px past the edge, and the last of any row with it.
    //
    // The strip now belongs to the band a day's cards live in, and the
    // cards divide the band. So the band carries the offset, and a card's
    // own geometry is percentages that stay inside it.
    const day = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9) });
    api.add({ typeId: 'diaper', startedAt: onDay(day, 9, 2) });

    openSignedIn(`/day/${day}`);
    const first = await screen.findByTestId('slot-bottle');

    expect((first.parentElement as HTMLElement).style.left).toBe('44px');

    for (const id of ['slot-bottle', 'slot-diaper']) {
      const { left, width } = screen.getByTestId(id).style;
      // `calc(50% + 11px)` beside `calc(50% - 15px)`. The percentages are
      // the band divided; the pixels the anchor's lane and the gap take are
      // *subtracted from the width*, never added to the offset alone --
      // which is the arithmetic that put a card past the edge before.
      // `50%` beside `calc(50% - 4px)`. The percentages are the band
      // divided; the only pixels in it are the gap, taken out of the width
      // rather than added to the offset -- which is the arithmetic that put
      // a card past the edge before.
      expect(left, id).toMatch(/^\d+(\.\d+)?%$/);
      const across = /^calc\(([\d.]+)% - ([\d.]+)px\)$/.exec(width);
      expect(across, `${id} width: ${width}`).not.toBeNull();

      const span = Number.parseFloat(left) + Number.parseFloat(across?.[1] ?? '0');
      expect(span, id).toBeLessThanOrEqual(100);
    }
  });

  it('positions the day it switched to, not the one it came from', async () => {
    // The read is asynchronous, so for a moment after the date changes the
    // previous day's rows are still in hand. Laying those out under the new
    // date, scrolling against them and marking the date as done meant the
    // right rows arrived to a page that had stopped listening.
    const early = daysAgo(6);
    const late = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(late, 23) });
    api.add({ typeId: 'diaper', startedAt: onDay(early, 7) });

    openSignedIn(`/day/${late}`);
    await screen.findByTestId('slot-bottle');
    const scroller = screen.getByTestId('day-scroller');
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(1000));

    fireEvent.change(screen.getByTestId('calendar-date'), { target: { value: early } });

    await screen.findByTestId('slot-diaper');
    // 07:00 on a 96px hour, less the 80px of context above it.
    await waitFor(() => expect(scroller.scrollTop).toBeCloseTo(7 * 96 - 80, 0));
  });

  it('shows the morning of a night stopped with no signal', async () => {
    // The server still has the timer running, so its `endedAt` is null and
    // the plain rule leaves the night on the evening alone. The moment the
    // button was pressed is only on this device, and the morning it covers
    // is the one somebody is looking at (spec 7.2).
    const started = earlierToday(2 * HOUR);
    api.add({ typeId: 'sleep', startedAt: started, active: true });

    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(await screen.findByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('stop-drafts');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.calendar }));

    const slot = await screen.findByTestId('slot-sleep');
    expect(slot.dataset['kind']).toBe('draft');
    expect(slot.getAttribute('href')).toContain('/stop/');
  });

  it('goes back to the top of a day with nothing on the hours', async () => {
    // Only a milestone, which lives in the band above the axis. Leaving the
    // scroll where the previous day left it kept the page at the bottom with
    // the day's one record out of sight.
    const late = daysAgo(2);
    const quiet = daysAgo(6);
    api.add({ typeId: 'bottle', startedAt: onDay(late, 23) });
    api.add({ typeId: 'milestone', startedAt: onDay(quiet, 0) });

    openSignedIn(`/day/${late}`);
    await screen.findByTestId('slot-bottle');
    const scroller = screen.getByTestId('day-scroller');
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(1000));

    fireEvent.change(screen.getByTestId('calendar-date'), { target: { value: quiet } });

    await screen.findByTestId('all-day');
    await waitFor(() => expect(scroller.scrollTop).toBe(0));
  });

  it('goes back to the top of an entirely empty day', async () => {
    const late = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(late, 23) });

    openSignedIn(`/day/${late}`);
    await screen.findByTestId('slot-bottle');
    const scroller = screen.getByTestId('day-scroller');
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(1000));

    fireEvent.change(screen.getByTestId('calendar-date'), { target: { value: daysAgo(6) } });

    await screen.findByText(zhTW.calendar.empty);
    await waitFor(() => expect(scroller.scrollTop).toBe(0));
  });

  it('comes back to where the day was left, not to where it opens', async () => {
    // A record in the morning and a crowded stretch at night. Opening the
    // stretch, tapping in and coming back had the list still open and the
    // page back at the morning, with it somewhere off the screen.
    setViewportWidth(390);
    const day = daysAgo(2);
    api.add({ typeId: 'diaper', startedAt: onDay(day, 7) });
    for (let i = 0; i < 6; i += 1) {
      api.add({ typeId: 'bottle', startedAt: onDay(day, 21, i * 2), value: 100 + i });
    }

    const user = openSignedIn(`/day/${day}`);
    await screen.findByTestId('crowded');

    // Opens on the first record of the day, in the morning.
    const scroller = screen.getByTestId('day-scroller');
    await waitFor(() => expect(scroller.scrollTop).toBeCloseTo(7 * 96 - 80, 0));

    // Somebody scrolls down to the evening and opens the stretch.
    fireEvent.scroll(scroller, { target: { scrollTop: 21 * 96 } });
    await user.click(screen.getByTestId('crowded'));

    await user.click(screen.getAllByTestId('slot-bottle')[0] as HTMLElement);
    await screen.findByTestId('submit');
    await user.click(screen.getByLabelText(zhTW.addEvent.cancel));

    await screen.findByTestId('crowded-open');
    expect(screen.getByTestId('day-scroller').scrollTop).toBe(21 * 96);
  });

  it('takes a queued record back to the day it was opened from', async () => {
    // Every card on the timeline behaves the same way, whatever state it is
    // in. A record still on this phone went to the unsynced list and then
    // home, while the one beside it came back to the day.
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    await screen.findByTestId('unsynced-count');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.calendar }));
    await user.click(await screen.findByTestId('slot-diaper'));

    await screen.findByText(zhTW.unsynced.title);
    await user.click(screen.getByLabelText(zhTW.a11y.back));

    expect(await screen.findByTestId('calendar-date')).toBeInTheDocument();
  });

  it('takes a stop draft back to the day it was opened from', async () => {
    const started = earlierToday(2 * HOUR);
    api.add({ typeId: 'sleep', startedAt: started, active: true });

    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(await screen.findByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('stop-drafts');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.calendar }));
    await user.click(await screen.findByTestId('slot-sleep'));

    await screen.findByText(zhTW.stopDraft.title);
    await user.click(screen.getByLabelText(zhTW.a11y.back));

    expect(await screen.findByTestId('calendar-date')).toBeInTheDocument();
  });

  describe('correcting a record opened from the day it is on', () => {
    /** Offline, one queued nappy, on the calendar, into the correction. */
    async function intoTheCorrection(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = openSignedIn();
      await waitForHome();

      goOffline();
      await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
      await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
      await screen.findByTestId('unsynced-count');

      await user.click(screen.getByTestId('open-menu'));
      await user.click(screen.getByRole('link', { name: zhTW.nav.calendar }));
      await user.click(await screen.findByTestId('slot-diaper'));

      await screen.findByText(zhTW.unsynced.title);
      await user.click(await screen.findByTestId('unsynced-correct'));
      await screen.findByTestId('submit');
      return user;
    }

    it('comes back to the day when the correction is given up on', async () => {
      // And not to the type picker: there is no type to choose again.
      const user = await intoTheCorrection();

      await user.click(screen.getByLabelText(zhTW.addEvent.cancel));

      expect(await screen.findByTestId('calendar-date')).toBeInTheDocument();
    });

    it('comes back to the day once the correction has been made', async () => {
      // Dealing with the record is the thing somebody opened the list to
      // do, so it is the worst moment to be put back on the home screen.
      const user = await intoTheCorrection();

      await user.type(screen.getByLabelText(zhTW.addEvent.note), 'again');
      await user.click(screen.getByTestId('submit'));

      expect(await screen.findByTestId('calendar-date')).toBeInTheDocument();
    });

    it('still knows the day after the queue sends the original first', async () => {
      // The correction becomes an edit, because the server already holds
      // the record (spec 6.1, 6.3) -- and that screen has to know where all
      // of this started too.
      const user = await intoTheCorrection();

      comeBack();
      await waitFor(() => expect(api.events).toHaveLength(1));

      await user.type(screen.getByLabelText(zhTW.addEvent.note), 'again');
      await user.click(screen.getByTestId('submit'));

      await screen.findByText(zhTW.event.edit);
      await user.click(screen.getByLabelText(zhTW.addEvent.cancel));

      expect(await screen.findByTestId('calendar-date')).toBeInTheDocument();
    });

    it('still goes to the home screen when the list was opened from there', async () => {
      // Nothing said otherwise, so nothing is invented.
      const user = openSignedIn();
      await waitForHome();

      goOffline();
      await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
      await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));

      await user.click(await screen.findByTestId('unsynced-count'));
      await user.click(await screen.findByTestId('unsynced-correct'));
      await screen.findByTestId('submit');

      await user.click(screen.getByLabelText(zhTW.addEvent.cancel));

      await waitForHome();
      expect(screen.queryByTestId('calendar-date')).not.toBeInTheDocument();
    });
  });

  it('keeps a crowded stretch open after going into one of its records', async () => {
    setViewportWidth(390);
    // Opening the list, tapping in and coming back collapsed it again,
    // because the state lived in a component the navigation unmounted.
    const day = daysAgo(2);
    for (let i = 0; i < 6; i += 1) {
      api.add({ typeId: 'bottle', startedAt: onDay(day, 9, i * 2), value: 100 + i });
    }

    const user = openSignedIn(`/day/${day}`);
    await user.click(await screen.findByTestId('crowded'));
    const inList = within(screen.getByTestId('crowded-open'));
    await user.click(inList.getAllByTestId('slot-bottle')[0] as HTMLElement);
    await screen.findByTestId('submit');

    await user.click(screen.getByLabelText(zhTW.addEvent.cancel));

    // Back on the day, with the list still open rather than collapsed, and
    // all six still on the screen between the list and the axis.
    expect(await screen.findByTestId('crowded-open')).toBeInTheDocument();
    expect(screen.getAllByTestId('slot-bottle')).toHaveLength(6);
  });

  it('says so rather than looking like a day that failed to load', async () => {
    openSignedIn(`/day/${daysAgo(5)}`);
    expect(await screen.findByText(zhTW.calendar.empty)).toBeInTheDocument();
  });

  it('comes back to today, and to a today that is still moving', async () => {
    const user = openSignedIn(`/day/${daysAgo(3)}`);

    await user.click(await screen.findByTestId('back-to-today'));

    // `/day` rather than today's date: a phone left on a bedside table has
    // to still be showing today after midnight.
    expect(await screen.findByTestId('calendar-date')).toHaveValue(today());
    expect(screen.queryByTestId('back-to-today')).not.toBeInTheDocument();
  });

  it('can be told to pull by hand, like the home screen', async () => {
    // Spec 6.1 asks for this on both screens. Sitting on last Tuesday
    // while the other parent adds something to it is exactly what the
    // automatic pulls do not cover.
    const day = daysAgo(2);
    const user = openSignedIn(`/day/${day}`);
    await screen.findByText(zhTW.calendar.empty);

    api.add({ typeId: 'bottle', startedAt: onDay(day, 9) });
    await user.click(screen.getByRole('button', { name: zhTW.a11y.sync }));

    await waitFor(() => expect(screen.getAllByTestId('slot-bottle')).toHaveLength(1));
  });

  it('says its figures are out of date here too, rather than pretending', async () => {
    const user = openSignedIn(`/day/${daysAgo(2)}`);
    await screen.findByTestId('sync-state');

    server.use(http.get('*/events', () => HttpResponse.error()));
    await user.click(screen.getByRole('button', { name: zhTW.a11y.sync }));

    await waitFor(() => expect(screen.getByTestId('sync-state')).toHaveTextContent(zhTW.home.syncFailed));
  });

  it('is reachable at all', async () => {
    // The menu button had no handler until this screen existed, so there
    // was no way in (spec 7.10).
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.calendar }));

    expect(await screen.findByTestId('calendar-date')).toHaveValue(today());
  });
});

describe('two days at once', () => {
  const today = (): string => toLocalDate(Date.now(), BABY.timezone);
  const daysAgo = (days: number): string => addLocalDays(today(), -days);
  const onDay = (date: string, hour: number, minute = 0): number =>
    startOfLocalDay(date, BABY.timezone) + hour * 3_600_000 + minute * 60_000;
  const topOf = (element: HTMLElement): number => Number.parseFloat(element.style.top);

  it('shows the chosen day and the one before it, oldest on the left', async () => {
    // Spec 7.6: the columns read by date, so a night begins on the left and
    // ends on the right.
    const later = daysAgo(2);
    const earlier = daysAgo(3);

    openSignedIn(`/two/${later}`);

    expect(await screen.findByTestId('column-earlier')).toHaveTextContent(earlier);
    expect(screen.getByTestId('column-later')).toHaveTextContent(later);
  });

  it('draws both days on one set of hours, at the same scale', async () => {
    // The whole point of showing two. Two columns on two scales would be two
    // charts side by side rather than a comparison.
    const later = daysAgo(2);
    const earlier = daysAgo(3);
    api.add({ typeId: 'bottle', startedAt: onDay(earlier, 9) });
    api.add({ typeId: 'diaper', startedAt: onDay(later, 9) });

    openSignedIn(`/two/${later}`);
    await screen.findByTestId('slot-bottle');

    // One axis: the hour labels are not drawn twice.
    expect(screen.getAllByText('09:00')).toHaveLength(1);
    // And 09:00 is 09:00 in both columns.
    expect(topOf(screen.getByTestId('slot-bottle')))
      .toBe(topOf(screen.getByTestId('slot-diaper')));
  });

  it('puts the two days in their own columns, side by side', async () => {
    const later = daysAgo(2);
    const earlier = daysAgo(3);
    api.add({ typeId: 'bottle', startedAt: onDay(earlier, 9) });
    api.add({ typeId: 'diaper', startedAt: onDay(later, 9) });

    openSignedIn(`/two/${later}`);
    await screen.findByTestId('slot-bottle');

    const leftBand = (screen.getByTestId('slot-bottle').parentElement as HTMLElement).style;
    const rightBand = (screen.getByTestId('slot-diaper').parentElement as HTMLElement).style;

    expect(leftBand.left).toBe('44px');
    expect(rightBand.left).toContain('44px');
    expect(rightBand.left).not.toBe('44px');
    expect(leftBand.width).toBe(rightBand.width);
  });

  it('lays out for the box it is drawn in, not for the window', async () => {
    // The shell is capped at `max-w-md`, so on anything wider the window is
    // not the container. Believing it was, a 1024px window had the two-day
    // layout give each column 490px when it had about 202 -- and the
    // reserve, the column count and which words to drop were all decided
    // on that number.
    setViewportWidth(1024);
    setMeasuredWidth(448);
    const later = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(later, 9), value: 120 });
    api.add({ typeId: 'diaper', startedAt: onDay(later, 9, 4) });

    openSignedIn(`/two/${later}`);
    await screen.findByTestId('slot-bottle');

    // (448 - 44) / 2 = 202 a column, halved between the two cards: 97px,
    // which is what the card says it has. Off the window it would be 241.
    expect(screen.getByTestId('slot-bottle').dataset['tier']).toBe('B');
  });

  it('narrows a card rather than collapsing it, at half a phone', async () => {
    // Half of 390px, less the hour labels, is 173px a column, and two cards
    // in that is 86px each. That used to be past what the screen would draw,
    // so the pair became an "N records" button; now the cards drop a tier --
    // the badge and the value stay, the name goes (docs/timeline-design.md).
    setViewportWidth(390);
    const later = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(later, 9), value: 120 });
    api.add({ typeId: 'diaper', startedAt: onDay(later, 9, 4) });

    openSignedIn(`/two/${later}`);
    await screen.findByTestId('slot-bottle');

    expect(screen.getByTestId('slot-diaper')).toBeInTheDocument();
    expect(screen.queryByTestId('crowded')).not.toBeInTheDocument();
    expect(screen.getByTestId('slot-bottle').dataset['tier']).toBe('C');
  });

  it('lays those same two side by side on a single day, which has the width', async () => {
    // The control. Same phone, same two records, and the answer differs
    // because the room does -- which is the whole of what the width is for.
    setViewportWidth(390);
    const day = daysAgo(2);
    api.add({ typeId: 'bottle', startedAt: onDay(day, 9) });
    api.add({ typeId: 'diaper', startedAt: onDay(day, 9, 4) });

    openSignedIn(`/day/${day}`);
    await screen.findByTestId('slot-bottle');

    expect(screen.getByTestId('slot-diaper')).toBeInTheDocument();
    expect(screen.queryByTestId('crowded')).not.toBeInTheDocument();
  });

  it('draws each half of a night in the column its day owns', async () => {
    // 23:00 to 07:00 across the pair: the evening ends the left column and
    // the morning begins the right one, and both open the same record.
    const later = daysAgo(2);
    const earlier = daysAgo(3);
    api.add({ typeId: 'sleep', startedAt: onDay(earlier, 23), endedAt: onDay(later, 7) });

    openSignedIn(`/two/${later}`);

    const halves = await screen.findAllByTestId('slot-sleep');
    expect(halves).toHaveLength(2);

    const [evening, morning] = halves.map((half) => ({
      top: topOf(half),
      href: half.getAttribute('href') ?? '',
    }));
    expect(evening?.top).toBeCloseTo(23 * 96, 1);
    expect(morning?.top).toBe(0);
    // The same event from either side.
    expect(evening?.href.split('?')[0]).toBe(morning?.href.split('?')[0]);
  });

  it('gives each column its own all-day band', async () => {
    const later = daysAgo(2);
    api.add({ typeId: 'milestone', startedAt: onDay(later, 0) });

    openSignedIn(`/two/${later}`);
    await screen.findByTestId('slot-milestone');

    // Two bands, and the record is in the one belonging to its day.
    const bands = screen.getAllByTestId('all-day');
    expect(bands).toHaveLength(2);
    expect(bands[1]).toContainElement(screen.getByTestId('slot-milestone'));
    expect(bands[0]).not.toContainElement(screen.getByTestId('slot-milestone'));
  });

  it('marks the current time on today only, and in today’s column', async () => {
    api.add({ typeId: 'bottle', startedAt: earlierToday(HOUR) });

    openSignedIn('/two');
    await screen.findByTestId('slot-bottle');
    expect(screen.getAllByTestId('now-line')).toHaveLength(1);

    closeApp();
    openSignedIn(`/two/${daysAgo(2)}`);
    await screen.findByTestId('timeline');
    expect(screen.queryByTestId('now-line')).not.toBeInTheDocument();
  });

  it('opens on today and yesterday, and comes back to them', async () => {
    const user = openSignedIn(`/two/${daysAgo(4)}`);
    await user.click(await screen.findByTestId('back-to-today'));

    expect(await screen.findByTestId('column-later')).toHaveTextContent(today());
    expect(screen.getByTestId('column-earlier')).toHaveTextContent(daysAgo(1));
  });

  it('is reachable from the page list, which says where you are', async () => {
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByTestId('open-menu'));
    expect(screen.getByRole('link', { name: new RegExp(zhTW.nav.home) }))
      .toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('link', { name: zhTW.nav.twoDays }));
    expect(await screen.findByTestId('column-later')).toBeInTheDocument();

    await user.click(screen.getByTestId('open-menu'));
    expect(screen.getByRole('link', { name: new RegExp(zhTW.nav.twoDays) }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('comes back to the two days after a shortcut add, still where it was', async () => {
    setViewportWidth(390);
    // The nappy shortcut is the fastest path in the app and the easiest one
    // to drop somebody out of the screen they were on. The day is not the
    // whole of "where they were": a stretch they had opened is part of it,
    // and it rides along in the same query string.
    const later = daysAgo(2);
    for (let i = 0; i < 4; i += 1) {
      api.add({ typeId: 'bottle', startedAt: onDay(later, 21, i), value: 100 + i });
    }

    const user = openSignedIn(`/two/${later}`);
    await user.click(await screen.findByTestId('crowded'));
    await screen.findByTestId('crowded-open');

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));

    expect(await screen.findByTestId('column-later')).toHaveTextContent(later);
    expect(screen.getByTestId('column-earlier')).toHaveTextContent(daysAgo(3));
    // Awaited, not read: the header is on screen before the day's rows have
    // been read back out of IndexedDB, and a stretch cannot be open before
    // there is a stretch.
    expect(await screen.findByTestId('crowded-open')).toBeInTheDocument();
  });

  it('comes back to the two days when a shortcut turns into an edit', async () => {
    setViewportWidth(390);
    // The awkward one. The shortcut screen only takes over an entry that is
    // in doubt or has failed, so reaching this needs a nappy whose answer
    // was lost, and then the queue getting through while that screen is
    // open. Pressing a kind then cannot post a creation -- the server holds
    // the record -- so it becomes an edit (spec 6.1, 6.3), and that screen
    // has to know where this started too.
    const later = daysAgo(2);
    for (let i = 0; i < 4; i += 1) {
      api.add({ typeId: 'bottle', startedAt: onDay(later, 21, i), value: 100 + i });
    }

    const user = openSignedIn(`/two/${later}`);
    await user.click(await screen.findByTestId('crowded'));
    await screen.findByTestId('crowded-open');

    // Stored, and the reply never arrives.
    api.loseNextResponse = true;
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    const nappies = (): unknown[] => api.events.filter((event) => event.typeId === 'diaper');
    await waitFor(() => expect(nappies()).toHaveLength(1));
    // A lost answer keeps the parent on this screen, saying so, because it
    // is the one thing they can act on (spec 6.1).
    await screen.findByTestId('outcome-unknown');

    // The queue waits five seconds before trying again, so the clock is
    // moved past that rather than the test waiting for it.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    try {
      comeBack();
      // The resend is answered with the record the server already had, so
      // the entry leaves the queue without adding anything -- and the doubt
      // on this screen goes with it. Waited for on that, which is a thing
      // this screen actually shows: `unsynced-count` belongs to the home
      // screen, so waiting for its absence here proves nothing at all.
      await waitFor(() => expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));

      await screen.findByText(zhTW.event.edit);
      await user.click(screen.getByLabelText(zhTW.addEvent.cancel));
    } finally {
      clock.mockRestore();
    }

    expect(await screen.findByTestId('column-later')).toHaveTextContent(later);
    // The stretch that was open before any of this is open again: the day
    // is not the whole of where somebody was.
    // Awaited, not read: the header is on screen before the day's rows have
    // been read back out of IndexedDB, and a stretch cannot be open before
    // there is a stretch.
    expect(await screen.findByTestId('crowded-open')).toBeInTheDocument();
    // And the resend added nothing: the server answered with the record it
    // already had (spec 5.8).
    expect(nappies()).toHaveLength(1);
  });

  it('comes back to the two days after the form is saved', async () => {
    const later = daysAgo(2);
    const user = openSignedIn(`/two/${later}`);

    await user.click(await screen.findByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('link', { name: eventTypeName('bottle') }));
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByTestId('column-later')).toHaveTextContent(later);
  });

  it('comes back to the two days when the add is given up on', async () => {
    const later = daysAgo(2);
    const user = openSignedIn(`/two/${later}`);

    await user.click(await screen.findByRole('link', { name: zhTW.a11y.addEvent }));
    await screen.findByTestId('adding-on');
    await user.click(screen.getByLabelText(zhTW.addEvent.cancel));

    expect(await screen.findByTestId('column-later')).toHaveTextContent(later);
  });

  it('keeps the single-day screen and the home screen as they were', async () => {
    // Nothing said otherwise on those, so nothing changes for them.
    const day = daysAgo(2);
    const user = openSignedIn(`/day/${day}`);

    await user.click(await screen.findByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));

    expect(await screen.findByTestId('calendar-date')).toHaveValue(day);
    expect(screen.queryByTestId('column-later')).not.toBeInTheDocument();

    closeApp();
    const again = openSignedIn();
    await waitForHome();
    await again.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await again.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));

    await waitForHome();
    expect(screen.queryByTestId('calendar-date')).not.toBeInTheDocument();
  });

  it('opens one day’s crowded stretch without opening the other’s', async () => {
    setViewportWidth(390);
    // Both columns have a 09:00. Keyed on the minute alone, pressing one
    // opened both and closing either closed both. It is keyed on the day
    // and the hour now, which is stable across both of those.
    const later = daysAgo(2);
    const earlier = daysAgo(3);
    for (const [day, type] of [[earlier, 'bottle'], [later, 'diaper']] as const) {
      for (let i = 0; i < 5; i += 1) {
        api.add({ typeId: type, startedAt: onDay(day, 9, i * 2), value: 100 + i });
      }
    }

    const user = openSignedIn(`/two/${later}`);
    await waitFor(() => expect(screen.getAllByTestId('crowded')).toHaveLength(2));

    await user.click(screen.getAllByTestId('crowded')[0] as HTMLElement);

    // One opened, one still shut.
    expect(screen.getAllByTestId('crowded-open')).toHaveLength(1);
    expect(screen.getAllByTestId('crowded')).toHaveLength(1);
    // And it is the left column's, which holds the bottles: the list has
    // bottles in it and no nappies.
    const inList = within(screen.getByTestId('crowded-open'));
    expect(inList.getAllByTestId('slot-bottle').length).toBeGreaterThan(0);
    expect(inList.queryByTestId('slot-diaper')).not.toBeInTheDocument();
  });

  it('reopens the right column’s stretch after going into one of its records', async () => {
    setViewportWidth(390);
    const later = daysAgo(2);
    const earlier = daysAgo(3);
    for (const [day, type] of [[earlier, 'bottle'], [later, 'diaper']] as const) {
      for (let i = 0; i < 5; i += 1) {
        api.add({ typeId: type, startedAt: onDay(day, 9, i * 2), value: 100 + i });
      }
    }

    const user = openSignedIn(`/two/${later}`);
    await waitFor(() => expect(screen.getAllByTestId('crowded')).toHaveLength(2));

    await user.click(screen.getAllByTestId('crowded')[1] as HTMLElement);
    const opened = within(screen.getByTestId('crowded-open'));
    await user.click(opened.getAllByTestId('slot-diaper')[0] as HTMLElement);
    await screen.findByTestId('submit');
    await user.click(screen.getByLabelText(zhTW.addEvent.cancel));

    // The right column's list, open again, and still the right column's.
    const back = within(await screen.findByTestId('crowded-open'));
    expect(back.getAllByTestId('slot-diaper').length).toBeGreaterThan(0);
    expect(back.queryByTestId('slot-bottle')).not.toBeInTheDocument();
  });

  it('files a new record under the later day', async () => {
    const later = daysAgo(2);
    const user = openSignedIn(`/two/${later}`);

    await user.click(await screen.findByRole('link', { name: zhTW.a11y.addEvent }));

    expect(await screen.findByTestId('adding-on')).toHaveTextContent(later);
  });
});

describe('writing something up afterwards', () => {
  const today = (): string => toLocalDate(Date.now(), BABY.timezone);
  const daysAgo = (days: number): string => addLocalDays(today(), -days);

  it('files it under the day being looked at, not under now', async () => {
    const day = daysAgo(4);
    const user = openSignedIn(`/day/${day}`);

    await user.click(await screen.findByRole('link', { name: zhTW.a11y.addEvent }));
    expect(await screen.findByTestId('adding-on')).toHaveTextContent(day);

    await user.click(screen.getByRole('link', { name: eventTypeName('bottle') }));
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    const sent = api.lastRequest('/events')?.body as Record<string, unknown>;
    expect(toLocalDate(Number(sent['startedAt']), BABY.timezone)).toBe(day);
  });

  it('moves the date and keeps the time of day', async () => {
    // Spec 7.3 in as many words: the day being looked at, at the current
    // time of day. Not midday, and not today.
    //
    // The clock is pinned for this one test and let go again straight
    // after. The form reads it when it opens and the assertion works out
    // what it should have shown; a minute turning over between the two
    // fails with nothing wrong, a few times an hour, which is worse than
    // no test. Freezing the suite is not the answer -- at least one test
    // needs time to actually pass between opening a page and a tap.
    const at = 9 * 3_600_000 + 37 * 60_000;
    const pinned = startOfLocalDay(toLocalDate(Date.now(), BABY.timezone), BABY.timezone) + at;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(pinned);

    try {
      const day = addLocalDays(toLocalDate(pinned, BABY.timezone), -4);
      openSignedIn(`/add/bottle?on=${day}`);

      const shown = (await screen.findByTestId('started-at')) as HTMLInputElement;

      expect(shown.value.slice(0, 10)).toBe(day);
      expect(shown.value).toBe(
        toLocalInput(startOfLocalDay(day, BABY.timezone) + at, BABY.timezone),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('comes back to the day it was written for', async () => {
    const day = daysAgo(4);
    const user = openSignedIn(`/add/bottle?on=${day}`);

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));

    // Not the home screen. Somebody filling in three feeds for Tuesday
    // should not be sent back to today between each one.
    expect(await screen.findByTestId('calendar-date')).toHaveValue(day);
  });

  it('comes back to the day being looked at even when the time was moved', async () => {
    // Spec 7.3 decides this: back to the view it was entered from, on the
    // date it was showing. Never today.
    const from = daysAgo(4);
    const moved = daysAgo(6);
    const user = openSignedIn(`/add/bottle?on=${from}`);

    // Set in one go rather than typed: a datetime control halfway through
    // being typed is not a moment, and nothing should read one.
    fireEvent.change(await screen.findByTestId('started-at'), {
      target: {
        value: toLocalInput(startOfLocalDay(moved, BABY.timezone) + 9 * 3_600_000, BABY.timezone),
      },
    });
    await user.type(screen.getByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByTestId('calendar-date')).toHaveValue(from);
    expect(api.events[0]?.localDate).toBe(moved);
  });

  it('does not start a timer when writing up an earlier day', async () => {
    // Saved as a timer it would store a sleep that began four days ago and
    // is still running: instantly past the 24-hour limit, so the stop
    // button becomes the correction form, while holding the only
    // `active = 1` slot sleep has -- so tonight's cannot be started
    // either (spec 3.5, 7.2).
    const user = openSignedIn(`/add/sleep?on=${daysAgo(4)}`);

    await user.click(await screen.findByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect((api.lastRequest('/events')?.body as Record<string, unknown>)['intent']).toBe('record');
    expect(api.events[0]?.active).toBe(false);
  });

  it('still starts a timer for today, where that is what the button is for', async () => {
    const user = openSignedIn('/add/sleep');

    await user.click(await screen.findByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect((api.lastRequest('/events')?.body as Record<string, unknown>)['intent']).toBe('start_timer');
  });

  it('gives up on the day rather than on the app when cancelled', async () => {
    const day = daysAgo(4);
    const user = openSignedIn(`/add/bottle?on=${day}`);

    await user.click(await screen.findByLabelText(zhTW.addEvent.cancel));
    expect(await screen.findByTestId('adding-on')).toHaveTextContent(day);

    await user.click(screen.getByLabelText(zhTW.addEvent.cancel));
    expect(await screen.findByTestId('calendar-date')).toHaveValue(day);
  });

  it('does not offer one day’s half-typed feed on another day’s form', async () => {
    const monday = daysAgo(5);
    const tuesday = daysAgo(4);

    const user = openSignedIn(`/add/bottle?on=${monday}`);
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    closeApp();

    openSignedIn(`/add/bottle?on=${tuesday}`);
    // Monday's draft holds Monday's instant. Offered here it would show
    // Tuesday at the top and save Monday underneath.
    expect(await screen.findByLabelText(valueLabel('bottle'))).toHaveValue('');
  });

  it('still offers it back on the day it was typed for', async () => {
    const monday = daysAgo(5);

    const user = openSignedIn(`/add/bottle?on=${monday}`);
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    closeApp();

    openSignedIn(`/add/bottle?on=${monday}`);
    expect(await screen.findByDisplayValue('150')).toBeInTheDocument();
  });
});

describe('looking back at a trend', () => {
  const today = (): string => toLocalDate(Date.now(), BABY.timezone);
  const daysAgo = (days: number): string => addLocalDays(today(), -days);

  async function openStats(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = openSignedIn('/stats');
    await screen.findByLabelText(zhTW.stats.type);
    return user;
  }

  it('asks the server for the figures rather than adding up what is on the device', async () => {
    // The whole point of spec 5.6. A year is thousands of events and the
    // device holds only what it has synced, so a chart built here would be
    // short by whatever has not arrived -- while looking complete.
    api.add({ typeId: 'bottle', value: 120, startedAt: earlierToday(HOUR) });
    await openStats();

    await waitFor(() => expect(api.lastGet('/stats')).toBeDefined());
    const asked = api.lastGet('/stats')?.query;
    expect(asked?.get('types')).toBe('bottle');
    expect(asked?.get('from')).toBe(daysAgo(6));
    expect(asked?.get('to')).toBe(today());
  });

  it('opens on a week ending today, and moves the whole window with the range', async () => {
    const user = await openStats();

    await user.click(screen.getByTestId('range-year'));

    await waitFor(() => {
      const asked = api.lastGet('/stats')?.query;
      expect(asked?.get('to')).toBe(today());
      expect(asked?.get('from')).toBe(addLocalDays(today(), -(daysIn('year') - 1)));
    });
  });

  it('asks again when the start date is moved, keeping the range', async () => {
    await openStats();

    fireEvent.change(screen.getByTestId('stats-start'), { target: { value: '2026-03-02' } });

    await waitFor(() => {
      const asked = api.lastGet('/stats')?.query;
      expect(asked?.get('from')).toBe('2026-03-02');
      expect(asked?.get('to')).toBe('2026-03-08');
    });
  });

  it('draws what came back, as bars or as a line', async () => {
    api.statsValues = { [daysAgo(1)]: 300, [today()]: 420 };
    const user = await openStats();

    // Seven points for a week, whatever the figures are: the zeros are the
    // server saying those days really had none (spec 7.7).
    await waitFor(() => expect(screen.getByTestId('chart-bar')).toHaveAttribute('aria-label', '7'));

    await user.click(screen.getByTestId('kind-line'));
    expect(await screen.findByTestId('chart-line')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-bar')).not.toBeInTheDocument();
  });

  it('shows the figures in the type’s own units, not as stored integers', async () => {
    // 420 is stored millilitres and reads as 420ml; for a duration the same
    // integer is minutes and reads as seven hours (spec 5.3).
    api.statsValues = { [today()]: 420 };
    await openStats();

    await waitFor(() => expect(screen.getByTestId('stats-totals')).toHaveTextContent('420ml'));

    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'sleep' } });
    await waitFor(() =>
      expect(screen.getByTestId('stats-totals'))
        .toHaveTextContent(interpolate(zhTW.stats.hoursMinutes, { hours: 7, minutes: 0 })));
  });

  it('does not offer a total for a weight, which would be meaningless', async () => {
    // Adding up three weighings reports a toddler at twenty-one kilos.
    api.statsValues = { [today()]: 7200 };
    await openStats();
    await waitFor(() => expect(screen.getByTestId('stats-totals')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'weight' } });

    // Waited for on something positive first. Asserting the absence
    // straight away passes before the new series has even arrived, which
    // is how the first version of this test passed while totals were
    // offered for every aggregation.
    await waitFor(() =>
      expect(screen.getByTestId('chart-bar')).toHaveAttribute('aria-label', '1'));
    expect(screen.queryByTestId('stats-totals')).not.toBeInTheDocument();
  });

  it('says it counts finished records only, where that can be short', async () => {
    await openStats();
    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'sleep' } });

    // Spec 7.7 asks for this out loud: a timer still running has no length
    // yet, so today looks short for a reason nobody can see.
    expect(await screen.findByTestId('finished-only')).toHaveTextContent(zhTW.stats.finishedOnly);
  });

  it('does not claim that of a type that has no duration at all', async () => {
    api.statsValues = { [today()]: 3 };
    await openStats();
    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'diaper' } });

    // The chart for the new type first, then the absence. The other way
    // round the assertion is made before anything has rendered and passes
    // whatever the screen would have said.
    await waitFor(() =>
      expect(screen.getByTestId('stats-totals')).toHaveTextContent(
        interpolate(zhTW.stats.times, { count: 3 })));
    expect(screen.queryByTestId('finished-only')).not.toBeInTheDocument();
  });

  it('says when records on this phone are missing from the figures', async () => {
    // The figures are the server's, so anything still queued is not in
    // them. Saying so is the difference between a chart that is behind and
    // a chart that is wrong (spec 6.2, 7.7).
    //
    // Recorded with the writes failing but the reads working, which is the
    // situation this notice exists for: the entry is stuck on the device
    // while the chart loads perfectly well.
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    await screen.findByTestId('unsynced-count');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.stats }));
    await screen.findByLabelText(zhTW.stats.type);

    expect(await screen.findByTestId('stats-unsynced'))
      .toHaveTextContent(interpolate(zhTW.stats.unsynced, { count: 1 }));
  });

  it('says it could not read them rather than drawing an empty chart', async () => {
    // An empty chart is a claim: nothing happened. Failing to ask is not
    // the same thing.
    api.failStats = true;
    await openStats();

    expect(await screen.findByTestId('stats-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-bar')).not.toBeInTheDocument();
  });

  it('stops showing a chart once a later range could not be read', async () => {
    api.statsValues = { [today()]: 120 };
    const user = await openStats();
    await waitFor(() => expect(screen.getByTestId('stats-totals')).toBeInTheDocument());

    api.failStats = true;
    await user.click(screen.getByTestId('range-month'));

    expect(await screen.findByTestId('stats-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-totals')).not.toBeInTheDocument();
  });

  it('says a stretch with nothing in it is empty, for a type that has no zeros', async () => {
    await openStats();
    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'weight' } });

    expect(await screen.findByTestId('stats-empty')).toHaveTextContent(zhTW.stats.empty);
  });

  it('places each reading on its own day, not evenly across the chart', async () => {
    // Three weighings on the 1st, the 2nd and the 30th are three points.
    // Spaced by their position in the list they draw a month of steady
    // growth that never happened; spaced by date, the last one sits at the
    // right-hand edge where it belongs (spec 7.7's ungapped types).
    api.statsValues = { '2026-09-01': 7000, '2026-09-30': 7400 };
    const user = await openStats();

    await user.click(screen.getByTestId('range-month'));
    await user.click(screen.getByTestId('kind-line'));
    fireEvent.change(screen.getByTestId('stats-start'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'weight' } });

    await waitFor(() =>
      expect(screen.getByTestId('chart-line')).toHaveAttribute('aria-label', '2'));

    const dots = [...screen.getByTestId('chart-line').querySelectorAll('circle')];
    expect(dots).toHaveLength(2);
    const [first, last] = dots.map((dot) => Number(dot.getAttribute('cx')));

    // The 30th of a thirty-day window belongs at the far right. Counting
    // list positions instead would put it around three quarters across.
    expect(last as number).toBeGreaterThan(0.9 * 320);
    expect(first as number).toBeLessThan(0.1 * 320);
  });

  it('labels the months of the axis even when nothing was recorded on one', async () => {
    // The labels come from the range, not from the points. Taken from the
    // points, a month with no reading on its 1st loses its marker
    // altogether and the rest sit wherever somebody happened to weigh.
    api.statsValues = { '2026-09-02': 7000 };
    const user = await openStats();

    await user.click(screen.getByTestId('range-month'));
    fireEvent.change(screen.getByTestId('stats-start'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'weight' } });

    await waitFor(() =>
      expect(screen.getByTestId('chart-bar')).toHaveAttribute('aria-label', '1'));

    // 1, 5, 10, 15, 20, 25, 30 of a thirty-day window.
    const labels = [...screen.getByTestId('chart-bar').querySelectorAll('text')];
    expect(labels.map((label) => label.textContent)).toEqual(['1', '5', '10', '15', '20', '25', '30']);
  });

  it('asks again when the app catches up, so the chart is not left behind', async () => {
    // Otherwise the header says "just synced" and the unsynced notice has
    // gone, while the chart is still missing the record it was about.
    api.statsValues = { [today()]: 120 };
    const user = await openStats();
    await waitFor(() => expect(screen.getByTestId('stats-totals')).toHaveTextContent('120ml'));

    api.statsValues = { [today()]: 300 };
    await user.click(screen.getByRole('button', { name: zhTW.a11y.sync }));

    await waitFor(() => expect(screen.getByTestId('stats-totals')).toHaveTextContent('300ml'));
  });

  it('asks again once a queued record has actually been sent', async () => {
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    await screen.findByTestId('unsynced-count');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.stats }));
    await screen.findByLabelText(zhTW.stats.type);
    // The chart for the thing that was just recorded, so the story is one
    // story: a nappy waiting on the phone and a nappy chart without it.
    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'diaper' } });
    await screen.findByTestId('stats-unsynced');

    // The figures change the moment the queue drains, because the figures
    // are the server's.
    api.statsValues = { [today()]: 1 };
    comeBack();

    // Waited for on the new figure, not on the notice going. Loading hides
    // the notice too, so "it disappeared" would pass while the chart was
    // still showing the old numbers -- which is the whole bug.
    await waitFor(() =>
      expect(screen.getByTestId('stats-totals'))
        .toHaveTextContent(interpolate(zhTW.stats.times, { count: 1 })));

    // And then the notice, which is a separate step: the chart re-asks when
    // the events change and the queue empties on its own schedule, so
    // neither can be assumed to have happened because the other did.
    await waitFor(() => expect(screen.queryByTestId('stats-unsynced')).not.toBeInTheDocument());
  });

  it('can be asked again after the first read failed', async () => {
    // Pressing sync only asks again if the sync itself succeeds, and what
    // usually fails first here is the connection.
    api.failStats = true;
    const user = await openStats();
    await screen.findByTestId('stats-failed');

    api.failStats = false;
    api.statsValues = { [today()]: 120 };
    await user.click(screen.getByTestId('stats-retry'));

    await waitFor(() => expect(screen.getByTestId('stats-totals')).toHaveTextContent('120ml'));
  });

  it('still says why a chart is empty when the records are on this phone', async () => {
    // The worst case for hiding this: the server has no weighings, the phone
    // has one waiting, and without the notice the screen just says there is
    // nothing.
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    await screen.findByTestId('unsynced-count');

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.stats }));
    await screen.findByLabelText(zhTW.stats.type);
    fireEvent.change(screen.getByTestId('stats-type'), { target: { value: 'weight' } });

    expect(await screen.findByTestId('stats-empty')).toBeInTheDocument();
    expect(screen.getByTestId('stats-unsynced')).toBeInTheDocument();
  });

  it('says which days it is showing, because the buttons only say how many', async () => {
    // A 30-day range from 1 February runs to 2 March. The button cannot say
    // that and the chart cannot show it, so the dates are printed.
    const user = await openStats();

    await user.click(screen.getByTestId('range-month'));
    fireEvent.change(screen.getByTestId('stats-start'), { target: { value: '2026-02-01' } });

    await waitFor(() =>
      expect(screen.getByTestId('stats-window')).toHaveTextContent(
        interpolate(zhTW.stats.showing, { from: '2026-02-01', to: '2026-03-02' })));
  });

  it('is reachable from the page list', async () => {
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByTestId('open-menu'));
    await user.click(screen.getByRole('link', { name: zhTW.nav.stats }));

    expect(await screen.findByLabelText(zhTW.stats.type)).toBeInTheDocument();
  });
});

describe('the notch and the home indicator', () => {
  it('draws every screen inside the safe area', async () => {
    openSignedIn();
    await waitForHome();

    // `viewport-fit=cover` puts the page under the island and the home
    // indicator, and the top row of buttons with it.
    //
    // This cannot prove the padding is the right size: jsdom has no
    // insets, `env()` resolves to nothing, and no browser on a desktop
    // has a notch to be under. What it can do is fail if the treatment
    // is taken off the shell, which is the way this would come back --
    // silently, and only on the one device nobody tests on. Whether it
    // is actually clear of the island is checked on a phone.
    const shell = document.querySelector('.safe-area');
    expect(shell).not.toBeNull();

    // Named rather than assumed: the point is that the controls reported
    // as unreachable are inside it, not that some element somewhere is.
    for (const control of [
      screen.getByRole('link', { name: zhTW.a11y.openSettings }),
      screen.getByRole('button', { name: zhTW.a11y.openMenu }),
      screen.getByRole('link', { name: zhTW.a11y.addEvent }),
    ]) {
      expect(shell?.contains(control)).toBe(true);
    }
  });
});

describe('saving again after a save that said nothing', () => {
  it('reaches the same event instead of adding a second one', async () => {
    // Stored on the server, but the reply never arrives. From the phone
    // this is indistinguishable from a refusal (spec 6.1).
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByTestId('outcome-unknown')).toBeInTheDocument();
    expect(api.events).toHaveLength(1);

    await user.click(screen.getByTestId('submit'));

    // The same id, so the server answers with what it already has. A fresh
    // id here would have given the baby two bottles instead of one.
    await waitFor(() => expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument());
    expect(api.events).toHaveLength(1);

    const posts = api.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/events'));
    expect(posts).toHaveLength(2);
    expect((posts[0]?.body as Record<string, unknown>)['id'])
      .toBe((posts[1]?.body as Record<string, unknown>)['id']);
  });

  it('will not let the content be changed before the result is known', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.type(amount, '150');
    await user.click(screen.getByTestId('submit'));

    await screen.findByTestId('outcome-unknown');

    // Editing now would send a correction under an id the server may
    // already hold, and it would answer with the old content while the
    // screen went back to the list as though the change had landed.
    expect(amount).toBeDisabled();
  });

  it('resends the original content, not whatever is on screen', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    await user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument());

    const posts = api.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/events'));
    expect((posts[1]?.body as Record<string, unknown>)['value']).toBe(150);
  });

  it('lets the parent correct it when the server definitely refused', async () => {
    api.nextFailure = { status: 422, code: 'VALIDATION_FAILED', fields: [{ field: 'value', code: 'OUT_OF_RANGE', params: { min: 0, max: 500 } }] };
    const user = openSignedIn('/add/bottle');

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.type(amount, '150');
    await user.click(screen.getByTestId('submit'));

    // A definite answer: the server does not have it, so nothing is frozen.
    await screen.findByTestId('form-error');
    expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument();
    expect(amount).not.toBeDisabled();
  });

  it.each([
    ['being asked to slow down', { status: 429, code: 'RATE_LIMITED' }],
    ['losing access to the baby', { status: 404, code: 'NOT_FOUND' }],
    ['being refused outright', { status: 403, code: 'FORBIDDEN' }],
    ['the server falling over', { status: 500, code: 'INTERNAL' }],
  ])('keeps the doubt after %s', async (_name, failure) => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // None of these say anything about whether the first attempt landed.
    // Being removed from the baby afterwards does not make the record it
    // may already hold disappear (spec 6.1).
    api.nextFailure = failure;
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByTestId('outcome-unknown')).toBeInTheDocument();
  });

  it('settles only on a refusal the server could not give for a stored event', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // The create handler reads the id back before it validates anything,
    // so reaching a validation failure means it looked and found nothing
    // (spec 5.8).
    api.nextFailure = { status: 422, code: 'VALIDATION_FAILED', fields: [{ field: 'value', code: 'OUT_OF_RANGE', params: { min: 0, max: 500 } }] };
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument());
    expect(await screen.findByLabelText(valueLabel('bottle'))).not.toBeDisabled();
  });

  it('survives being signed out, and is sent once the same person is back', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // Signing out takes the form, the store and every piece of state the
    // retry depended on with it -- including the id (spec 6.1). A session
    // that expired is not the record being refused, so the queue pauses
    // rather than giving up on it.
    api.nextFailure = { status: 401, code: 'UNAUTHENTICATED' };
    await user.click(screen.getByTestId('submit'));

    await user.type(await screen.findByLabelText(zhTW.auth.username), 'parent');
    await user.type(screen.getByLabelText(zhTW.auth.password), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: zhTW.auth.submit }));

    // The queue starts again by itself and resends the original under the
    // original id, which is exactly how the doubt is meant to be settled.
    await waitFor(() => expect(api.events).toHaveLength(1));

    // One bottle, not two, and always under the same id.
    const posts = api.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/events'));
    const ids = new Set(posts.map((entry) => (entry.body as Record<string, unknown>)['id']));
    expect(ids.size).toBe(1);
    expect((posts[0]?.body as Record<string, unknown>)['value']).toBe(150);
  });

  it('does not let a different account send what the last one was holding', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    const before = api.requests.filter((e) => e.method === 'POST' && e.path.endsWith('/events')).length;

    // Somebody else signs in on the same phone. Their queue is empty, and
    // sending the previous account's record under their session would file
    // it against the wrong family (spec 6.1).
    closeApp();
    signedInAs('the-other-parent');
    openSignedIn('/');
    await waitForHome();

    expect(screen.queryByTestId('unsynced-count')).not.toBeInTheDocument();
    expect(api.requests.filter((e) => e.method === 'POST' && e.path.endsWith('/events')))
      .toHaveLength(before);
  });

  it('is findable again from the home screen', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // A fresh start, as a reload after signing back in would be: without a
    // way back to it, the parent would simply record the bottle again.
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();

    await next.click(await screen.findByTestId('unsynced-count'));

    // The content, so it can be recognised as the bottle that was given
    // rather than as an id (spec 6.1).
    expect(await screen.findByTestId('unsynced-retry')).toBeInTheDocument();
    expect(screen.getByTestId('unsynced-state')).toHaveTextContent(zhTW.unsynced.unknown);

    await next.click(screen.getByTestId('unsynced-retry'));

    await waitFor(() => expect(screen.queryByTestId('unsynced-retry')).not.toBeInTheDocument());
    expect(api.events).toHaveLength(1);
  });

  it('cannot be corrected from the list until the doubt is settled', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    closeApp();
    const next = openSignedIn('/');
    await waitForHome();
    await next.click(await screen.findByTestId('unsynced-count'));

    // The server may already hold 150 ml. Sending 100 ml under the same id
    // would come back as the stored 150 and the correction would be gone
    // without a trace (spec 6.1).
    await screen.findByTestId('unsynced-retry');
    expect(screen.queryByTestId('unsynced-correct')).not.toBeInTheDocument();
    expect(screen.getByTestId('unsynced-unknown')).toBeInTheDocument();
  });

  it('is left alone when a different event is recorded successfully', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // Life carries on. A nappy going through says nothing whatsoever about
    // whether the bottle landed, and must not take its id with it.
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();
    await next.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await next.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));
    await waitForHome();

    expect(screen.getByTestId('unsynced-count')).toHaveTextContent(
      interpolate(zhTW.home.unsynced, { count: 1 }),
    );
    await next.click(screen.getByTestId('unsynced-count'));
    expect(await screen.findByTestId('unsynced-retry')).toBeInTheDocument();
  });

  it('is not overwritten when a different event also goes unanswered', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    closeApp();
    const next = openSignedIn('/');
    await waitForHome();
    await next.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));

    api.loseNextResponse = true;
    await next.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));
    await screen.findByTestId('outcome-unknown');

    // Two in doubt, and one store: the second must not land on top of the
    // first. Both ids have to survive to be worth keeping at all.
    closeApp();
    const third = openSignedIn('/');
    await waitForHome();
    expect(screen.getByTestId('unsynced-count')).toHaveTextContent(
      interpolate(zhTW.home.unsynced, { count: 2 }),
    );

    await third.click(screen.getByTestId('unsynced-count'));
    expect(await screen.findAllByTestId('unsynced-retry')).toHaveLength(2);
  });

  it('is left alone by another account recording successfully', async () => {
    const first = api.userId;
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    closeApp();
    signedInAs('the-other-parent');
    const other = openSignedIn('/add/bottle');

    // The form offers the last amount, which here is the very bottle that
    // is in doubt, so it has to be cleared before typing a new one.
    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await other.clear(amount);
    await other.type(amount, '90');
    await other.click(screen.getByTestId('submit'));
    await waitForHome();

    // Back as the first parent, whose bottle is still unaccounted for.
    closeApp();
    signedInAs(first);
    const firstAgain = openSignedIn('/');
    await waitForHome();

    await firstAgain.click(await screen.findByTestId('unsynced-count'));
    expect(await screen.findAllByTestId('unsynced-retry')).toHaveLength(1);
  });

  it('is gone once its own add is confirmed', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    await user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument());

    closeApp();
    openSignedIn('/');
    await waitForHome();
    expect(screen.queryByTestId('unsynced-count')).not.toBeInTheDocument();
  });

  it('leaves the home screen alone when there is nothing pending', async () => {
    openSignedIn();
    await waitForHome();
    expect(screen.queryByTestId('unsynced-count')).not.toBeInTheDocument();
  });

  it('is not picked up by a different type', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    closeApp();
    openSignedIn('/add/temperature');

    // Resending somebody's bottle because they opened a different form
    // would be worse than the duplicate this is all meant to prevent.
    expect(await screen.findByLabelText(valueLabel('temperature'))).not.toBeDisabled();
    expect(screen.queryByTestId('outcome-unknown')).not.toBeInTheDocument();
  });

  it('is not claimed by a different account while the app still shows the old one', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    const isPost = (entry: { method: string; path: string }): boolean =>
      entry.method === 'POST' && entry.path.endsWith('/events');
    const abandoned = (api.requests.filter(isPost)[0]?.body as Record<string, unknown>)['id'];

    // The remembered description of the account is deliberately left in
    // place. The app shows it straight away and asks the server who the
    // token really belongs to in the background -- and the answer here is
    // somebody else, so everything below has to be built again.
    closeApp();
    api.signInAs('someone-else');
    const other = openSignedIn('/add/bottle');

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await waitFor(() => expect(screen.getByLabelText(valueLabel('bottle'))).not.toBeDisabled());
    await other.clear(amount);
    await other.type(amount, '90');
    await other.click(screen.getByTestId('submit'));
    await waitForHome();

    // Sending under the id the previous account was waiting on would file
    // one family's record against another's, and would settle a doubt that
    // was never theirs to settle (spec 6.1).
    const ids = api.requests.filter(isPost).map((e) => (e.body as Record<string, unknown>)['id']);
    expect(ids[ids.length - 1]).not.toBe(abandoned);
  });

  it('is not picked up by a different account', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');

    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    closeApp();
    signedInAs('someone-else');
    openSignedIn('/add/bottle');

    expect(await screen.findByLabelText(valueLabel('bottle'))).not.toBeDisabled();
  });

  it('resends the kind that was tapped first, not the one tapped after', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    await screen.findByTestId('outcome-unknown');

    // The shortcut has nothing to freeze -- the kind comes from whichever
    // button is pressed -- so this is where resending the original content
    // is the only thing standing between a lost reply and a nappy filed
    // under the wrong kind (spec 6.1).
    await user.click(screen.getByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));
    await waitForHome();

    expect(api.events).toHaveLength(1);
    expect(api.events[0]?.metadata['diaper_kind']).toBe('poo');

    const posts = api.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/events'));
    expect(posts).toHaveLength(2);
    for (const attempt of posts) {
      expect((attempt.body as Record<string, unknown>)['metadata']).toEqual({ diaper_kind: 'poo' });
    }
  });

  it('applies to the nappy shortcut too', async () => {
    api.loseNextResponse = true;
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    const button = await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') });
    await user.click(button);

    expect(await screen.findByTestId('outcome-unknown')).toBeInTheDocument();
    expect(api.events).toHaveLength(1);

    await user.click(button);
    await waitForHome();
    expect(api.events).toHaveLength(1);
  });
});

describe('a timer that has run past a day', () => {
  const OVERRUN = 30 * HOUR;

  it('offers the form instead of a stop button that could only fail', async () => {
    const stuck = api.add({ typeId: 'sleep', active: true, startedAt: Date.now() - OVERRUN });
    openSignedIn();
    await waitForHome();

    // The API refuses any end time past twenty-four hours, so a stop button
    // here would fail every time and the slot would stay occupied.
    expect(screen.getByTestId('timer-overrun-sleep')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhTW.timer.stop })).not.toBeInTheDocument();

    const link = screen.getByRole('link', { name: zhTW.timer.confirmEnd });
    expect(link).toHaveAttribute('href', `/event/${stuck.id}`);
  });

  it('says plainly that it has overrun', async () => {
    api.add({ typeId: 'sleep', active: true, startedAt: Date.now() - OVERRUN });
    openSignedIn();
    await waitForHome();

    expect(
      screen.getByText(interpolate(zhTW.timer.overrun, { name: eventTypeName('sleep') })),
    ).toBeInTheDocument();
  });

  it('opens the event even though it is not in today’s list', async () => {
    const stuck = api.add({ typeId: 'sleep', active: true, startedAt: Date.now() - OVERRUN });
    const user = openSignedIn();
    await waitForHome();

    // Started the day before yesterday, so tapping it in the list is not an
    // option: the card is the only way in (spec 7.2).
    expect(screen.queryByTestId('event-row-sleep')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: zhTW.timer.confirmEnd }));
    expect(await screen.findByTestId('ended-at')).toBeInTheDocument();
    expect(api.find(stuck.id)).toBeDefined();
  });
});

describe('when stopping a timer fails', () => {
  it('says so instead of leaving the button to spring back', async () => {
    api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(HOUR) });
    const user = openSignedIn();
    await waitForHome();

    api.nextFailure = { status: 409, code: 'VERSION_CONFLICT' };
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));

    const error = await screen.findByTestId('timer-error');
    expect(error).toHaveTextContent(zhTW.timer.stopFailed);
    expect(error).toHaveTextContent(zhTW.error.VERSION_CONFLICT);
  });

  it('fetches the version the other phone left behind', async () => {
    api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(HOUR) });
    const user = openSignedIn();
    await waitForHome();

    api.nextFailure = { status: 409, code: 'VERSION_CONFLICT' };
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-error');

    // Without this the next press sends the same stale version and fails
    // again, and again, with nothing on screen changing.
    //
    // Waited for: the refresh goes through the same one-at-a-time lane as
    // every other sync, so it may be queued behind one already running.
    await waitFor(() => {
      const patched = api.requests.findIndex((entry) => entry.method === 'PATCH');
      expect(patched).toBeGreaterThanOrEqual(0);
      expect(api.requests.slice(patched).some((entry) => entry.path.endsWith('/summary'))).toBe(true);
    });
  });

  it('reports a request that never arrived as being offline', async () => {
    api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(HOUR) });
    const user = openSignedIn();
    await waitForHome();

    server.use(http.patch('/api/events/:eventId', () => HttpResponse.error()));
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));

    expect(await screen.findByTestId('timer-error')).toHaveTextContent(zhTW.error.offline);
  });
});

describe('an all-day event', () => {
  it('asks for a date and no clock time', async () => {
    openSignedIn('/add/milestone');

    // A time the parent sets and the server then discards looks like the
    // app losing their input (spec 3.9).
    expect(await screen.findByTestId('started-at')).toHaveAttribute('type', 'date');
  });

  it('sends local midnight for the day that was picked', async () => {
    const user = openSignedIn('/add/milestone');

    await user.type(await screen.findByLabelText(metadataLabel('title')), USER_CONTENT.milestone);
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    const sent = api.lastRequest('/events')?.body as Record<string, unknown>;
    expect(sent['startedAt']).toBe(startOfLocalDay(toLocalDate(Date.now(), BABY.timezone), BABY.timezone));
  });
});

describe('recording with no signal', () => {
  it('keeps the record, and sends it exactly once when the signal comes back', async () => {
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));
    await waitForHome();

    // Written down, said so, and visible in today's list rather than only
    // counted -- a parent who cannot see it records it again (spec 6.2).
    expect(await screen.findByTestId('unsynced-count')).toHaveTextContent(
      interpolate(zhTW.home.unsynced, { count: 1 }),
    );
    expect(screen.getByTestId('waiting-row-diaper')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);

    comeBack();

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(posts()).toHaveLength(1);
    expect(api.events[0]?.metadata['diaper_kind']).toBe('poo');

    // And it stops being a waiting record, without becoming a second one.
    await waitFor(() => expect(screen.queryByTestId('unsynced-count')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByTestId('event-row-diaper')).toHaveLength(1));
    expect(screen.queryByTestId('waiting-row-diaper')).not.toBeInTheDocument();
  });

  it('sends several in the order they were recorded, and none of them twice', async () => {
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    for (const kind of ['pee', 'poo', 'both']) {
      await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
      await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', kind) }));
      await waitForHome();
    }

    expect(await screen.findByTestId('unsynced-count')).toHaveTextContent(
      interpolate(zhTW.home.unsynced, { count: 3 }),
    );

    comeBack();

    await waitFor(() => expect(api.events).toHaveLength(3));
    expect(posts()).toHaveLength(3);
    expect(api.events.map((event) => event.metadata['diaper_kind'])).toEqual(['pee', 'poo', 'both']);
  });

  it('does not spend a retry, or gain any doubt, while there is no signal', async () => {
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));
    await waitForHome();

    await user.click(await screen.findByTestId('unsynced-count'));

    // Nothing left the device, so nothing is in doubt -- which is what
    // leaves the parent free to correct it (spec 6.1).
    expect(await screen.findByTestId('unsynced-state')).toHaveTextContent(zhTW.unsynced.queued);
    expect(screen.queryByTestId('unsynced-unknown')).not.toBeInTheDocument();
    expect(screen.getByTestId('unsynced-correct')).toBeInTheDocument();
  });

  it('turns a correction into an edit when the queue sent the original first', async () => {
    const user = openSignedIn('/add/bottle');
    await screen.findByLabelText(valueLabel('bottle'));

    goOffline();
    await user.type(screen.getByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await waitForHome();

    // Queued and not in doubt, because nothing left the device -- so the
    // list offers to correct it.
    await user.click(await screen.findByTestId('unsynced-count'));
    await user.click(await screen.findByTestId('unsynced-correct'));
    const amount = await screen.findByLabelText(valueLabel('bottle'));
    expect(amount).toHaveValue('150');

    // The signal comes back while the correction is being typed, and the
    // queue does what it is for.
    comeBack();
    await waitFor(() => expect(api.events).toHaveLength(1));

    await user.clear(amount);
    await user.type(amount, '100');
    await user.click(screen.getByTestId('submit'));

    // The server holds 150 now. Posting 100 under the same id would come
    // back as the stored 150, and the correction would be gone while the
    // screen said it had been saved. It has to become an edit, with a
    // version (spec 6.1, 6.3).
    expect(await screen.findByText(zhTW.event.edit)).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(api.events).toHaveLength(1);
    expect(api.events[0]?.value).toBe(150);
  });

  it('refuses to edit, and says why', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '160');

    goOffline();
    await user.click(screen.getByTestId('submit'));

    // An edit made offline carries the version read offline, so it comes
    // back 409 almost every time -- and the answer to a 409 is a question
    // for somebody who is asleep (spec 6.1).
    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.error.needsConnection);
    expect(api.find(event.id)?.value).toBe(140);
  });

  it('refuses to delete, and says why', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    await user.click(await screen.findByRole('button', { name: zhTW.addEvent.delete }));
    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.event.deleteConfirmYes }));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.error.needsConnection);
    expect(api.find(event.id)).toBeDefined();
  });
});

/**
 * Holds the next tag creation until the test lets it go.
 *
 * The server's answer arriving late is the ordinary case on a phone, and
 * everything typed in the meantime is what is at stake.
 */
function holdTagCreation(): () => void {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  server.use(http.post('/api/babies/:babyId/tags', async ({ request }) => {
    const body = (await request.json()) as { name: string };
    await gate;
    const made = { id: 'tag-new', name: body.name, createdAt: 0 };
    api.tags.push(made);
    return HttpResponse.json(made, { status: 201 });
  }));
  return release;
}

describe('tags on a record', () => {
  /** Walks to the bottle form, which has a value field and so a draft. */
  async function intoTheForm(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = openSignedIn('/add/bottle');
    // A bottle needs an amount, and there is no previous one to prefill
    // from in these fixtures.
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    return user;
  }

  const chip = (name: string): HTMLElement =>
    screen.getAllByTestId('tag-chip').find((one) => one.textContent?.includes(name)) as HTMLElement;

  it('offers the baby’s tags and sends the ones that were chosen', async () => {
    api.tags = [
      { id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 },
      { id: 'tag-day', name: 'daytime', createdAt: 0 },
    ];

    const user = await intoTheForm();
    await user.click(chip(USER_CONTENT.tag));
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.tagIds).toEqual(['tag-night']);
  });

  it('sends none when none was chosen', async () => {
    api.tags = [{ id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 }];

    const user = await intoTheForm();
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.tagIds).toEqual([]);
  });

  it('lets one be made on the spot, and puts it on this record', async () => {
    // Spec 7.3 asks for both: choosing from the list and adding one here.
    // Making somebody tap the new tag again afterwards would be a step that
    // exists only because of how it was built.
    const user = await intoTheForm();

    await user.click(screen.getByTestId('add-tag'));
    await user.type(screen.getByTestId('tag-name'), USER_CONTENT.tag);
    await user.click(screen.getByTestId('save-tag'));

    await waitFor(() => expect(screen.getAllByTestId('tag-chip')).toHaveLength(1));
    expect(chip(USER_CONTENT.tag)).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.tags.map((one) => one.name)).toEqual([USER_CONTENT.tag]);
    expect(api.events[0]?.tagIds).toEqual([api.tags[0]?.id]);
  });

  it('carries the tags through the queue when there is no signal', async () => {
    // The one that matters most. A feed written up with no signal and
    // tagged has to arrive tagged: sent later as a second step it would be
    // an edit, which the queue does not take, so the tags would simply be
    // lost on the way (spec 6.1).
    api.tags = [{ id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 }];

    const user = openSignedIn();
    await waitForHome();
    // Synced while there was a signal, so the list is on the device.
    await waitFor(() => expect(api.requests.some((one) => one.path.endsWith('/tags'))).toBe(true));

    goOffline();
    await user.click(screen.getByRole('link', {
      name: `${zhTW.addEvent.title} ${eventTypeName('bottle')}`,
    }));
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');

    await user.click(chip(USER_CONTENT.tag));
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('unsynced-count');

    comeBack();
    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.tagIds).toEqual(['tag-night']);
  });

  it('says a new tag needs a connection, and still offers the synced ones', async () => {
    // The queue takes event creations and nothing else, and a tag minted on
    // the device would carry an id the server never agreed to.
    api.tags = [{ id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 }];

    const user = openSignedIn();
    await waitForHome();
    await waitFor(() => expect(api.requests.some((one) => one.path.endsWith('/tags'))).toBe(true));

    goOffline();
    await user.click(screen.getByRole('link', {
      name: `${zhTW.addEvent.title} ${eventTypeName('bottle')}`,
    }));
    await screen.findByTestId('submit');

    await user.click(screen.getByTestId('add-tag'));
    await user.type(screen.getByTestId('tag-name'), 'something new');
    await user.click(screen.getByTestId('save-tag'));

    expect(await screen.findByTestId('tag-offline')).toBeInTheDocument();
    // And the ones already synced are still there to choose.
    expect(chip(USER_CONTENT.tag)).toBeInTheDocument();
  });

  it('keeps everything typed while a new tag was being made', async () => {
    // Found in review: the answer to "make this tag" put back the whole form
    // as it was when the button was pressed, so a note typed while it was
    // in the air was silently undone -- and an amount, or another tag
    // chosen meanwhile, with it.
    api.tags = [{ id: 'tag-day', name: 'daytime', createdAt: 0 }];
    const release = holdTagCreation();

    const user = await intoTheForm();
    await user.click(screen.getByTestId('add-tag'));
    await user.type(screen.getByTestId('tag-name'), USER_CONTENT.tag);
    await user.click(screen.getByTestId('save-tag'));

    // While it is in the air: a note, a different amount, another tag.
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);
    const amount = screen.getByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '180');
    await user.click(chip('daytime'));

    release();
    await waitFor(() => expect(chip(USER_CONTENT.tag)).toHaveAttribute('aria-pressed', 'true'));

    expect(screen.getByLabelText(zhTW.addEvent.note)).toHaveValue(USER_CONTENT.note);
    expect(screen.getByLabelText(valueLabel('bottle'))).toHaveValue('180');
    expect(chip('daytime')).toHaveAttribute('aria-pressed', 'true');

    // And it is what reaches the server, not only what is on the screen.
    await user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.note).toBe(USER_CONTENT.note);
    expect(api.events[0]?.value).toBe(180);
    expect([...(api.events[0]?.tagIds ?? [])].sort()).toEqual(['tag-day', 'tag-new']);
  });

  it('does not leave a draft behind when the tag answers after the form is gone', async () => {
    // Saved while the tag was still being made: the form is cleared and the
    // screen is gone. An answer arriving after that must not write the old
    // content back as a draft, or the next bottle form would open holding
    // this one's amount and note.
    const release = holdTagCreation();

    const user = await intoTheForm();
    await user.click(screen.getByTestId('add-tag'));
    await user.type(screen.getByTestId('tag-name'), USER_CONTENT.tag);
    await user.click(screen.getByTestId('save-tag'));
    await user.click(screen.getByTestId('submit'));
    // Gone for real: the server having the record is not enough, because
    // the form clears its draft only once it has heard back. Released any
    // earlier, the late write lands before that clear and is hidden by it.
    await waitForHome();

    release();
    await waitFor(() => expect(api.tags).toHaveLength(1));
    // Let the answer land and anything it would do run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readForm(formKey(scopeOf(api.userId, BABY.id), 'add:bottle:'))).toBeNull();
  });

  it('does not touch a record that is already on its way to the server', async () => {
    // While a record is being sent, its draft carries the id it is going
    // out under, and that mark is what stops a reload from turning it into
    // a second record (spec 3.8). The form is frozen for exactly that
    // reason -- but a fieldset only stops taps, not an answer arriving
    // late. Written over without the mark, the record would be offered
    // again as a draft and could be sent twice.
    const releaseTag = holdTagCreation();

    const user = await intoTheForm();
    await user.click(screen.getByTestId('add-tag'));
    await user.type(screen.getByTestId('tag-name'), USER_CONTENT.tag);
    await user.click(screen.getByTestId('save-tag'));

    const releaseWrite = api.holdNextWrite();
    await user.click(screen.getByTestId('submit'));
    const key = formKey(scopeOf(api.userId, BABY.id), 'add:bottle:');
    await waitFor(() => expect(readForm(key)?.eventId).toBeDefined());
    const sending = readForm(key)?.eventId;

    releaseTag();
    await waitFor(() => expect(api.tags).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Still marked as being handed over, under the same id.
    expect(readForm(key)?.eventId).toBe(sending);

    releaseWrite();
    await waitForHome();
    expect(api.events).toHaveLength(1);
  });

  /**
   * A sleep whose answer was lost: the server may have it, the screen says
   * the outcome is unknown, and the draft is marked with the id it went out
   * under.
   */
  async function sleepInDoubt(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    key: string;
    sending: string | undefined;
  }> {
    api.loseNextResponse = true;
    const user = openSignedIn('/add/sleep');
    await user.click(await screen.findByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    const key = formKey(scopeOf(api.userId, BABY.id), 'add:sleep:');
    const sending = readForm(key)?.eventId;
    expect(sending).toBeDefined();
    return { user, key, sending };
  }

  it('cannot switch between timing and writing up while the outcome is unknown', async () => {
    // Found in review. A lost answer is a failure to *hear*, not a refusal:
    // the server may well have the record, so the content still belongs to
    // the queue and the draft still has to say which id it went out as.
    // The lock read every failure as "handed back" and opened, and the
    // intent toggle -- outside the fieldset, checking only the lock --
    // rewrote the draft without its mark. Reloaded, that is a draft that
    // can be sent again as a second record (spec 3.8).
    const { user, key, sending } = await sleepInDoubt();

    expect(screen.getByRole('button', { name: zhTW.addEvent.record })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: zhTW.addEvent.record }));

    expect(readForm(key)?.eventId).toBe(sending);
    expect(readForm(key)?.intent).toBe('start_timer');
  });

  it('does not let a late tag rewrite a record whose outcome is unknown', async () => {
    // The path disabled controls cannot close: an answer, not a tap. A tag
    // made just before saving answers after the save was lost, and the form
    // it lands in is holding a record the server may already have.
    const release = holdTagCreation();
    api.loseNextResponse = true;

    const user = openSignedIn('/add/sleep');
    await user.click(await screen.findByTestId('add-tag'));
    await user.type(screen.getByTestId('tag-name'), USER_CONTENT.tag);
    await user.click(screen.getByTestId('save-tag'));
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    const key = formKey(scopeOf(api.userId, BABY.id), 'add:sleep:');
    const sending = readForm(key)?.eventId;
    expect(sending).toBeDefined();

    release();
    await waitFor(() => expect(api.tags).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readForm(key)?.eventId).toBe(sending);
    expect(readForm(key)?.draft.tagIds).toEqual([]);
  });

  it('still cannot after a reload, when nothing in memory remembers the send', async () => {
    // A reload starts every ref afresh, so a lock held in one is open again.
    // What is still in doubt has to be asked of the queue, not remembered.
    const { sending, key } = await sleepInDoubt();

    closeApp();
    const user = openSignedIn('/add/sleep');
    await screen.findByTestId('outcome-unknown');

    await user.click(screen.getByRole('button', { name: zhTW.addEvent.record }));

    // Whatever is stored for this form, it is never a draft that has lost
    // the id it went out under.
    const after = readForm(key);
    expect(after !== null && after.eventId !== sending).toBe(false);
  });

  it('keeps what was chosen through a reload', async () => {
    // The draft is written as it is typed, tags and all: the browser
    // reclaiming a background tab does not ask first (spec 2.1).
    api.tags = [{ id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 }];

    const user = await intoTheForm();
    await user.click(chip(USER_CONTENT.tag));

    closeApp();
    openSignedIn('/add/bottle');
    await screen.findByTestId('submit');

    await waitFor(() => expect(chip(USER_CONTENT.tag)).toHaveAttribute('aria-pressed', 'true'));
  });
});

describe('tags on a record being edited', () => {
  const chip = (name: string): HTMLElement =>
    screen.getAllByTestId('tag-chip').find((one) => one.textContent?.includes(name)) as HTMLElement;

  async function intoTheEdit(tagIds: string[] = []): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    event: { id: string };
  }> {
    api.tags = [
      { id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 },
      { id: 'tag-day', name: 'daytime', createdAt: 0 },
    ];
    const event = api.add({ typeId: 'bottle', value: 140, startedAt: earlierToday(HOUR), tagIds });

    const user = openSignedIn();
    await waitForHome();
    await user.click(screen.getByRole('link', {
      name: interpolate(zhTW.event.open, { name: eventTypeName('bottle') }),
    }));
    await screen.findByTestId('submit');
    return { user, event };
  }

  it('shows the tags the record already has', async () => {
    await intoTheEdit(['tag-night']);

    expect(chip(USER_CONTENT.tag)).toHaveAttribute('aria-pressed', 'true');
    expect(chip('daytime')).toHaveAttribute('aria-pressed', 'false');
  });

  it('sends the whole list, so removing one removes it', async () => {
    const { user, event } = await intoTheEdit(['tag-night']);

    await user.click(chip(USER_CONTENT.tag));
    await user.click(chip('daytime'));
    await user.click(screen.getByTestId('submit'));

    await waitFor(() =>
      expect(api.events.find((one) => one.id === event.id)?.tagIds).toEqual(['tag-day']));
  });

  /**
   * An edit draft as a build from before tags left it: a version it was
   * written against, and no `tagIds` field at all.
   */
  function leaveDraftFromBeforeTags(event: { id: string; startedAt: number; version: number }): void {
    const old = {
      startedAt: event.startedAt,
      endedAt: null,
      displayValue: '160',
      note: '',
      metadata: {},
    } as unknown as Parameters<typeof saveForm>[2];
    saveForm(formKey(scopeOf(api.userId, BABY.id), `edit:${event.id}`), 'record', old, {
      baseVersion: event.version,
    });
  }

  it('keeps the record\u2019s tags when a draft from before tags is restored', async () => {
    // Found in review. The draft has no opinion about tags -- the field did
    // not exist when it was written -- so it must not be read as "none".
    // Read that way, saving it sent an empty list and silently took every
    // tag off the record.
    api.tags = [{ id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 }];
    const event = api.add({
      typeId: 'bottle', value: 140, startedAt: earlierToday(HOUR), tagIds: ['tag-night'],
    });
    leaveDraftFromBeforeTags(event);

    const user = openSignedIn(`/event/${event.id}`);
    // The draft was applied...
    expect(await screen.findByLabelText(valueLabel('bottle'))).toHaveValue('160');
    // ...and the record's own tag is still chosen.
    expect(chip(USER_CONTENT.tag)).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(api.events.find((one) => one.id === event.id)?.value).toBe(160));
    expect(api.events.find((one) => one.id === event.id)?.tagIds).toEqual(['tag-night']);
  });

  it('still clears them when the draft says it chose none', async () => {
    // The other half: an empty list written by this build is a choice, and
    // honouring it is the point. Only an absent field means "no opinion".
    api.tags = [{ id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 }];
    const event = api.add({
      typeId: 'bottle', value: 140, startedAt: earlierToday(HOUR), tagIds: ['tag-night'],
    });
    saveForm(formKey(scopeOf(api.userId, BABY.id), `edit:${event.id}`), 'record', {
      startedAt: event.startedAt,
      endedAt: null,
      displayValue: '160',
      note: '',
      metadata: {},
      tagIds: [],
    }, { baseVersion: event.version });

    const user = openSignedIn(`/event/${event.id}`);
    expect(await screen.findByLabelText(valueLabel('bottle'))).toHaveValue('160');
    expect(chip(USER_CONTENT.tag)).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(api.events.find((one) => one.id === event.id)?.value).toBe(160));
    expect(api.events.find((one) => one.id === event.id)?.tagIds).toEqual([]);
  });

  it('does not leave an edit draft behind when the tag answers after saving', async () => {
    // The edit screen has no lock of its own, so whether the picker acts
    // once the screen has gone is the only thing standing between a late
    // answer and a ghost draft -- one carrying the version it was written
    // on, which would be applied the next time this record was opened.
    const { user, event } = await intoTheEdit([]);
    const release = holdTagCreation();

    await user.click(screen.getByTestId('add-tag'));
    await user.type(screen.getByTestId('tag-name'), 'new one');
    await user.click(screen.getByTestId('save-tag'));
    await user.click(screen.getByTestId('submit'));
    await waitForHome();

    release();
    await waitFor(() => expect(api.tags.some((one) => one.id === 'tag-new')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readForm(formKey(scopeOf(api.userId, BABY.id), `edit:${event.id}`))).toBeNull();
  });

  it('keeps what was chosen when somebody else saved first', async () => {
    // The server refuses the whole update -- the body and the tags together
    // -- so nothing of theirs is lost (spec 4.3). This screen must not lose
    // the choice either: being told to look again is not a reason to throw
    // away what was already picked (spec 2.1, 6.3).
    const { user } = await intoTheEdit([]);

    await user.click(chip('daytime'));
    api.nextFailure = { status: 409, code: 'VERSION_CONFLICT' };
    await user.click(screen.getByTestId('submit'));

    expect(await screen.findByText(zhTW.conflict.body)).toBeInTheDocument();
    expect(chip('daytime')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the tag page', () => {
  /** Noon in Taipei on a named September day, so the order is the fixture's. */
  const noonOn = (day: number): number => Date.UTC(2026, 8, day, 4, 0);

  function twoTags(): void {
    api.tags = [
      { id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 },
      { id: 'tag-day', name: 'daytime', createdAt: 0 },
    ];
  }

  async function intoThePage(path = '/tags'): Promise<ReturnType<typeof userEvent.setup>> {
    const user = openSignedIn(path);
    await screen.findByTestId('tag-list');
    return user;
  }

  const row = (name: string): HTMLElement =>
    screen.getAllByTestId('tag-row').find((one) => one.textContent?.includes(name)) as HTMLElement;
  const choose = (name: string): HTMLElement => within(row(name)).getByTestId('tag-choose');

  /** The ids of the records showing, in order, read off their links. */
  function shownIds(): string[] {
    const rows = screen.queryByTestId('tag-result-rows');
    if (!rows) return [];
    return within(rows).getAllByRole('link')
      .map((link) => (link.getAttribute('href') ?? '').replace(/^\/event\//, '').replace(/\?.*$/, ''));
  }

  function filterRequests(): URLSearchParams[] {
    return api.requests
      .filter((entry) => entry.method === 'GET' && entry.query.has('tags'))
      .map((entry) => entry.query);
  }

  it('is in the page list, and says so when it is the page showing', async () => {
    // Spec 7.10 names six pages. Until this stage the tag page was left
    // out rather than listed and dead.
    twoTags();
    const user = await intoThePage();

    await user.click(screen.getByTestId('open-menu'));
    const link = screen.getByRole('link', { name: new RegExp(zhTW.nav.tags) });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveTextContent(zhTW.nav.current);
  });

  it('shows the tags this device has, and says what to do when there are none', async () => {
    twoTags();
    await intoThePage();
    expect(screen.getAllByTestId('tag-row').map((one) => one.textContent)).toEqual(['daytime', USER_CONTENT.tag]);
    closeApp();

    api.tags = [];
    openSignedIn('/tags');
    expect(await screen.findByText(zhTW.tagPage.empty)).toBeInTheDocument();
  });

  it('asks the server for any of the chosen tags, newest first, fifty at a time', async () => {
    twoTags();
    const night = api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });
    const both = api.add({ typeId: 'bottle', startedAt: noonOn(12), tagIds: ['tag-night', 'tag-day'] });
    const day = api.add({ typeId: 'bottle', startedAt: noonOn(11), tagIds: ['tag-day'] });
    api.add({ typeId: 'bottle', startedAt: noonOn(13), tagIds: [] });

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await user.click(choose('daytime'));

    await waitFor(() => expect(shownIds()).toEqual([both.id, day.id, night.id]));
    expect(screen.getByTestId('tag-count')).toHaveTextContent(interpolate(zhTW.tagPage.count, { count: 3 }));
    const last = filterRequests().at(-1);
    expect(last?.get('tags')?.split(',').sort()).toEqual(['tag-day', 'tag-night']);
    expect(last?.get('sort')).toBe('recent');
    expect(last?.get('limit')).toBe('50');
    expect(last?.get('offset')).toBe('0');
    // Said where the choice is made: two tags is "either", not "both".
    expect(screen.getByText(zhTW.tagPage.anyOf)).toBeInTheDocument();
  });

  it('turns round, and keeps to a range, when asked', async () => {
    twoTags();
    const early = api.add({ typeId: 'bottle', startedAt: noonOn(9), tagIds: ['tag-night'] });
    const inside = api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });
    const late = api.add({ typeId: 'bottle', startedAt: noonOn(12), tagIds: ['tag-night'] });

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toEqual([late.id, inside.id, early.id]));

    await user.click(screen.getByTestId('tag-sort-oldest'));
    await waitFor(() => expect(shownIds()).toEqual([early.id, inside.id, late.id]));

    fireEvent.change(screen.getByTestId('tag-from'), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByTestId('tag-to'), { target: { value: '2026-09-11' } });
    await waitFor(() => expect(shownIds()).toEqual([inside.id]));
    const last = filterRequests().at(-1);
    expect(last?.get('from')).toBe('2026-09-10');
    expect(last?.get('to')).toBe('2026-09-11');
    expect(last?.get('sort')).toBe('oldest');

    await user.click(screen.getByTestId('tag-clear-range'));
    await waitFor(() => expect(shownIds()).toHaveLength(3));
  });

  it('pages through a long list, and shows a record once when the list moves between pages', async () => {
    // Offsets are positions in a list other people can change. A record
    // added at the top between two pages pushes the one at the boundary
    // onto the next page as well; shown twice, it would be two records
    // where there is one.
    twoTags();
    for (let i = 0; i < 60; i += 1) {
      api.add({ typeId: 'diaper', startedAt: noonOn(1) + i * HOUR, tagIds: ['tag-night'] });
    }

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    expect(screen.getByTestId('tag-count')).toHaveTextContent(interpolate(zhTW.tagPage.count, { count: 60 }));

    // The other parent, meanwhile, at the top of the list.
    api.add({ typeId: 'diaper', startedAt: noonOn(28), tagIds: ['tag-night'] });

    await user.click(screen.getByTestId('tag-more'));
    await waitFor(() => expect(screen.queryByTestId('tag-more')).not.toBeInTheDocument());
    const ids = shownIds();
    expect(filterRequests().at(-1)?.get('offset')).toBe('50');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(60);
  });

  it('asks again after a sync without shortening what had been loaded', async () => {
    // The list is the server's, so catching up re-asks it. Starting again
    // from fifty would take away the part somebody had scrolled down to.
    twoTags();
    for (let i = 0; i < 60; i += 1) {
      api.add({ typeId: 'diaper', startedAt: noonOn(1) + i * HOUR, tagIds: ['tag-night'] });
    }

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    await user.click(screen.getByTestId('tag-more'));
    await waitFor(() => expect(shownIds()).toHaveLength(60));
    const before = filterRequests().length;

    await user.click(screen.getByTestId('sync-state'));

    await waitFor(() => expect(filterRequests().length).toBeGreaterThan(before));
    expect(filterRequests().at(-1)?.get('offset')).toBe('0');
    expect(filterRequests().at(-1)?.get('limit')).toBe('60');
    await waitFor(() => expect(shownIds()).toHaveLength(60));
  });

  it('retries a failed re-ask from the top, not by fetching the next page', async () => {
    // Found in review: the retry was chosen by whether rows were showing,
    // so a re-ask that failed with the old rows on screen was retried as
    // "more" -- offset 1, the error gone, the old rows never asked again.
    twoTags();
    const first = api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toEqual([first.id]));

    api.failTagged = true;
    await user.click(screen.getByTestId('sync-state'));
    expect(await screen.findByText(zhTW.tagPage.staleList)).toBeInTheDocument();
    // Still the old rows, said to be old.
    expect(shownIds()).toEqual([first.id]);

    api.failTagged = false;
    const second = api.add({ typeId: 'bottle', startedAt: noonOn(11), tagIds: ['tag-night'] });
    const before = filterRequests().length;
    await user.click(screen.getByTestId('tag-retry'));

    // The request the button sent, not whatever the list ends up showing:
    // a later re-ask from the sync machinery can paper over a wrong retry,
    // and did -- the first version of this test passed with the bug in.
    await waitFor(() => expect(filterRequests().length).toBeGreaterThan(before));
    expect(filterRequests()[before]?.get('offset')).toBe('0');
    await waitFor(() => expect(shownIds()).toEqual([second.id, first.id]));
    expect(screen.queryByTestId('tag-failed')).not.toBeInTheDocument();
  });

  it('keeps saying the list is old when more of it is fetched', async () => {
    // Fetching the next page does not make the rows above it fresh.
    twoTags();
    for (let i = 0; i < 55; i += 1) {
      api.add({ typeId: 'diaper', startedAt: noonOn(1) + i * HOUR, tagIds: ['tag-night'] });
    }

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toHaveLength(50));

    api.failTagged = true;
    await user.click(screen.getByTestId('sync-state'));
    await screen.findByText(zhTW.tagPage.staleList);

    api.failTagged = false;
    await user.click(screen.getByTestId('tag-more'));
    await waitFor(() => expect(shownIds()).toHaveLength(55));
    expect(screen.getByText(zhTW.tagPage.staleList)).toBeInTheDocument();
  });

  it('keeps saying the list is old through a "more" that fails and then succeeds', async () => {
    // Found in review: the two failures shared one slot, so a failed
    // "more" overwrote the failed re-ask, and once the retry of "more"
    // succeeded the rows nobody had refreshed were on screen with nothing
    // saying so. Only an ask from the top that succeeds makes them current.
    twoTags();
    for (let i = 0; i < 55; i += 1) {
      api.add({ typeId: 'diaper', startedAt: noonOn(1) + i * HOUR, tagIds: ['tag-night'] });
    }

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toHaveLength(50));

    api.failTagged = true;
    await user.click(screen.getByTestId('tag-refresh'));
    await screen.findByText(zhTW.tagPage.staleList);

    await user.click(screen.getByTestId('tag-more'));
    await screen.findByTestId('tag-more-failed');
    // Both are true at once, and both are said.
    expect(screen.getByText(zhTW.tagPage.staleList)).toBeInTheDocument();

    api.failTagged = false;
    await user.click(screen.getByTestId('tag-more-retry'));
    await waitFor(() => expect(shownIds()).toHaveLength(55));
    expect(screen.queryByTestId('tag-more-failed')).not.toBeInTheDocument();
    expect(screen.getByText(zhTW.tagPage.staleList)).toBeInTheDocument();

    // And the ask from the top that succeeds is what clears it.
    await user.click(screen.getByTestId('tag-retry'));
    await waitFor(() => expect(screen.queryByText(zhTW.tagPage.staleList)).not.toBeInTheDocument());
    expect(shownIds()).toHaveLength(55);
  });

  it('retries a failed "more" as the same page', async () => {
    twoTags();
    for (let i = 0; i < 55; i += 1) {
      api.add({ typeId: 'diaper', startedAt: noonOn(1) + i * HOUR, tagIds: ['tag-night'] });
    }

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toHaveLength(50));

    api.failTagged = true;
    await user.click(screen.getByTestId('tag-more'));
    expect(await screen.findByTestId('tag-more-failed')).toHaveTextContent(zhTW.tagPage.failed);
    expect(shownIds()).toHaveLength(50);

    api.failTagged = false;
    const before = filterRequests().length;
    await user.click(screen.getByTestId('tag-more-retry'));

    await waitFor(() => expect(filterRequests().length).toBeGreaterThan(before));
    expect(filterRequests()[before]?.get('offset')).toBe('50');
    await waitFor(() => expect(shownIds()).toHaveLength(55));
  });

  it('brings back, from the top, a record the offsets skipped', async () => {
    // The limit of spec 7.9's offsets, shown rather than described: a
    // record deleted above the boundary between two pages pulls the next
    // one back past it, and "more" never shows it. Nothing on screen can
    // tell. Asking again from the top can.
    twoTags();
    const written: { id: string }[] = [];
    for (let i = 0; i < 60; i += 1) {
      written.push(api.add({ typeId: 'diaper', startedAt: noonOn(1) + i * HOUR, tagIds: ['tag-night'] }));
    }
    // Newest first, so the fifty-first shown is the tenth written.
    const skipped = written[9];

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toHaveLength(50));

    // The other parent deletes one already on the first page.
    const top = api.events.find((event) => event.id === written[59]?.id);
    if (top) top.deletedAt = Date.now();

    await user.click(screen.getByTestId('tag-more'));
    await waitFor(() => expect(screen.queryByTestId('tag-more')).not.toBeInTheDocument());
    expect(shownIds()).not.toContain(skipped?.id);

    const before = filterRequests().length;
    await user.click(screen.getByTestId('tag-refresh'));

    await waitFor(() => expect(filterRequests().length).toBeGreaterThan(before));
    expect(filterRequests()[before]?.get('offset')).toBe('0');
    await waitFor(() => expect(shownIds()).toContain(skipped?.id));
    expect(shownIds()).toHaveLength(59);
  });

  it('keeps what was chosen when a record is opened and closed again', async () => {
    // The choice is in the address. Held in state, it went with the screen
    // when the record was opened -- and with it the reason for being here.
    twoTags();
    const event = api.add({ typeId: 'bottle', value: 120, startedAt: noonOn(10), tagIds: ['tag-night'] });

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(shownIds()).toEqual([event.id]));

    await user.click(within(screen.getByTestId('tag-result-rows')).getByRole('link'));
    await screen.findByTestId('submit');
    await user.click(screen.getByTestId('submit'));

    await screen.findByTestId('tag-list');
    expect(choose(USER_CONTENT.tag)).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(shownIds()).toEqual([event.id]));
  });

  it('says it could not ask rather than showing an empty list, and asks again', async () => {
    twoTags();
    api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });
    api.failTagged = true;

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));

    expect(await screen.findByTestId('tag-failed')).toBeInTheDocument();
    expect(screen.queryByText(zhTW.tagPage.noResults)).not.toBeInTheDocument();

    api.failTagged = false;
    await user.click(screen.getByTestId('tag-retry'));
    await waitFor(() => expect(shownIds()).toHaveLength(1));
  });

  it('drops an answer to a question that is no longer the one on screen', async () => {
    // Chosen one tag, then another before the first answer came back. The
    // late answer is about a list nobody is looking at; applied, it would
    // put the wrong records under the two chosen tags.
    twoTags();
    api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });
    api.add({ typeId: 'bottle', startedAt: noonOn(11), tagIds: ['tag-day'] });

    const user = await intoThePage();
    const release = api.holdNextTagged();
    await user.click(choose(USER_CONTENT.tag));
    await waitFor(() => expect(filterRequests()).toHaveLength(1));
    await user.click(choose('daytime'));
    await waitFor(() => expect(shownIds()).toHaveLength(2));

    release();
    // The held request has now answered; give it the chance to land.
    await waitFor(() => expect(filterRequests()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shownIds()).toHaveLength(2);
    expect(screen.getByTestId('tag-count')).toHaveTextContent(interpolate(zhTW.tagPage.count, { count: 2 }));
  });

  it('says that a record waiting on this phone is not in the list yet', async () => {
    twoTags();
    api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });
    // Refused for good, so it stays in the queue with its tags.
    api.nextFailure = { status: 429, code: 'DAILY_LIMIT_EXCEEDED' };
    await queueAdd(api.userId, BABY.id, 'queued-1', {
      typeId: 'bottle', intent: 'record', startedAt: earlierToday(HOUR), endedAt: null,
      value: 100, note: '', metadata: {}, tagIds: ['tag-night'],
    });

    const user = await intoThePage();
    await user.click(choose(USER_CONTENT.tag));

    expect(await screen.findByTestId('tag-unsynced'))
      .toHaveTextContent(interpolate(zhTW.tagPage.unsynced, { count: 1 }));
  });

  describe('renaming one', () => {
    it('sends the new name and shows it', async () => {
      twoTags();
      const user = await intoThePage();

      await user.click(within(row('daytime')).getByTestId('tag-manage'));
      const input = screen.getByTestId('tag-rename-input');
      await user.clear(input);
      await user.type(input, USER_CONTENT.otherTag);
      await user.click(screen.getByTestId('tag-rename-save'));

      await waitFor(() => expect(screen.queryByTestId('tag-editor')).not.toBeInTheDocument());
      expect(row(USER_CONTENT.otherTag)).toBeDefined();
      expect(api.lastRequest('/tags/tag-day')?.body).toEqual({ name: USER_CONTENT.otherTag });
      expect(api.tags.find((one) => one.id === 'tag-day')?.name).toBe(USER_CONTENT.otherTag);
    });

    it('says the name is taken, and keeps what was typed', async () => {
      twoTags();
      const user = await intoThePage();

      await user.click(within(row('daytime')).getByTestId('tag-manage'));
      const input = screen.getByTestId('tag-rename-input');
      await user.clear(input);
      await user.type(input, USER_CONTENT.tag);
      await user.click(screen.getByTestId('tag-rename-save'));

      expect(await screen.findByTestId('tag-manage-error')).toHaveTextContent(zhTW.error.TAG_NAME_TAKEN);
      expect(screen.getByTestId('tag-rename-input')).toHaveValue(USER_CONTENT.tag);
      expect(api.tags.find((one) => one.id === 'tag-day')?.name).toBe('daytime');
    });

    it('needs a connection, and sends nothing without one', async () => {
      twoTags();
      const user = await intoThePage();
      goOffline();

      await user.click(within(row('daytime')).getByTestId('tag-manage'));
      await user.type(screen.getByTestId('tag-rename-input'), 's');
      await user.click(screen.getByTestId('tag-rename-save'));

      expect(await screen.findByTestId('tag-manage-error')).toHaveTextContent(zhTW.error.needsConnection);
      expect(patches()).toHaveLength(0);
    });
  });

  describe('deleting one', () => {
    async function intoTheConfirm(name: string): Promise<ReturnType<typeof userEvent.setup>> {
      const user = await intoThePage();
      await user.click(within(row(name)).getByTestId('tag-manage'));
      await user.click(screen.getByTestId('tag-delete'));
      await screen.findByTestId('tag-delete-confirm');
      return user;
    }

    it('says how many records carry it, and what confirming does to them', async () => {
      // Spec 7.9: in use is said, and so is what happens to the records.
      // Counted by the server, because the other parent's records count
      // and this device may not hold them all.
      twoTags();
      for (let i = 0; i < 3; i += 1) api.add({ typeId: 'bottle', startedAt: noonOn(10 + i), tagIds: ['tag-night'] });

      await intoTheConfirm(USER_CONTENT.tag);

      await waitFor(() => expect(screen.getByTestId('tag-delete-impact'))
        .toHaveTextContent(interpolate(zhTW.tagPage.inUse, { count: 3 })));
      expect(screen.getByTestId('tag-delete-yes')).toBeEnabled();
      expect(api.tags).toHaveLength(2);
    });

    it('says when nothing carries it', async () => {
      twoTags();
      await intoTheConfirm('daytime');
      await waitFor(() => expect(screen.getByTestId('tag-delete-impact'))
        .toHaveTextContent(zhTW.tagPage.notInUse));
    });

    it('does not offer the delete until it has said what the delete does', async () => {
      twoTags();
      api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });
      const release = api.holdNextTagged();

      await intoTheConfirm(USER_CONTENT.tag);

      expect(screen.getByTestId('tag-delete-impact')).toHaveTextContent(zhTW.tagPage.checking);
      expect(screen.getByTestId('tag-delete-yes')).toBeDisabled();
      release();
      await waitFor(() => expect(screen.getByTestId('tag-delete-yes')).toBeEnabled());
    });

    it('says it could not count rather than saying nothing carries it', async () => {
      // "Not in use" on a failed request is the worst wrong answer this
      // sheet could give: it is the one that makes deleting look free.
      twoTags();
      api.add({ typeId: 'bottle', startedAt: noonOn(10), tagIds: ['tag-night'] });
      api.failTagged = true;

      await intoTheConfirm(USER_CONTENT.tag);

      await waitFor(() => expect(screen.getByTestId('tag-delete-impact'))
        .toHaveTextContent(zhTW.tagPage.countFailed));
      expect(screen.getByTestId('tag-delete-impact')).not.toHaveTextContent(zhTW.tagPage.notInUse);
      expect(screen.getByTestId('tag-delete-yes')).toBeDisabled();
    });

    it('warns about records still waiting on this phone that carry it', async () => {
      twoTags();
      api.nextFailure = { status: 429, code: 'DAILY_LIMIT_EXCEEDED' };
      await queueAdd(api.userId, BABY.id, 'queued-1', {
        typeId: 'bottle', intent: 'record', startedAt: earlierToday(HOUR), endedAt: null,
        value: 100, note: '', metadata: {}, tagIds: ['tag-night'],
      });

      await intoTheConfirm(USER_CONTENT.tag);

      expect(await screen.findByTestId('tag-delete-waiting'))
        .toHaveTextContent(interpolate(zhTW.tagPage.inUseHere, { count: 1 }));
    });

    it('cancels without sending anything', async () => {
      twoTags();
      const user = await intoTheConfirm('daytime');
      await user.click(screen.getByTestId('tag-delete-cancel'));

      expect(screen.queryByTestId('tag-delete-confirm')).not.toBeInTheDocument();
      expect(api.requests.filter((entry) => entry.method === 'DELETE')).toHaveLength(0);
      expect(api.tags).toHaveLength(2);
    });

    it('deletes it, takes it out of the choice, and the records on this device lose it', async () => {
      // The second half is spec 7.9's warning: the records learn through
      // their revs, so without the sync after the delete this device would
      // go on showing a tag that no longer exists on every record it held.
      twoTags();
      const event = api.add({ typeId: 'bottle', value: 120, startedAt: earlierToday(HOUR), tagIds: ['tag-night'] });

      const user = await intoThePage(`/tags?t=tag-night`);
      await waitFor(() => expect(shownIds()).toEqual([event.id]));
      await user.click(within(row(USER_CONTENT.tag)).getByTestId('tag-manage'));
      await user.click(screen.getByTestId('tag-delete'));
      await waitFor(() => expect(screen.getByTestId('tag-delete-yes')).toBeEnabled());
      await user.click(screen.getByTestId('tag-delete-yes'));

      await waitFor(() => expect(screen.queryByTestId('tag-delete-confirm')).not.toBeInTheDocument());
      expect(screen.getAllByTestId('tag-row').map((one) => one.textContent)).toEqual(['daytime']);
      expect(screen.queryByTestId('tag-results')).not.toBeInTheDocument();
      expect(api.tags.map((one) => one.id)).toEqual(['tag-day']);

      // And on the record itself, read from this device's own copy. Not
      // through the edit form: a selected id with no tag to draw has no
      // chip, so the form looks identical whether the sync happened or not.
      const scope = scopeOf(api.userId, BABY.id);
      await waitFor(async () => expect((await findLocalEvent(scope, event.id))?.tagIds).toEqual([]));
    });

    it('says when the other parent deleted it first, rather than claiming this did', async () => {
      twoTags();
      const user = await intoTheConfirm('daytime');
      await waitFor(() => expect(screen.getByTestId('tag-delete-yes')).toBeEnabled());

      // Gone on the server meanwhile.
      api.tags = api.tags.filter((one) => one.id !== 'tag-day');
      await user.click(screen.getByTestId('tag-delete-yes'));

      expect(await screen.findByTestId('tag-gone')).toHaveTextContent(zhTW.tagPage.gone);
      await waitFor(() => expect(screen.getAllByTestId('tag-row').map((one) => one.textContent))
        .toEqual([USER_CONTENT.tag]));
    });
  });
});

describe('a tag on a record that no longer exists', () => {
  // The server refuses a tag the baby does not have. A record written with
  // one that has since been deleted is refused for good -- and before the
  // picker drew such a tag, its correction form had nothing to tap to take
  // it off, so abandoning the record was the only way out.

  it('can be taken off in the correction form, which then sends under the same id', async () => {
    api.tags = [{ id: 'tag-day', name: 'daytime', createdAt: 0 }];
    await queueAdd(api.userId, BABY.id, 'queued-1', {
      typeId: 'bottle', intent: 'record', startedAt: earlierToday(HOUR), endedAt: null,
      value: 100, note: USER_CONTENT.note, metadata: {}, tagIds: ['tag-gone', 'tag-day'],
    });

    const user = openSignedIn('/');
    await waitForHome();
    // Sent, and refused: the tag is gone.
    await user.click(await screen.findByTestId('unsynced-count'));
    await user.click(await screen.findByTestId('unsynced-correct'));

    const gone = await screen.findByTestId('tag-missing');
    expect(gone).toHaveTextContent(zhTW.addEvent.tagMissing);
    expect(gone).toBeEnabled();
    await user.click(gone);
    expect(screen.queryByTestId('tag-missing')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    // The same record, everything else as it was.
    expect(api.events[0]).toMatchObject({
      id: 'queued-1', value: 100, note: USER_CONTENT.note, tagIds: ['tag-day'],
    });
  });

  it('is shown and left alone on an edit, until somebody takes it off', async () => {
    api.tags = [{ id: 'tag-day', name: 'daytime', createdAt: 0 }];
    // A record that synced carrying a tag this device has not heard of.
    api.add({ typeId: 'bottle', value: 140, startedAt: earlierToday(HOUR), tagIds: ['tag-gone'] });

    const user = openSignedIn();
    await waitForHome();
    await user.click(screen.getByRole('link', {
      name: interpolate(zhTW.event.open, { name: eventTypeName('bottle') }),
    }));
    await user.click(await screen.findByTestId('tag-missing'));
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toMatchObject({ tagIds: [] });
  });

  it('cannot be taken off while it is unknown whether the record arrived', async () => {
    // What went out is the queue's until the doubt is settled; editing it
    // now would send a different record under the same id (spec 6.1).
    api.tags = [{ id: 'tag-night', name: USER_CONTENT.tag, createdAt: 0 }];
    api.loseNextResponse = true;
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getAllByTestId('tag-chip')[0] as HTMLElement);
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('outcome-unknown');

    // Deleted meanwhile, and this device has heard so.
    closeApp();
    api.tags = [];
    openSignedIn('/add/bottle');

    const gone = await screen.findByTestId('tag-missing');
    expect(screen.getByTestId('outcome-unknown')).toBeInTheDocument();
    expect(gone).toBeDisabled();
  });
});

describe('the list of records that would not send', () => {
  /** A refusal the server could only give for something it has not stored. */
  const REFUSED = {
    status: 422,
    code: 'VALIDATION_FAILED',
    fields: [{ field: 'value', code: 'OUT_OF_RANGE', params: { min: 0, max: 500 } }],
  };

  async function refusedBottle(): Promise<ReturnType<typeof userEvent.setup>> {
    api.nextFailure = REFUSED;
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.click(screen.getByTestId('submit'));
    await screen.findByTestId('form-error');
    return user;
  }

  it('keeps what the server refused rather than dropping it', async () => {
    await refusedBottle();

    // It is a record somebody wrote by hand. Giving up on sending it is
    // not the same as being allowed to throw it away (spec 6.1).
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();

    await next.click(await screen.findByTestId('unsynced-count'));
    expect(await screen.findByTestId('unsynced-state')).toHaveTextContent(zhTW.unsynced.failed);
  });

  it('says what the server answered', async () => {
    await refusedBottle();
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();
    await next.click(await screen.findByTestId('unsynced-count'));

    expect(await screen.findByTestId('unsynced-retry')).toBeInTheDocument();
    expect(screen.getByText(
      interpolate(zhTW.unsynced.lastResponse, { message: zhTW.error.VALIDATION_FAILED }),
    )).toBeInTheDocument();
  });

  it('sends a correction under the same id, so it cannot become a second event', async () => {
    await refusedBottle();
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();

    await next.click(await screen.findByTestId('unsynced-count'));
    await next.click(await screen.findByTestId('unsynced-correct'));

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    expect(amount).toHaveValue('150');
    await next.clear(amount);
    await next.type(amount, '100');
    await next.click(screen.getByTestId('submit'));

    await waitForHome();
    expect(api.events).toHaveLength(1);
    expect(api.events[0]?.value).toBe(100);

    const sent = api.requests.filter((e) => e.method === 'POST' && e.path.endsWith('/events'));
    const ids = new Set(sent.map((e) => (e.body as Record<string, unknown>)['id']));
    expect(ids.size).toBe(1);
    await waitFor(() => expect(screen.queryByTestId('unsynced-count')).not.toBeInTheDocument());
  });

  it('can be told to try again by hand', async () => {
    await refusedBottle();
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();
    await next.click(await screen.findByTestId('unsynced-count'));

    await next.click(await screen.findByTestId('unsynced-retry'));

    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.value).toBe(150);
  });

  it('is not sent twice when a retry by hand and the queue overlap', async () => {
    await refusedBottle();
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();
    await next.click(await screen.findByTestId('unsynced-count'));

    // The hand retry is still in the air when the connection coming back
    // sets the queue going too. Both of them want this entry, and a queue
    // that let them both have it would send the same record twice.
    const release = api.holdNextWrite();
    await next.click(await screen.findByTestId('unsynced-retry'));
    window.dispatchEvent(new Event('online'));
    release();

    await waitFor(() => expect(api.events).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('unsynced-retry')).not.toBeInTheDocument());

    // One for the refusal that started this, one for the retry. A third
    // would be the queue sending what the retry had already sent.
    const sent = api.requests.filter((e) => e.method === 'POST' && e.path.endsWith('/events'));
    expect(sent).toHaveLength(2);
  });

  it('gives up without claiming the server does not have it', async () => {
    await refusedBottle();
    closeApp();
    const next = openSignedIn('/');
    await waitForHome();
    await next.click(await screen.findByTestId('unsynced-count'));

    await next.click(await screen.findByTestId('unsynced-abandon'));

    // Giving up stops this phone trying. It says nothing about the server,
    // and the words on screen must not either (spec 6.1).
    expect(screen.getByText(zhTW.unsynced.abandonBody)).toBeInTheDocument();
    await next.click(screen.getByTestId('abandon-confirm'));

    expect(await screen.findByText(zhTW.unsynced.empty)).toBeInTheDocument();

    closeApp();
    openSignedIn('/');
    await waitForHome();
    expect(screen.queryByTestId('unsynced-count')).not.toBeInTheDocument();
  });
});

describe('stopping a timer with no signal', () => {
  /** A sleep that has been running for two hours, as the summary reports it. */
  function running(): { id: string; version: number } {
    const event = api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(2 * HOUR) });
    return { id: event.id, version: event.version };
  }

  it('keeps the moment the button was pressed, and sends nothing', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    const before = Date.now();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    const after = Date.now();

    // Ended here, and visibly not yet a record. Refusing outright is what
    // makes the sleep half an hour too long (spec 7.2).
    expect(await screen.findByTestId('timer-drafted-sleep')).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
    expect(api.find(sleep.id)?.active).toBe(true);

    // And the list says the same thing rather than still claiming it is
    // running.
    expect(screen.getByTestId('event-row-sleep')).toHaveTextContent(zhTW.stopDraft.badge);
    expect(screen.getByTestId('event-row-sleep')).not.toHaveTextContent(zhTW.event.inProgress);

    // The moment itself survives a reload, because it is the only thing
    // here that cannot be worked out again later.
    closeApp();
    openSignedIn(`/stop/${sleep.id}`);
    setOnline(true);
    // The instant, as the app renders instants. What matters is that it is
    // the one from the press and not one worked out afterwards.
    const pressed = await screen.findByTestId('pressed-at');
    expect(pressed).toHaveTextContent(formatClock(before, BABY.timezone));
    expect(after - before).toBeLessThan(60_000);
  });

  it('sends the time it was pressed, not the time it was confirmed', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    const before = Date.now();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    const after = Date.now();
    await screen.findByTestId('timer-drafted-sleep');

    comeBack();
    // Long enough that confirming with "now" would be plainly different
    // from pressing with "now".
    await new Promise((resolve) => setTimeout(resolve, 40));

    await user.click(screen.getByTestId('timer-drafted-sleep'));
    await user.click(await screen.findByTestId('submit'));

    await waitFor(() => expect(api.find(sleep.id)?.active).toBe(false));

    const sent = api.lastRequest(`/events/${sleep.id}`)?.body as Record<string, unknown>;
    expect(Number(sent['endedAt'])).toBeGreaterThanOrEqual(before);
    expect(Number(sent['endedAt'])).toBeLessThanOrEqual(after);

    // And it stops being something to confirm. A moment left behind after
    // it has been sent would keep asking to be dealt with for ever.
    await waitForHome();
    await waitFor(() => expect(screen.queryByTestId('stop-drafts')).not.toBeInTheDocument());
    expect(screen.queryByTestId('timer-drafted-sleep')).not.toBeInTheDocument();
  });

  it('carries the version the server holds now, not the one from before', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-drafted-sleep');

    // The other parent corrects the start time while this phone has no
    // signal. Sending the version from before would collect a 409 for
    // something that is not a conflict at all (spec 6.3).
    const event = api.find(sleep.id);
    if (event) Object.assign(event, { version: event.version + 1, rev: api.nextRev() });

    comeBack();
    await user.click(screen.getByTestId('timer-drafted-sleep'));

    // And it says so, because that is the reason this is confirmed by a
    // person rather than sent automatically (spec 7.2).
    expect(await screen.findByTestId('changed-since')).toBeInTheDocument();

    await user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(api.find(sleep.id)?.active).toBe(false));

    const sent = api.lastRequest(`/events/${sleep.id}`)?.body as Record<string, unknown>;
    expect(sent['version']).toBe(sleep.version + 1);
  });

  it('stops asking once it has been confirmed at a time that was adjusted', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-drafted-sleep');

    comeBack();
    await user.click(screen.getByTestId('timer-drafted-sleep'));

    // Confirming does not mean accepting: the screen is there to be
    // corrected. A minute earlier than the press, still after the start.
    const adjusted = Date.now() - 60_000;
    fireEvent.change(await screen.findByTestId('ended-at'), {
      target: { value: toLocalInput(adjusted, BABY.timezone) },
    });
    await user.click(screen.getByTestId('submit'));

    await waitFor(() => expect(api.find(sleep.id)?.active).toBe(false));
    expect(api.find(sleep.id)?.endedAt).toBe(fromLocalInput(
      toLocalInput(adjusted, BABY.timezone), BABY.timezone,
    ));

    // And it is done with. The moment on the device no longer matches what
    // the server holds, so nothing else would have cleared it.
    await waitForHome();
    await waitFor(() => expect(screen.queryByTestId('stop-drafts')).not.toBeInTheDocument());
    expect(screen.queryByTestId('timer-drafted-sleep')).not.toBeInTheDocument();
  });

  it('says when the other parent has already ended it, and offers to keep theirs', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-drafted-sleep');

    const theirEnd = Date.now();
    const event = api.find(sleep.id);
    if (event) {
      Object.assign(event, {
        endedAt: theirEnd, active: false, version: event.version + 1, rev: api.nextRev(),
      });
    }

    comeBack();
    await user.click(screen.getByTestId('timer-drafted-sleep'));

    expect(await screen.findByTestId('already-ended')).toBeInTheDocument();

    // Keeping theirs throws away this device's moment and sends nothing:
    // there is nothing to undo, because the server never heard about it.
    await user.click(screen.getByTestId('discard'));
    await user.click(screen.getByTestId('discard-confirm'));

    await waitForHome();
    expect(patches()).toHaveLength(0);
    expect(api.find(sleep.id)?.endedAt).toBe(theirEnd);
    expect(screen.queryByTestId('stop-drafts')).not.toBeInTheDocument();
  });

  it('cannot be confirmed while there is still no signal', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await user.click(await screen.findByTestId('timer-drafted-sleep'));

    // Confirming means reading what the server holds now, and there is no
    // way to do that. What must not happen is the moment being lost for
    // trying.
    expect(await screen.findByTestId('confirm-blocked')).toHaveTextContent(zhTW.stopDraft.offline);
    expect(screen.getByTestId('pressed-at')).toBeInTheDocument();
    expect(patches()).toHaveLength(0);

    closeApp();
    setOnline(true);
    openSignedIn();
    await waitForHome();
    expect(await screen.findByTestId('timer-drafted-sleep')).toBeInTheDocument();
    expect(api.find(sleep.id)?.active).toBe(true);
  });

  it('leaves the timer running when the moment is thrown away', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-drafted-sleep');

    comeBack();
    await user.click(screen.getByTestId('timer-drafted-sleep'));
    await user.click(await screen.findByTestId('discard'));
    await user.click(screen.getByTestId('discard-confirm'));

    await waitForHome();
    // Back to a timer with a stop button, and the server never heard a
    // thing about any of it.
    expect(await screen.findByRole('button', { name: zhTW.timer.stop })).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
    expect(api.find(sleep.id)?.active).toBe(true);
  });

  it('is not offered to a different account on the same phone', async () => {
    running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-drafted-sleep');

    closeApp();
    setOnline(true);
    server.resetHandlers();
    signedInAs('the-other-parent');
    openSignedIn();
    await waitForHome();

    // Their phone, their account: this timer is still running as far as
    // they are concerned, and somebody else's unsent moment is not theirs
    // to confirm (spec 6.1).
    expect(screen.queryByTestId('timer-drafted-sleep')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stop-drafts')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: zhTW.timer.stop })).toBeInTheDocument();
  });

  it('keeps the moment when the phone has a signal but the server does not answer', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    // Wi-Fi is up and `navigator.onLine` says so. The worker has stopped,
    // or there is a captive portal, or the reply is lost on the way back:
    // from here they all look like a healthy phone, and every one of them
    // is the three-in-the-morning case spec 7.2 is about.
    server.use(http.patch('/api/events/:eventId', () => HttpResponse.error()));
    const before = Date.now();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    const after = Date.now();

    expect(await screen.findByTestId('timer-error')).toBeInTheDocument();
    expect(await screen.findByTestId('timer-drafted-sleep')).toBeInTheDocument();

    // And it is the moment that was pressed, not one worked out when the
    // server came back.
    server.resetHandlers();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await user.click(screen.getByTestId('timer-drafted-sleep'));
    await user.click(await screen.findByTestId('submit'));

    await waitFor(() => expect(api.find(sleep.id)?.active).toBe(false));
    const sent = api.lastRequest(`/events/${sleep.id}`)?.body as Record<string, unknown>;
    expect(Number(sent['endedAt'])).toBeGreaterThanOrEqual(before);
    expect(Number(sent['endedAt'])).toBeLessThanOrEqual(after);
  });

  it('does not resend the stop by itself once the server answers again', async () => {
    running();
    const user = openSignedIn();
    await waitForHome();

    server.use(http.patch('/api/events/:eventId', () => HttpResponse.error()));
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-drafted-sleep');

    const tried = patches().length;
    comeBack();
    await waitFor(() => expect(api.requests.some((e) => e.path.endsWith('/summary'))).toBe(true));

    // The other parent may have touched the timer while this phone could
    // not reach anything, so it waits to be confirmed rather than firing
    // the same update again (spec 7.2, 6.3).
    expect(patches()).toHaveLength(tried);
    expect(screen.getByTestId('timer-drafted-sleep')).toBeInTheDocument();
  });

  it('stops asking when the stop reached the server but the answer was lost', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    // Recorded, and the client never hears so.
    api.loseNextResponse = true;
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));

    await screen.findByTestId('timer-error');
    expect(api.find(sleep.id)?.active).toBe(false);

    // The next pull brings back an event already ending at exactly the
    // instant this phone is holding. The server's state is what the draft
    // was asking for, so there is nothing left to ask -- and saying
    // another family member did it would be a plain untruth.
    await waitFor(() => expect(screen.queryByTestId('timer-drafted-sleep')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('stop-drafts')).not.toBeInTheDocument());
    expect(screen.queryByTestId('already-ended')).not.toBeInTheDocument();
  });

  it('is left alone by an edit that has nothing to do with it', async () => {
    const sleep = running();
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    await screen.findByTestId('timer-drafted-sleep');

    comeBack();

    // The timer is still running as far as the server is concerned. Going
    // into the event to correct its note says nothing about when it ended,
    // and answering the draft with it would throw the moment away and
    // leave the timer running with nothing left to end it by.
    await user.click(screen.getByRole('link', {
      name: interpolate(zhTW.event.open, { name: eventTypeName('sleep') }),
    }));
    const note = await screen.findByLabelText(zhTW.addEvent.note);
    await user.type(note, USER_CONTENT.note);
    await user.click(screen.getByTestId('submit'));

    await waitForHome();
    expect(api.find(sleep.id)?.note).toBe(USER_CONTENT.note);
    expect(api.find(sleep.id)?.active).toBe(true);
    expect(await screen.findByTestId('timer-drafted-sleep')).toBeInTheDocument();
    expect(screen.getByTestId('stop-drafts')).toBeInTheDocument();
  });

  it('still refuses an ordinary edit, which has no moment worth keeping', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '160');

    goOffline();
    await user.click(screen.getByTestId('submit'));

    // The draft exists for one thing only: the instant a timer was
    // stopped, which cannot be reconstructed later. An amount can
    // (spec 7.2).
    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.error.needsConnection);
    expect(api.find(event.id)?.value).toBe(140);
  });
});

describe('taking a new version', () => {
  it('offers it rather than reloading under whoever is holding the phone', async () => {
    openSignedIn();
    await waitForHome();

    // What the service worker reports when a new build has installed and
    // is waiting. Nothing has happened to the screen.
    let applied = 0;
    offerUpdate(() => { applied += 1; });

    const strip = await screen.findByTestId('update-available');
    expect(strip).toHaveTextContent(zhTW.update.available);
    expect(applied).toBe(0);
    expect(screen.getByText(zhTW.home.lastFeed)).toBeInTheDocument();
  });

  it('takes it when asked', async () => {
    const user = openSignedIn();
    await waitForHome();

    let applied = 0;
    offerUpdate(() => { applied += 1; });
    await user.click(await screen.findByTestId('update-available'));

    expect(applied).toBe(1);
  });

  it('notices a build the service worker has not gone looking for', async () => {
    // A phone that has been open since Tuesday: the worker has no reason
    // to check, and the API is now serving something else (spec 2.1).
    api.serverVersion = 'something-newer';
    openSignedIn();
    await waitForHome();

    expect(await screen.findByTestId('update-available')).toBeInTheDocument();
  });

  it('says nothing when the API is serving the build that is running', async () => {
    openSignedIn();
    await waitForHome();
    await waitFor(() =>
      expect(api.requests.some((entry) => entry.path === '/api/version')).toBe(true),
    );

    expect(screen.queryByTestId('update-available')).not.toBeInTheDocument();
  });

  it('waits for the worker rather than reloading into the same old bundle', async () => {
    const user = openSignedIn();
    await waitForHome();

    let reloaded = 0;
    let activated = 0;

    // The API says this build is behind before the worker has found
    // anything. All that offer can do is reload.
    offerUpdate(() => { reloaded += 1; }, 'version');
    await screen.findByTestId('update-available');

    // Then the worker finishes installing the new build.
    offerUpdate(() => { activated += 1; }, 'worker');
    await user.click(screen.getByTestId('update-available'));

    // A reload while the old worker is still in control is served from
    // its cache and comes back exactly as old, with the new one still
    // waiting -- so the strip would reappear and pressing it would go on
    // doing nothing.
    expect(activated).toBe(1);
    expect(reloaded).toBe(0);
  });

  it('does not let a later version signal take the worker’s place', async () => {
    const user = openSignedIn();
    await waitForHome();

    let reloaded = 0;
    let activated = 0;
    offerUpdate(() => { activated += 1; }, 'worker');
    offerUpdate(() => { reloaded += 1; }, 'version');

    await user.click(await screen.findByTestId('update-available'));

    expect(activated).toBe(1);
    expect(reloaded).toBe(0);
  });

  it('sets the worker looking when the API says the build is behind', async () => {
    let checks = 0;
    setWorkerCheck(() => { checks += 1; });

    api.serverVersion = 'something-newer';
    openSignedIn();
    await waitForHome();

    // So that by the time anybody presses the strip, the offer behind it
    // is usually one that can actually activate the new build.
    await waitFor(() => expect(checks).toBeGreaterThan(0));
  });

  it('says nothing when it cannot ask', async () => {
    server.use(http.get('/api/version', () => HttpResponse.error()));
    openSignedIn();
    await waitForHome();

    // Being unable to reach the server says nothing about new builds, and
    // a strip that appeared every time the signal dropped would be noise.
    expect(screen.queryByTestId('update-available')).not.toBeInTheDocument();
  });
});

describe('a reload, whoever asked for it', () => {
  /** Closes the app and opens it again, which is what taking an update does. */
  async function reload(path = '/'): Promise<ReturnType<typeof userEvent.setup>> {
    closeApp();
    const next = openSignedIn(path);
    await waitForHome();
    return next;
  }

  it('keeps what was being typed into the add form', async () => {
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);

    // Spec 2.1 names this one outright: an update arrives while somebody
    // is filling in a feed, and taking it must not empty the form.
    closeApp();
    openSignedIn('/add/bottle');

    expect(await screen.findByLabelText(valueLabel('bottle'))).toHaveValue('150');
    expect(screen.getByLabelText(zhTW.addEvent.note)).toHaveValue(USER_CONTENT.note);
  });

  it('keeps the timer or record choice with it', async () => {
    const user = openSignedIn('/add/sleep');
    await user.click(await screen.findByRole('button', { name: zhTW.addEvent.record }));

    closeApp();
    openSignedIn('/add/sleep');

    // The intent decides whether this occupies the type's single running
    // slot, so coming back as the other one is a different record
    // (spec 3.5).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: zhTW.addEvent.record }))
        .toHaveStyle({ fontWeight: '700' }),
    );
  });

  it('keeps what was being typed into an edit', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '160');

    closeApp();
    openSignedIn(`/event/${event.id}`);

    expect(await screen.findByLabelText(valueLabel('bottle'))).toHaveValue('160');
    expect(api.find(event.id)?.value).toBe(140);
  });

  it('does not offer the form back once the queue has the content', async () => {
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);

    // The update is taken while the save is still in the air: the queue
    // holds the content and that request will never answer, because a
    // reload takes the whole page with it. It is deliberately never
    // released -- letting it finish would run the code from the screen
    // that no longer exists, and that code clears the draft, so the test
    // would pass whether or not any of this works.
    api.holdNextWrite();
    void user.click(screen.getByTestId('submit'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    closeApp();

    // Back on the home screen, the queue resends what it is holding and
    // gets an answer this time.
    const next = openSignedIn('/');
    await waitForHome();
    await waitFor(() => expect(api.events).toHaveLength(1));

    // Now the form is opened again. There is no queued entry left to take
    // over, so anything offered here would go out under a *new* id -- a
    // second copy of a feed that has already been recorded, and one that
    // nothing could deduplicate (spec 3.8).
    await next.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await next.click(await screen.findByRole('link', {
      name: eventTypeName('bottle'),
    }));
    await screen.findByLabelText(valueLabel('bottle'));
    expect(screen.getByLabelText(zhTW.addEvent.note)).toHaveValue('');
    expect(api.events).toHaveLength(1);
  });

  it('keeps what was typed when the hand-over to the queue fails', async () => {
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);

    // The queue write itself fails -- storage refused, or the tab went
    // away before the transaction committed. The draft was marked as
    // being handed over a moment earlier, and nothing anywhere holds the
    // content.
    const broken = new Error('IndexedDB is unavailable');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function refuse(): never { throw broken; };
    try {
      await user.click(screen.getByTestId('submit'));
      await screen.findByTestId('form-error');
    } finally {
      IDBObjectStore.prototype.put = put;
    }

    expect(posts()).toHaveLength(0);

    // Opening it again must hand the typing back. Treating "was being
    // handed over" as "has been handed over" left it in neither the queue
    // nor the form, which is the record simply gone.
    closeApp();
    openSignedIn('/add/bottle');
    await screen.findByLabelText(valueLabel('bottle'));
    expect(screen.getByLabelText(zhTW.addEvent.note)).toHaveValue(USER_CONTENT.note);
  });

  it('lets the next press try again when the hand-over failed', async () => {
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);

    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function refuse(): never {
      throw new Error('IndexedDB is unavailable');
    };
    try {
      await user.click(screen.getByTestId('submit'));
      await screen.findByTestId('form-error');
    } finally {
      IDBObjectStore.prototype.put = put;
    }

    // Straight back at it, without reloading. Having *tried* to hand the
    // content over is not the same as the queue having taken it, and a
    // screen that counted the attempt would decide this had been sent in
    // the background -- clearing the form and walking off to an event
    // that was never created.
    await user.click(screen.getByTestId('submit'));

    await waitForHome();
    await waitFor(() => expect(api.events).toHaveLength(1));
    expect(api.events[0]?.note).toBe(USER_CONTENT.note);
  });

  it('sends a recovered draft under the id it was going out as', async () => {
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');

    // Marked as being handed over, and then nothing: the same state the
    // tab closing mid-transaction leaves behind.
    const scope = scopeOf(api.userId, BABY.id);
    const key = formKey(scope, 'add:bottle:');
    const held = readForm(key);
    saveForm(key, held?.intent ?? 'record', { ...held!.draft, tagIds: held!.draft.tagIds ?? [] }, {
      eventId: 'half-sent-id',
    });

    closeApp();
    const next = openSignedIn('/add/bottle');
    await screen.findByLabelText(valueLabel('bottle'));
    await next.click(screen.getByTestId('submit'));
    await waitForHome();

    // Under the id it was already going out as. Inventing a new one here
    // is how a hand-over that did land, somewhere this device could not
    // see, becomes two records (spec 3.8).
    const sent = posts()[0]?.body as Record<string, unknown>;
    expect(sent['id']).toBe('half-sent-id');
  });

  it('does not let a restored edit overwrite what somebody else saved', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    // This phone is part way through changing the note, on version one.
    await screen.findByLabelText(valueLabel('bottle'));
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);

    // The other one changes the amount and saves. Version two.
    const stored = api.find(event.id);
    if (stored) {
      Object.assign(stored, { value: 150, version: stored.version + 1, rev: api.nextRev() });
    }

    closeApp();
    const next = openSignedIn(`/event/${event.id}`);
    await screen.findByLabelText(valueLabel('bottle'));
    await next.click(screen.getByTestId('submit'));

    // The restored fields are the ones from version one, including an
    // amount of 140. Sending them against version two would put 140 back
    // over the 150 and the server would accept it, because the number it
    // was handed was current (spec 6.3).
    expect(await screen.findByText(zhTW.error.VERSION_CONFLICT)).toBeInTheDocument();
    expect(api.find(event.id)?.value).toBe(150);
  });

  /** What the build before this one left behind: fields, no base version. */
  function leaveStaleDraft(event: { id: string; startedAt: number }): void {
    saveForm(formKey(scopeOf(api.userId, BABY.id), `edit:${event.id}`), 'record', {
      startedAt: event.startedAt,
      endedAt: null,
      displayValue: '140',
      note: USER_CONTENT.note,
      tagIds: [],
      metadata: {},
    });
  }

  it('does not apply an edit draft that cannot say which version it was written on', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    leaveStaleDraft(event);

    const stored = api.find(event.id);
    if (stored) {
      Object.assign(stored, { value: 150, version: stored.version + 1, rev: api.nextRev() });
    }

    const user = openSignedIn(`/event/${event.id}`);
    const amount = await screen.findByLabelText(valueLabel('bottle'));

    // The stored event fills the fields, not the draft: applied against
    // this version it would put 140 back over the 150 and be accepted
    // (spec 6.3).
    expect(amount).toHaveValue('150');
    expect(screen.getByLabelText(zhTW.addEvent.note)).toHaveValue('');

    await user.click(screen.getByTestId('submit'));
    await waitForHome();
    expect(api.find(event.id)?.value).toBe(150);
  });

  it('shows it instead of throwing it away', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    leaveStaleDraft(event);

    openSignedIn(`/event/${event.id}`);

    // Refusing to apply it is one half of spec 2.1; deleting it without a
    // word would be the other half broken to fix the first.
    const panel = await screen.findByTestId('stale-draft');
    expect(panel).toHaveTextContent(USER_CONTENT.note);
    expect(panel).toHaveTextContent('140');
  });

  it('is not disturbed by typing into the form below it', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    leaveStaleDraft(event);

    const user = openSignedIn(`/event/${event.id}`);
    await screen.findByTestId('stale-draft');

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '175');

    // Two different things: one is being typed, the other is being read
    // from. Sharing a place to keep them means every keystroke overwrites
    // what is on display.
    closeApp();
    openSignedIn(`/event/${event.id}`);

    expect(await screen.findByTestId('stale-draft')).toHaveTextContent(USER_CONTENT.note);
    expect(screen.getByLabelText(valueLabel('bottle'))).toHaveValue('175');
  });

  it('does not take what is being typed with it when it is dismissed', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    leaveStaleDraft(event);

    const user = openSignedIn(`/event/${event.id}`);
    await screen.findByTestId('stale-draft');

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '175');
    await user.click(screen.getByTestId('stale-draft-dismiss'));

    // Being done with the old one says nothing about the new one.
    closeApp();
    openSignedIn(`/event/${event.id}`);

    expect(await screen.findByLabelText(valueLabel('bottle'))).toHaveValue('175');
    expect(screen.queryByTestId('stale-draft')).not.toBeInTheDocument();
  });

  it('forgets it when the parent says they are done with it', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    leaveStaleDraft(event);

    const user = openSignedIn(`/event/${event.id}`);
    await user.click(await screen.findByTestId('stale-draft-dismiss'));
    expect(screen.queryByTestId('stale-draft')).not.toBeInTheDocument();

    closeApp();
    openSignedIn(`/event/${event.id}`);
    await screen.findByLabelText(valueLabel('bottle'));
    expect(screen.queryByTestId('stale-draft')).not.toBeInTheDocument();
  });

  it('saves a restored edit normally when nobody else touched it', async () => {
    const event = api.add({ typeId: 'bottle', value: 140 });
    const user = openSignedIn(`/event/${event.id}`);

    const amount = await screen.findByLabelText(valueLabel('bottle'));
    await user.clear(amount);
    await user.type(amount, '160');

    closeApp();
    const next = openSignedIn(`/event/${event.id}`);
    await screen.findByLabelText(valueLabel('bottle'));
    await next.click(screen.getByTestId('submit'));

    await waitForHome();
    expect(api.find(event.id)?.value).toBe(160);
  });

  it('forgets it once it has been saved', async () => {
    const user = openSignedIn('/add/bottle');
    await user.type(await screen.findByLabelText(valueLabel('bottle')), '150');
    await user.type(screen.getByLabelText(zhTW.addEvent.note), USER_CONTENT.note);
    await user.click(screen.getByTestId('submit'));
    await waitForHome();

    closeApp();
    openSignedIn('/add/bottle');

    // The note, not the amount: the form offers the last amount back on
    // purpose, so a restored draft and a fresh form look the same there.
    // It is a record now, and offering the note again would invite a
    // second bottle carrying the same words.
    await screen.findByLabelText(valueLabel('bottle'));
    expect(screen.getByLabelText(zhTW.addEvent.note)).toHaveValue('');
  });

  it('keeps the queue of records that have not been sent', async () => {
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));
    await waitForHome();
    expect(await screen.findByTestId('unsynced-count')).toBeInTheDocument();

    // The queue is in IndexedDB rather than in the page, which is what
    // makes an update survivable at all (spec 6.2).
    setOnline(true);
    server.resetHandlers();
    await reload();

    expect(await screen.findByTestId('unsynced-count')).toBeInTheDocument();
    await waitFor(() => expect(api.events).toHaveLength(1));
  });

  it('keeps the moment a timer was stopped at', async () => {
    const sleep = api.add({ typeId: 'sleep', active: true, startedAt: earlierToday(2 * HOUR) });
    const user = openSignedIn();
    await waitForHome();

    goOffline();
    const before = Date.now();
    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));
    const after = Date.now();
    await screen.findByTestId('timer-drafted-sleep');

    setOnline(true);
    server.resetHandlers();
    const next = await reload();

    expect(await screen.findByTestId('timer-drafted-sleep')).toBeInTheDocument();
    await next.click(screen.getByTestId('timer-drafted-sleep'));
    await next.click(await screen.findByTestId('submit'));

    await waitFor(() => expect(api.find(sleep.id)?.active).toBe(false));
    const sent = api.lastRequest(`/events/${sleep.id}`)?.body as Record<string, unknown>;
    expect(Number(sent['endedAt'])).toBeGreaterThanOrEqual(before);
    expect(Number(sent['endedAt'])).toBeLessThanOrEqual(after);
  });
});

describe('an iPhone used from a Safari tab', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
  const REAL_AGENT = navigator.userAgent;

  function pretendIPhone(standalone: boolean): void {
    Object.defineProperty(navigator, 'userAgent', { value: IPHONE, configurable: true });
    Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
  }

  // Both are defined on the navigator itself and outlive the test that
  // set them. Left in place, the last iPhone case decides what the next
  // test is running on -- which is how "leaves every other phone alone"
  // came to pass while looking at an iPhone already on its home screen.
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: REAL_AGENT, configurable: true });
    Object.defineProperty(navigator, 'standalone', { value: undefined, configurable: true });
  });

  it('is asked to put the app on the home screen', async () => {
    pretendIPhone(false);
    openSignedIn();
    await waitForHome();

    // Seven days in a tab and the storage goes, taking unsent records with
    // it. On the home screen it is exempt (spec 9.6).
    expect(screen.getByTestId('install-hint')).toBeInTheDocument();
  });

  it('is not asked twice', async () => {
    pretendIPhone(false);
    const user = openSignedIn();
    await waitForHome();

    await user.click(screen.getByTestId('install-hint-dismiss'));
    expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument();

    closeApp();
    openSignedIn();
    await waitForHome();
    expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument();
  });

  it('is not asked once it is already on the home screen', async () => {
    pretendIPhone(true);
    openSignedIn();
    await waitForHome();

    expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument();
  });

  it('leaves every other phone alone', async () => {
    openSignedIn();
    await waitForHome();

    expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument();
  });
});

describe('the settings page', () => {
  async function openSettings(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = openSignedIn();
    await waitForHome();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.openSettings }));
    await screen.findByText(zhTW.settings.membersSection);
    return user;
  }

  it('changes the baby’s details and shows them', async () => {
    const user = await openSettings();

    const nickname = screen.getByLabelText(zhTW.baby.nickname);
    await user.clear(nickname);
    await user.type(nickname, USER_CONTENT.note);
    await user.click(screen.getByTestId('save-baby'));

    const sent = api.lastRequest('/api/babies/baby-1')?.body as Record<string, unknown>;
    expect(sent['nickname']).toBe(USER_CONTENT.note);

    // The name on the home screen comes from the account description, so
    // it only changes once that has been read again.
    await user.click(screen.getByRole('link', { name: zhTW.a11y.back }));
    expect(await screen.findByText(USER_CONTENT.note)).toBeInTheDocument();
  });

  it('lists who can see the baby, by name', async () => {
    api.members = [
      { userId: 'user-1', username: 'parent', role: 'owner' },
      { userId: 'user-9', username: 'the-other-one', role: 'member' },
    ];
    await openSettings();

    // A column of ids answers none of the questions somebody opens this
    // screen with (spec 7.8).
    expect(screen.getByTestId('member-parent')).toHaveTextContent(zhTW.settings.roleOwner);
    expect(screen.getByTestId('member-the-other-one')).toHaveTextContent(zhTW.settings.roleMember);
  });

  it('hands out a code once, and says what it is worth', async () => {
    const user = await openSettings();
    await user.click(screen.getByTestId('generate-invite'));

    const shown = await screen.findByTestId('invite');
    expect(shown).toHaveTextContent(zhTW.settings.inviteOnce);
    // Six groups of five: 150 bits, in symbols nobody misreads off a
    // screen. Nothing stores it, so leaving the page really does lose it.
    expect(screen.getByTestId('invite-code').textContent)
      .toMatch(/^(?:[0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('does not offer a code to somebody who is not the owner', async () => {
    Object.assign(BABY, { role: 'member' });
    await openSettings();

    // The server refuses either way; offering a button that can only fail
    // is its own small lie (spec 6.4).
    expect(screen.queryByTestId('generate-invite')).not.toBeInTheDocument();
    expect(screen.queryByTestId('save-baby')).not.toBeInTheDocument();
    expect(screen.getByTestId('owner-only')).toBeInTheDocument();
  });

  it('lets the second parent in without making a baby of their own', async () => {
    // Where they actually are: a code in a message, no baby, and nothing
    // on the create screen that applies to them (spec 7.1).
    const code = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789';
    api.invites.set(code, BABY.id);
    api.startWithNoBaby();

    const user = openSignedIn();
    await screen.findByText(zhTW.baby.createTitle);

    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), code);
    await user.click(screen.getByTestId('join'));

    // Straight into the family's records, with nothing created.
    await waitForHome();
    expect(api.lastRequest('/api/babies')?.path).not.toBe('/api/babies');
    const sent = api.lastRequest('/api/babies/join')?.body as Record<string, unknown>;
    expect(sent['code']).toBe(code);
  });

  it('goes to the baby that was just joined, not to whichever is first', async () => {
    const theirs = { ...BABY, id: 'baby-9', nickname: 'Theirs', role: 'member' as const };
    const code = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789';
    api.invites.set(code, theirs.id);
    api.joinsInto = theirs;

    const user = await openSettings();
    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), code);
    await user.click(screen.getByTestId('join'));

    // Landing on a different baby because it happens to be first in the
    // list is not what they just asked for (spec 7.10).
    await user.click(await screen.findByRole('link', { name: zhTW.a11y.back }));
    expect(await screen.findByText('Theirs')).toBeInTheDocument();
  });

  it('does not spend the code again when only the refresh failed', async () => {
    const code = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789';
    api.invites.set(code, BABY.id);
    const user = await openSettings();

    // The code is spent; reading the account back is a separate request
    // and it is the one that fails.
    server.use(http.get('/api/me', () => HttpResponse.error()));
    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), code);
    await user.click(screen.getByTestId('join'));

    expect(await screen.findByTestId('form-error'))
      .toHaveTextContent(zhTW.settings.joinedNeedsRefresh);

    // Pressing again must not send the code a second time: it has been
    // used, by this very person, and the only answer left is a 404.
    server.resetHandlers();
    const spent = api.requests.filter((e) => e.path === '/api/babies/join').length;
    await user.click(screen.getByTestId('join'));

    await waitFor(() =>
      expect(api.requests.filter((e) => e.path === '/api/babies/join')).toHaveLength(spent),
    );
  });

  it('checks whether it got in when the answer was lost', async () => {
    const code = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789';
    const theirs = { ...BABY, id: 'baby-9', nickname: 'Theirs', role: 'member' as const };
    api.invites.set(code, theirs.id);
    api.joinsInto = theirs;

    const user = await openSettings();

    // Spent on the server, and the client never hears so. Telling them it
    // failed while they are already a member is the wrong answer, and the
    // code cannot be spent twice to find out (spec 6.1).
    server.use(http.post('/api/babies/join', async ({ request }) => {
      await request.json();
      api.invites.delete(code);
      api.joinsInto = theirs;
      api.alsoHasBaby(theirs);
      return HttpResponse.error();
    }));

    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), code);
    await user.click(screen.getByTestId('join'));

    // It asks the account instead of guessing.
    await waitFor(() => expect(screen.queryByTestId('form-error')).not.toBeInTheDocument());
    await user.click(await screen.findByRole('link', { name: zhTW.a11y.back }));
    expect(await screen.findByText('Theirs')).toBeInTheDocument();
  });

  it('keeps asking whether it got in when the answer and the account are both lost', async () => {
    const code = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789';
    const theirs = { ...BABY, id: 'baby-9', nickname: 'Theirs', role: 'member' as const };
    api.invites.set(code, theirs.id);
    api.joinsInto = theirs;

    const user = await openSettings();

    // The code is spent on the server, the answer is lost, and the check
    // that would have settled it cannot reach anything either.
    server.use(
      http.post('/api/babies/join', async ({ request }) => {
        await request.json();
        api.invites.delete(code);
        api.alsoHasBaby(theirs);
        return HttpResponse.error();
      }),
      http.get('/api/me', () => HttpResponse.error()),
    );

    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), code);
    await user.click(screen.getByTestId('join'));
    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.settings.joinUnknown);

    // The signal comes back. Pressing again must ask the account first:
    // the code has been spent, by this very person, so sending it again
    // can only answer 404 -- which says the opposite of the truth.
    server.resetHandlers();
    const sent = api.requests.filter((e) => e.path === '/api/babies/join').length;
    await user.click(screen.getByTestId('join'));

    await user.click(await screen.findByRole('link', { name: zhTW.a11y.back }));
    expect(await screen.findByText('Theirs')).toBeInTheDocument();
    expect(api.requests.filter((e) => e.path === '/api/babies/join')).toHaveLength(sent);
  });

  it('measures against the account as it was before the attempt', async () => {
    const code = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789';
    const theirs = { ...BABY, id: 'baby-9', nickname: 'Theirs', role: 'member' as const };
    api.invites.set(code, theirs.id);
    api.joinsInto = theirs;

    const user = await openSettings();

    // Spent on the server, answer lost, account unreachable.
    server.use(
      http.post('/api/babies/join', async ({ request }) => {
        await request.json();
        api.invites.delete(code);
        api.alsoHasBaby(theirs);
        return HttpResponse.error();
      }),
      http.get('/api/me', () => HttpResponse.error()),
    );
    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), code);
    await user.click(screen.getByTestId('join'));
    await screen.findByTestId('form-error');

    // The connection comes back, and something else on this page reads
    // the account first -- renaming the baby does. By the time join is
    // pressed again, the list it would compare against already has the
    // new baby in it, so "did one appear" can only be answered against
    // what it was before any of this started.
    server.resetHandlers();
    const nickname = screen.getByLabelText(zhTW.baby.nickname);
    await user.clear(nickname);
    await user.type(nickname, USER_CONTENT.note);
    await user.click(screen.getByTestId('save-baby'));
    await waitFor(() => expect(api.lastRequest('/api/babies/baby-1')).toBeDefined());

    await user.click(screen.getByTestId('join'));

    await user.click(await screen.findByRole('link', { name: zhTW.a11y.back }));
    expect(await screen.findByText('Theirs')).toBeInTheDocument();
  });

  it('does not let a later refusal settle a doubt it cannot settle', async () => {
    const code = 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789';
    api.invites.set(code, BABY.id);
    const user = await openSettings();

    // Nothing answered, and the account could not be reached either.
    server.use(
      http.post('/api/babies/join', () => HttpResponse.error()),
      http.get('/api/me', () => HttpResponse.error()),
    );
    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), code);
    await user.click(screen.getByTestId('join'));
    await screen.findByTestId('form-error');

    // Now /me works and says this person is not in any new baby, but the
    // code answers 404 -- which is what a code spent by this very person
    // answers too. Only the account reading clean settles it.
    server.resetHandlers();
    server.use(http.post('/api/babies/join', () => HttpResponse.json(
      { error: { code: 'NOT_FOUND', details: null } }, { status: 404 },
    )));
    await user.click(screen.getByTestId('join'));

    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.settings.joinFailed);
  });

  it('switches between babies from the name at the top', async () => {
    api.alsoHasBaby({ ...BABY, id: 'baby-9', nickname: 'Theirs', role: 'member' });

    const user = openSignedIn();
    await waitForHome();

    await user.click(await screen.findByTestId('switch-baby'));
    await user.click(screen.getByTestId('choose-baby-9'));

    expect(await screen.findByText('Theirs')).toBeInTheDocument();

    // And it is still there after a reload: which one is being looked at
    // is not something to have to choose again every time.
    closeApp();
    openSignedIn();
    expect(await screen.findByText('Theirs')).toBeInTheDocument();
  });

  it('offers no switch to an account with one baby', async () => {
    openSignedIn();
    await waitForHome();

    // A control that does nothing is worse than no control.
    expect(screen.queryByTestId('switch-baby')).not.toBeInTheDocument();
  });

  it('says nothing was copied when nothing was', async () => {
    const user = await openSettings();
    await user.click(screen.getByTestId('generate-invite'));
    await screen.findByTestId('invite-code');

    // A clipboard needs a secure context, which a LAN address over plain
    // HTTP is not -- and that is where this is being tested. The test
    // harness installs a working one, so it is taken away again.
    const clipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    try {
      await user.click(screen.getByTestId('copy-invite'));
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    }

    expect(await screen.findByTestId('copy-failed')).toBeInTheDocument();
    expect(screen.getByTestId('copy-invite')).toHaveTextContent(zhTW.settings.copy);
  });

  it('says the same thing for a code that is wrong, used or expired', async () => {
    const user = await openSettings();

    api.joinFails = true;
    await user.type(screen.getByLabelText(zhTW.settings.joinPlaceholder), 'ZZZZZ-ZZZZZ');
    await user.click(screen.getByTestId('join'));

    // Which of the three it was is something only somebody guessing would
    // want to know (spec 6.5).
    expect(await screen.findByTestId('form-error')).toHaveTextContent(zhTW.settings.joinFailed);
  });

  it('asks before removing somebody, then removes them', async () => {
    api.members = [
      { userId: 'user-1', username: 'parent', role: 'owner' },
      { userId: 'user-9', username: 'the-other-one', role: 'member' },
    ];
    const user = await openSettings();

    await user.click(screen.getByTestId('remove-the-other-one'));
    expect(screen.getByTestId('remove-confirm')).toHaveTextContent(
      interpolate(zhTW.settings.removeTitle, { name: 'the-other-one' }),
    );

    await user.click(screen.getByTestId('remove-yes'));

    await waitFor(() => expect(screen.queryByTestId('member-the-other-one')).not.toBeInTheDocument());
    expect(api.requests.some((e) => e.method === 'DELETE' && e.path.endsWith('/members/user-9'))).toBe(true);
  });

  it('will not offer to remove the only owner', async () => {
    await openSettings();

    // A baby with nobody in charge can never be invited to again and its
    // details can never be corrected.
    expect(screen.queryByTestId('remove-parent')).not.toBeInTheDocument();
    expect(screen.getByTestId('last-owner')).toBeInTheDocument();
  });

  it('lets a member leave, and takes the baby with them', async () => {
    api.signInAs('user-9');
    api.members = [
      { userId: 'user-1', username: 'parent', role: 'owner' },
      { userId: 'user-9', username: 'the-other-one', role: 'member' },
    ];
    Object.assign(BABY, { role: 'member' });

    const user = openSignedIn();
    await waitForHome();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.openSettings }));

    await user.click(await screen.findByTestId('remove-the-other-one'));
    expect(screen.getByTestId('remove-confirm')).toHaveTextContent(zhTW.settings.leaveTitle);
    await user.click(screen.getByTestId('remove-yes'));

    // With no baby left, there is nothing for the app to show but the
    // form to make one.
    expect(await screen.findByText(zhTW.baby.createTitle)).toBeInTheDocument();
  });
});
