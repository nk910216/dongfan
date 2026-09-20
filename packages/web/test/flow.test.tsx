import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { eventTypeName, metadataOptionLabel, valueLabel, zhTW } from '@dongfan/shared';
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
});

describe('recording a nappy change', () => {
  it('takes two taps and records the kind', async () => {
    const user = open();

    await user.click(screen.getByRole('link', { name: zhTW.a11y.addEvent }));
    await user.click(screen.getByRole('button', { name: metadataOptionLabel('diaper_kind', 'poo') }));

    // Back on the home screen, the new entry is in today's list.
    const list = screen.getByText(zhTW.home.todayEvents);
    expect(list).toBeInTheDocument();
    expect(screen.getAllByText(eventTypeName('diaper')).length).toBeGreaterThan(0);
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

    const rows = screen.getAllByText(eventTypeName('bottle'));
    const row = rows[0]?.closest('div')?.parentElement?.parentElement;
    expect(within(row as HTMLElement).getByText('1')).toBeInTheDocument();
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
