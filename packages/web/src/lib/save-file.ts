/**
 * Hands a file to the browser to save.
 *
 * The export needs a bearer token, so it cannot be a plain link the browser
 * downloads by itself: the page fetches it, checks it, and then offers the
 * bytes it holds. The object URL is released later rather than at once,
 * because Safari on iOS reads it after this returns.
 *
 * What this cannot do is say whether the file was saved. The browser asks,
 * or does not, and tells the page nothing (spec 5.9).
 */
export function saveFile(name: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
