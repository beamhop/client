export type Embed = { type: "image" | "video"; url: string };

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
const URL_RE = /https?:\/\/[^\s]+/g;

/** Split note text into clean text + media embeds, matching the design's parseMedia. */
export const parseMedia = (text: string): { text: string; embeds: Embed[] } => {
  const urls = text.match(URL_RE) ?? [];
  const embeds: Embed[] = [];
  let clean = text;
  for (const u of urls) {
    const low = (u.split(/[?#]/)[0] ?? "").toLowerCase();
    const type: Embed["type"] | null = IMAGE_RE.test(low) ? "image" : VIDEO_RE.test(low) ? "video" : null;
    if (type) {
      embeds.push({ type, url: u });
      clean = clean.replace(u, "").replace(/[ \t]{2,}/g, " ").trim();
    }
  }
  return { text: clean, embeds };
};
