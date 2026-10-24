// Discourse stores uploads in raw markdown as short "upload://<base62>.<ext>" references that
// nothing outside Discourse can open. /uploads/short-url/<key> redirects to the real file.
const SHORT_UPLOAD = /upload:\/\/([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)/g;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|heic|avif)(?:$|[?#])/i;

export function resolveUploadUrls(text: string, base: string): string {
  const origin = base.replace(/\/+$/, "");
  return text.replace(SHORT_UPLOAD, (_m, key: string) => `${origin}/uploads/short-url/${key}`);
}

// Image URLs referenced with ![...](...) markdown, in order of appearance, without duplicates.
export function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const url = match[1];
    if (!/^https?:\/\//i.test(url) || !IMAGE_EXTENSION.test(url)) continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}
