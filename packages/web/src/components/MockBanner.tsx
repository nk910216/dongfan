import { IS_MOCK_DATA } from '../mock/data.js';

/**
 * Makes it impossible to mistake the prototype for a working app.
 *
 * Renders nothing once the mock module is gone, which is what M1 requires
 * (spec 12.1). English on purpose: this is a note to developers, not copy
 * for the family.
 */
export function MockBanner(): React.JSX.Element | null {
  if (!IS_MOCK_DATA) return null;
  return (
    <div className="shrink-0 bg-amber-500/15 px-4 py-1 text-center text-[11px] tracking-wide text-amber-300/90">
      PROTOTYPE — mock data, not connected to an API
    </div>
  );
}
