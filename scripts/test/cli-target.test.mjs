import { describe, expect, it } from 'vitest';
import {
  banner, isWrite, needsConfirmation, parseArgs, targetFor,
} from '../lib/cli-target.mjs';

/**
 * Which database a command reaches, and whether it has to be confirmed.
 *
 * A mistake here produces no error message: the command runs, says it
 * worked, and the only sign is that the wrong records changed (spec 12.1).
 */

describe('reading the arguments', () => {
  it('leaves the command and its own arguments alone', () => {
    expect(parseArgs(['assign', 'alice', 'baby-1', 'owner'])).toEqual({
      command: 'assign',
      args: ['alice', 'baby-1', 'owner'],
      remote: false,
      assumeYes: false,
    });
  });

  it('is local unless --remote is spelled out', () => {
    expect(parseArgs(['list']).remote).toBe(false);
    expect(parseArgs(['list', '--remote']).remote).toBe(true);
  });

  it('pulls --yes out so it cannot be read as a username', () => {
    // It is refused rather than honoured, but it must not reach a command
    // as an argument on the way to being refused.
    const parsed = parseArgs(['disable', '--yes', 'alice']);
    expect(parsed.args).toEqual(['alice']);
    expect(parsed.assumeYes).toBe(true);
  });

  it('takes the flag from anywhere in the line', () => {
    const parsed = parseArgs(['--remote', 'password', 'alice']);
    expect(parsed).toMatchObject({ command: 'password', args: ['alice'], remote: true });
  });

  it('lets a later --local take it back', () => {
    // Recalling a command and editing it is how this gets used, so the
    // last word on the line has to win.
    expect(parseArgs(['create', 'alice', '--remote', '--local']).remote).toBe(false);
  });
});

describe('choosing the database', () => {
  it('never sends a local command to the deployed one', () => {
    expect(targetFor(false)).toEqual({ database: 'dongfan-dev', remote: false });
  });

  it('names the deployed one only when asked', () => {
    expect(targetFor(true)).toEqual({ database: 'dongfan', remote: true });
  });
});

describe('deciding what is a write', () => {
  it('treats listing as a read', () => {
    expect(isWrite('list')).toBe(false);
    expect(isWrite('babies')).toBe(false);
  });

  it('treats everything else as a write', () => {
    for (const command of ['create', 'password', 'revoke', 'disable', 'enable', 'assign']) {
      expect(isWrite(command)).toBe(true);
    }
  });

  it('treats an unknown command as a write', () => {
    // The safe direction: a command this list has not heard of gets the
    // prompt rather than skipping it.
    expect(isWrite('whatever-comes-next')).toBe(true);
  });
});

describe('asking first', () => {
  it('asks before changing the deployed database', () => {
    expect(needsConfirmation({ command: 'password', remote: true })).toBe(true);
  });

  it('does not ask for a local change', () => {
    // Prompting on every local command teaches confirming without reading,
    // which is the habit that makes the prompt useless when it counts.
    expect(needsConfirmation({ command: 'password', remote: false })).toBe(false);
  });

  it('does not ask to read', () => {
    expect(needsConfirmation({ command: 'list', remote: true })).toBe(false);
  });
});

describe('the banner', () => {
  it('says plainly when real records are at stake', () => {
    const text = banner(targetFor(true));
    expect(text).toContain('dongfan');
    expect(text).toContain('REMOTE');
    expect(text).toContain('real records');
  });

  it('says plainly when they are not', () => {
    const text = banner(targetFor(false));
    expect(text).toContain('dongfan-dev');
    expect(text).toContain('local');
    expect(text).not.toContain('REMOTE');
  });
});
