/**
 * Pure logic for turning note content + NIP-92 `imeta` tags into a structured,
 * render-ready model: an inline token flow (with media URLs stripped out) plus
 * an ordered list of media blocks. Kept free of React so it can be unit-tested.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'youtube' | 'vimeo' | 'spotify';

/** Parsed NIP-92 `imeta` metadata for a single media URL. */
export interface ImetaInfo {
  readonly url: string;
  readonly mime?: string;
  readonly blurhash?: string;
  readonly dim?: { readonly width: number; readonly height: number };
  readonly alt?: string;
  readonly fallback: readonly string[];
}

export interface MediaItem {
  readonly kind: MediaKind;
  /** Original URL from the content (used as the source / canonical link). */
  readonly url: string;
  /** Provider id for embeds (YouTube/Vimeo video id, Spotify `type/id` path). */
  readonly embedId?: string;
  readonly meta?: ImetaInfo;
}

export type ContentToken =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly token: string }
  | { readonly type: 'link'; readonly url: string };

export interface ParsedContent {
  readonly tokens: readonly ContentToken[];
  readonly media: readonly MediaItem[];
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'apng', 'jfif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac']);

// `nostr:` mentions (NIP-27) or bare http(s) URLs.
const TOKEN = /(nostr:(?:npub1|nprofile1)[0-9a-z]+)|(https?:\/\/[^\s]+)/gi;

/** Parse NIP-92 `imeta` tags into a `url → metadata` map. */
export function parseImeta(tags: readonly (readonly string[])[]): Map<string, ImetaInfo> {
  const map = new Map<string, ImetaInfo>();
  for (const tag of tags) {
    if (tag[0] !== 'imeta') continue;
    let url: string | undefined;
    let mime: string | undefined;
    let blurhash: string | undefined;
    let alt: string | undefined;
    let dim: { width: number; height: number } | undefined;
    const fallback: string[] = [];
    // Fields are space-delimited `key value` pairs, one per tag element.
    for (let i = 1; i < tag.length; i++) {
      const entry = tag[i];
      if (!entry) continue;
      const space = entry.indexOf(' ');
      if (space === -1) continue;
      const key = entry.slice(0, space);
      const value = entry.slice(space + 1).trim();
      if (!value) continue;
      switch (key) {
        case 'url':
          url = value;
          break;
        case 'm':
          mime = value;
          break;
        case 'blurhash':
          blurhash = value;
          break;
        case 'alt':
          alt = value;
          break;
        case 'dim': {
          const m = /^(\d+)x(\d+)$/.exec(value);
          if (m) dim = { width: Number(m[1]), height: Number(m[2]) };
          break;
        }
        case 'fallback':
          fallback.push(value);
          break;
        default:
          break;
      }
    }
    if (url) {
      map.set(url, {
        url,
        ...(mime !== undefined ? { mime } : {}),
        ...(blurhash !== undefined ? { blurhash } : {}),
        ...(alt !== undefined ? { alt } : {}),
        ...(dim !== undefined ? { dim } : {}),
        fallback,
      });
    }
  }
  return map;
}

function extensionOf(pathname: string): string | null {
  const clean = pathname.split('/').pop() ?? '';
  const dot = clean.lastIndexOf('.');
  if (dot === -1 || dot === clean.length - 1) return null;
  return clean.slice(dot + 1).toLowerCase();
}

function host(url: URL): string {
  return url.hostname.replace(/^www\./, '').toLowerCase();
}

function youtubeId(url: URL): string | null {
  const h = host(url);
  if (h === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const m = /^\/(?:embed|shorts|v|live)\/([^/]+)/.exec(url.pathname);
    if (m) return m[1] ?? null;
  }
  return null;
}

function vimeoId(url: URL): string | null {
  const h = host(url);
  if (h === 'vimeo.com') {
    const m = /^\/(\d+)/.exec(url.pathname);
    return m ? (m[1] ?? null) : null;
  }
  if (h === 'player.vimeo.com') {
    const m = /^\/video\/(\d+)/.exec(url.pathname);
    return m ? (m[1] ?? null) : null;
  }
  return null;
}

