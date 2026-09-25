import { useEffect, useState } from 'react';

/**
 * How wide the window is, kept up to date.
 *
 * The calendars need it because how many cards fit across a band is a
 * question about pixels, and the answer is different for one day and for two
 * (spec 7.5, 7.6). Read from the window rather than measured off an element:
 * there is nothing between the viewport and the band but a fixed gutter, and
 * a measurement would need an observer that the test environment does not
 * have -- so it would be the one thing about the layout nothing could check.
 *
 * `resize` covers turning the phone as well, which is the case that changes
 * the answer without anything else on the page moving.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return width;
}
