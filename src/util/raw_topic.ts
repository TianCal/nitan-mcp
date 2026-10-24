export interface RawPost {
  number: number;
  username: string;
  timestamp: string;
  content: string;
}

const HEADER = /^([^|\n]+?) \| ([^|\n]+?) \| #(\d+)$/;
// Discourse's /raw/:topic_id pages put "\n\n" + 25 dashes + "\n\n" between posts. A dashed line
// inside a post body only counts as a separator when the next line is a post header.
const SEPARATOR = /\n\n-{25}\n\n(?=[^|\n]+? \| [^|\n]+? \| #\d+\n)/;
const TRAILING_SEPARATOR = /\n*-{25}\s*$/;

export function parseRawPage(text: string): RawPost[] {
  const posts: RawPost[] = [];
  for (const chunk of text.split(SEPARATOR)) {
    const newline = chunk.indexOf("\n");
    const headerLine = (newline === -1 ? chunk : chunk.slice(0, newline)).trim();
    const match = headerLine.match(HEADER);
    if (!match) continue;
    const body = newline === -1 ? "" : chunk.slice(newline + 1);
    posts.push({
      username: match[1].trim(),
      timestamp: match[2].trim(),
      number: parseInt(match[3], 10),
      content: body.replace(TRAILING_SEPARATOR, "").trim(),
    });
  }
  return posts;
}