function spotifyPath(url: URL): string | null {
  if (host(url) !== 'open.spotify.com') return null;
  const m = /^\/(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/.exec(url.pathname);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Classify a URL into a media item, or null if it isn't recognised media.
 * Only http(s) is accepted; `javascript:`/`data:` etc. are rejected.
 */
export function classifyUrl(raw: string): MediaItem | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const yt = youtubeId(url);
  if (yt) return { kind: 'youtube', url: raw, embedId: yt };
  const vimeo = vimeoId(url);
  if (vimeo) return { kind: 'vimeo', url: raw, embedId: vimeo };
  const spotify = spotifyPath(url);
  if (spotify) return { kind: 'spotify', url: raw, embedId: spotify };

  const ext = extensionOf(url.pathname);
  if (ext) {
    if (IMAGE_EXT.has(ext)) return { kind: 'image', url: raw };
    if (VIDEO_EXT.has(ext)) return { kind: 'video', url: raw };
    if (AUDIO_EXT.has(ext)) return { kind: 'audio', url: raw };
  }
  return null;
}

/**
 * Split content into an inline token flow + ordered media blocks. Media URLs are
 * removed from the inline flow (rendered as blocks instead, like X/Mastodon).
 * `imeta` metadata is attached to matching media items.
 */
export function parseContent(content: string, imeta?: Map<string, ImetaInfo>): ParsedContent {
  const tokens: ContentToken[] = [];
  const media: MediaItem[] = [];
  const seenMedia = new Set<string>();
  let lastIndex = 0;

  const pushText = (text: string): void => {
    if (text) tokens.push({ type: 'text', text });
  };

  for (const match of content.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    const [, mention, url] = match;

    if (mention) {
      pushText(content.slice(lastIndex, index));
      tokens.push({ type: 'mention', token: mention.slice('nostr:'.length) });
      lastIndex = index + match[0].length;
      continue;
    }

    if (url) {
      const item = classifyUrl(url);
      if (item) {
        // Strip the media URL from the inline flow.
        pushText(content.slice(lastIndex, index));
        if (!seenMedia.has(item.url)) {
          seenMedia.add(item.url);
          const meta = imeta?.get(item.url);
          media.push(meta ? { ...item, meta } : item);
        }
        lastIndex = index + match[0].length;
      }
      // Non-media links are left in place and emitted as `link` tokens below.
      else {
        pushText(content.slice(lastIndex, index));
        tokens.push({ type: 'link', url });
        lastIndex = index + match[0].length;
      }
    }
  }
  pushText(content.slice(lastIndex));

  return { tokens: collapseWhitespace(tokens), media };
}

/**
 * Tidy the inline flow after media removal: trim leading/trailing whitespace and
 * collapse the runs of blank lines that stripped URLs tend to leave behind.
 */
function collapseWhitespace(tokens: ContentToken[]): ContentToken[] {
  const cleaned = tokens.map((t) =>
    t.type === 'text' ? ({ type: 'text', text: t.text.replace(/[ \t]*\n[ \t]*\n[ \t]*\n+/g, '\n\n') } as const) : t,
  );
  // Trim the very first/last text tokens.
  const first = cleaned[0];
  if (first?.type === 'text') cleaned[0] = { type: 'text', text: first.text.replace(/^\s+/, '') };
  const last = cleaned[cleaned.length - 1];
  if (last?.type === 'text') cleaned[cleaned.length - 1] = { type: 'text', text: last.text.replace(/\s+$/, '') };
  return cleaned.filter((t) => t.type !== 'text' || t.text.length > 0);
}

/** Read the NIP-36 content-warning reason from tags, if the note is flagged. */
export function contentWarning(tags: readonly (readonly string[])[]): string | null {
  const tag = tags.find((t) => t[0] === 'content-warning');
  if (!tag) return null;
  return tag[1]?.trim() || '';
}
