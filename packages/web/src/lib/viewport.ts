import { useEffect, useState } from 'react';

/**
 * How wide an element actually is, kept up to date.
 *
 * The calendars need it because how many cards fit across a band, how much
 * each can say, and whether an hour has to be folded are all questions about
 * pixels (spec 7.5, 7.6).
 *
 * **It has to be the element and not the window.** The app shell is capped
 * at `max-w-md` and centred, so on any screen wider than that the window is
 * not the container: at a 1024px window the two-day layout believed each
 * column had 490px when it had about 202, and every decision downstream --
 * the reserve, the number of columns, which words to drop -- was made on
 * that number. Clipping the overflow only hid the result.
 *
 * Zero until it has been measured, which `layOut` reads as "nobody has
 * measured yet" and answers with a sensible default for one frame.
 */
export function useMeasuredWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    setWidth(element.clientWidth);
    // Covers turning the phone, the shell's cap coming into play as a
    // window is resized, and anything else that changes the box without
    // changing the viewport.
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? element.clientWidth;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
