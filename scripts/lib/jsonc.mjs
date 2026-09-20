/**
 * Reads a JSON file that has comments in it.
 *
 * wrangler's configuration is JSONC, and the comments in it are load
 * bearing: they say why the local database is the default and why the
 * production id is a placeholder. Stripping them with a plain regular
 * expression would also strip the `//` inside the `$schema` URL, so this
 * walks the text and only treats a `//` outside a string as a comment.
 */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];

    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }

    if (character === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }

    if (character === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }

    out += character;
  }

  // Trailing commas are legal in JSONC and not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
