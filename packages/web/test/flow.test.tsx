import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HttpResponse, http } from 'msw';
import {
  eventTypeName, fromLocalInput, interpolate, metadataOptionLabel, toLocalInput,
  toStored, valueLabel, zhTW,
} from '@dongfan/shared';
import { App } from '../src/App.js';
import { BABY, TOKEN, api, server } from './server.js';
import { USER_CONTENT } from './fixtures/user-content.js';

/**
 * Screen tests, driven the way a parent would drive them.
 *
 * What is under test is the wiring: whether a tap produces the request the
 * contract describes, and whether the screen can show what comes back. The
 * rules themselves are tested where they live, against a real D1.
 */

const HOUR = 3_600_000;

function open(path = '/'): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return user;
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

describe('the home screen', () => {
  it('shows the figures the server sent, not ones worked out locally', async () => {
    api.add({ typeId: 'bottle', value: 140, startedAt: Date.now() - 2 * HOUR });
    api.add({ typeId: 'bottle', value: 120, startedAt: Date.now() - HOUR });
    api.add({ typeId: 'diaper', metadata: { diaper_kind: 'both' } });

    openSignedIn();
    await waitForHome();

    expect(screen.getByText('260')).toBeInTheDocument();
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

    server.use(http.get('/api/babies/:babyId/events/day/:date', () => HttpResponse.error()));

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(await screen.findByRole('button', { name: metadataOptionLabel('diaper_kind', 'pee') }));

    // The write landed; only the refresh after it did not. Saying "synced"
    // here would be a lie about data the other phone may already have.
    expect(api.events).toHaveLength(1);
    expect(await screen.findByTestId('sync-state')).toHaveTextContent(zhTW.home.syncFailed);
  });
});

describe('the quick nappy buttons', () => {
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
    const running = api.add({ typeId: 'sleep', active: true, startedAt: Date.now() - HOUR });
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
    api.add({ typeId: 'walk', active: true, startedAt: Date.now() - HOUR });

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
    const running = api.add({ typeId: 'sleep', active: true, startedAt: Date.now() - 2 * HOUR });
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
    api.add({ typeId: 'sleep', active: true, startedAt: Date.now() - HOUR });
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
