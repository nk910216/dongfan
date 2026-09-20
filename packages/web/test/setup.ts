import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Vitest does not expose globals here, so Testing Library's automatic
// cleanup never registers. Without this every test renders on top of the
// previous one and queries start matching several copies of the app.
afterEach(cleanup);
