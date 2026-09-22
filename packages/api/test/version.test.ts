import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '@dongfan/shared';
import { json, request } from './helpers.js';

/**
 * What build the API is.
 *
 * A published PWA serves the bundle its service worker has cached until a
 * new one installs and takes over, so the app somebody is looking at can
 * be older than the API it is talking to, for as long as they leave it
 * open. This is how it finds out (spec 2.1).
 */

describe('GET /api/version', () => {
  it('reports the build both halves were made from', async () => {
    const response = await request('/api/version');
    expect(response.status).toBe(200);
    expect(await json<{ version: string }>(response)).toEqual({ version: APP_VERSION });
  });

  it('answers without a session', async () => {
    // A client that has been signed out still has to be able to find out
    // it is running an old bundle, and a version string tells nobody
    // anything about a family.
    const response = await request('/api/version');
    expect(response.status).not.toBe(401);
  });
});
