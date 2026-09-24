import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HttpResponse, http } from 'msw';
import {
  eventTypeName, fromLocalInput, interpolate, metadataLabel, metadataOptionLabel,
  startOfLocalDay, toLocalDate, toLocalInput, toStored, valueLabel, zhTW,
} from '@dongfan/shared';
import { App } from '../src/App.js';
import { BABY, TOKEN, api, server } from './server.js';
import { resetLanes } from '../src/lib/lane.js';
import { offerUpdate, setWorkerCheck } from '../src/lib/update.js';
import { formKey, readForm, saveForm } from '../src/lib/form-draft.js';
import { scopeOf } from '../src/lib/db.js';
import { earlierToday as atEarlierToday } from './fixtures/clock.js';
import { formatClock } from '../src/lib/format.js';
import { breakStorage, setOnline } from './setup.js';
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
    saveForm(key, held?.intent ?? 'record', held!.draft, { eventId: 'half-sent-id' });

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
