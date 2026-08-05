/**
 * Message path extraction.
 *
 * Pulls file and folder path-like strings out of user messages so the router
 * can resolve file/folder triggers. Supports Windows drive prefixes, backslash
 * paths, @-references, and space-containing directory names.
 *
 * Produces normalized (forward-slash) candidates. Both file paths (with an
 * extension) and bare folder paths (trailing `/`) are recognised so folder
 * references trigger path patterns too.
 */

// Segments consist of word chars, dashes, dots, parens/brackets, and @-tags.
// Spaces are deliberately excluded so surrounding prose ("check src/... now")
// is not absorbed into the match.

// File path: one or more dir segments + a filename with a 2-8 char extension.
const FILE_PATH_RE = /(?:[a-zA-Z]:[\\/])?(?:[\w.@()-]+[\\/])+[\w.@()-]+\.(\w{2,8})/g;

// Folder path: two or more dir segments, each ending in a slash.
const FOLDER_PATH_RE = /(?:[a-zA-Z]:[\\/])?(?:[\w.@()-]+[\\/]){2,}/g;

function normalize(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/[ \t]+$/g, "")       // trailing whitespace
    .replace(/^@/, "")            // leading @-tag
    .replace(/\s+/g, " ")         // collapse spaces inside dir names
    .trim();
}

/** Avoid clipping a token — ensure the match starts at a segment boundary. */
function startsAtWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return !/\w/.test(prev) && !/[\\/]/.test(prev);
}

export function extractPaths(text: string): string[] {
  const found = new Set<string>();

  for (const re of [FILE_PATH_RE, FOLDER_PATH_RE]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (startsAtWordBoundary(text, m.index)) {
        found.add(normalize(m[0]));
      }
    }
  }

  return Array.from(found);
}