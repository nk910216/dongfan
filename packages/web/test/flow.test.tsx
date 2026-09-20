import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { eventTypeName, interpolate, metadataOptionLabel, valueLabel, zhTW } from '@dongfan/shared';
import { App } from '../src/App.js';

/**
 * Flow tests for the prototype.
 *
 * They drive the screens the way a parent would, which is the only way to
 * catch the class of problem the review found: a timer that can be started
 * but never stopped, or a label that renders an identifier.
 */
function open(path = '/'): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return user;
}

describe('home screen', () => {
  it('shows the handover summary, not just growth figures', () => {
    open();
    expect(screen.getByText(zhTW.home.lastFeed)).toBeInTheDocument();
    expect(screen.getByText(zhTW.home.todayMilk)).toBeInTheDocument();
    expect(screen.getByText(zhTW.home.todayDiaper)).toBeInTheDocument();
  });

  it('marks itself as a prototype while mock data is in use', () => {
    open();
    expect(screen.getByText(/PROTOTYPE/)).toBeInTheDocument();
  });

  it('shows a running timer with a stop button', () => {
    open();
    expect(screen.getByRole('button', { name: zhTW.timer.stop })).toBeInTheDocument();
  });

  it('actually stops the timer when the button is pressed', async () => {
    const user = open();

    // Running: the row carries the in-progress badge and the card offers a
    // stop button rather than an add shortcut.
    expect(screen.getByText(zhTW.event.inProgress)).toBeInTheDocument();
    const sleepRunning = interpolate(zhTW.timer.running, { name: eventTypeName('sleep') });
    expect(screen.getByText(sleepRunning)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: zhTW.timer.stop }));

    expect(screen.queryByRole('button', { name: zhTW.timer.stop })).not.toBeInTheDocument();
    expect(screen.queryByText(zhTW.event.inProgress)).not.toBeInTheDocument();
    expect(screen.queryByText(sleepRunning)).not.toBeInTheDocument();

    // The card reverts to a shortcut, so sleep can be started again.
    expect(
      screen.getByRole('link', { name: `${zhTW.a11y.addEvent} ${eventTypeName('sleep')}` }),
    ).toBeInTheDocument();
  });
});

function numbersIn(testId: string): number[] {
  const text = screen.getByTestId(testId).textContent ?? '';
  return text.match(/\d+/g)?.map(Number) ?? [];
}

/** The count beside today's list. */
function todayCount(): number {
  return numbersIn('today-count')[0] ?? 0;
}

/** Diaper totals from the summary strip, in the order the copy lists them. */
function diaperBreakdown(): { pee: number; poo: number; unknown: number } {
  const [pee = 0, poo = 0, unknown = 0] = numbersIn('diaper-breakdown');
  return { pee, poo, unknown };
}

function newestRow(typeId: string): HTMLElement {
  const rows = screen.getAllByTestId(`event-row-${typeId}`);
  return rows[0] as HTMLElement;
}

describe('recording a nappy change', () => {
  it('adds exactly one event of the kind that was tapped', async () => {
    const user = open();

    const countBefore = todayCount();
    const before = diaperBreakdown();
    const rowsBefore = screen.getAllByTestId('event-row-diaper').length;

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(screen.getByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));

    expect(todayCount()).toBe(countBefore + 1);
    expect(screen.getAllByTestId('event-row-diaper').length).toBe(rowsBefore + 1);

    // Only the kind that was tapped moves, and nothing lands in unknown.
    const after = diaperBreakdown();
    expect(after.poo).toBe(before.poo + 1);
    expect(after.pee).toBe(before.pee);
    expect(after.unknown).toBe(before.unknown);
  });

  it('records the kind on the new row, not as unclassified', async () => {
    const user = open();
    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(screen.getByRole('button', { name: metadataOptionLabel('diaper_kind', 'both') }));

    expect(
      within(newestRow('diaper')).getByText(new RegExp(metadataOptionLabel('diaper_kind', 'both'))),
    ).toBeInTheDocument();
  });
});

describe('bottle form', () => {
  it('labels the amount field in Chinese rather than its id', async () => {
    open('/add/bottle');
    expect(screen.getByText(new RegExp(valueLabel('bottle')))).toBeInTheDocument();
    expect(screen.queryByText(/\bbottle\b/)).not.toBeInTheDocument();
  });

  it('prefills the previous amount for confirmation', () => {
    open('/add/bottle');
    // The newest mock bottle is 140 ml.
    expect(screen.getByDisplayValue('140')).toBeInTheDocument();
  });

  it('rejects an amount outside the configured range', async () => {
    const user = open('/add/bottle');
    const input = screen.getByDisplayValue('140');
    await user.clear(input);
    await user.type(input, '900');
    await user.click(screen.getByRole('button', { name: zhTW.addEvent.save }));
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  it('keeps a one millilitre entry visible instead of hiding it', async () => {
    const user = open('/add/bottle');
    const input = screen.getByDisplayValue('140');
    await user.clear(input);
    await user.type(input, '1');
    await user.click(screen.getByRole('button', { name: zhTW.addEvent.save }));

    expect(within(newestRow('bottle')).getByText('1')).toBeInTheDocument();
  });
});

describe('timers that are not shortcuts', () => {
  it('can be stopped from the home screen after being started', async () => {
    const user = open('/add/walk');

    // Walk is timer-enabled but not a quick action, so before this change it
    // could be started with no way to end it.
    // The intent toggle and the submit button share a label; the submit
    // button is the last one on the screen.
    const buttons = screen.getAllByRole('button', { name: zhTW.addEvent.startTimer });
    await user.click(buttons[buttons.length - 1] as HTMLElement);

    const stops = screen.getAllByRole('button', { name: zhTW.timer.stop });
    expect(stops.length).toBe(2);
  });
});

describe('touch targets', () => {
  it('gives every stop button at least the minimum height', () => {
    open();
    for (const button of screen.getAllByRole('button', { name: zhTW.timer.stop })) {
      expect(button.className).toMatch(/min-h-11/);
    }
  });

  it('gives every quick add control at least the minimum height', () => {
    open();
    // Quick action shortcuts are labelled with their type; the floating
    // button is labelled on its own and is already 60px across.
    const shortcuts = screen.getAllByRole('link', {
      name: new RegExp(`${zhTW.a11y.addEvent} .+`),
    });
    expect(shortcuts.length).toBeGreaterThan(0);
    for (const link of shortcuts) expect(link.className).toMatch(/min-h-11/);

    const floating = screen.getByRole('link', { name: zhTW.a11y.addEvent });
    expect(floating.className).toMatch(/size-15/);
  });
});
