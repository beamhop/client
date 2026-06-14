import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { ImetaInfo, MediaItem } from '../lib/media.js';
import { blurhashToDataUrl } from '../lib/blurhash.js';
import { Btn } from './common.js';
import { Icon } from './Icon.js';
import { Lightbox, type LightboxImage } from './Lightbox.js';

const RADIUS = 16;
const GAP = 3;

/** Renders the ordered media blocks of a post: image galleries, players, embeds. */
export function PostMedia({ media, sensitive }: { media: readonly MediaItem[]; sensitive?: string | null }): ReactNode {
  const [revealed, setRevealed] = useState(sensitive == null);
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);

  const blocks = useMemo(() => groupMedia(media), [media]);
  if (media.length === 0) return null;

  return (
    <div data-testid="post-media" style={{ marginTop: 12, position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          filter: revealed ? 'none' : 'blur(26px)',
          pointerEvents: revealed ? 'auto' : 'none',
          transition: 'filter .25s',
          borderRadius: RADIUS,
          overflow: 'hidden',
        }}
      >
        {blocks.map((block, i) =>
          block.type === 'gallery' ? (
            <ImageGallery
              key={i}
              items={block.items}
              onOpen={(idx) => setLightbox({ images: block.items.map(toLightboxImage), index: idx })}
            />
          ) : (
            <MediaBlock key={i} item={block.item} />
          ),
        )}
      </div>

      {!revealed ? (
        <button
          onClick={() => setRevealed(true)}
          data-testid="reveal-sensitive"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            border: 'none',
            borderRadius: RADIUS,
            background: 'rgba(10,10,25,.35)',
            color: '#fff',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <Icon name="alert" size={26} stroke="#fff" />
          <span style={{ fontWeight: 700, fontSize: 14 }}>Sensitive content</span>
          {sensitive ? <span style={{ fontSize: 12.5, opacity: 0.85, maxWidth: 280, textAlign: 'center' }}>{sensitive}</span> : null}
          <span style={{ fontSize: 12.5, opacity: 0.85, textDecoration: 'underline' }}>Tap to reveal</span>
        </button>
      ) : null}

      {lightbox ? (
        <Lightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNavigate={(index) => setLightbox((lb) => (lb ? { ...lb, index } : lb))}
        />
      ) : null}
    </div>
  );
}

type Block = { type: 'gallery'; items: MediaItem[] } | { type: 'single'; item: MediaItem };

/** Group consecutive images into galleries; everything else stands alone. */
function groupMedia(media: readonly MediaItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of media) {
    if (item.kind === 'image') {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'gallery') last.items.push(item);
      else blocks.push({ type: 'gallery', items: [item] });
    } else {
      blocks.push({ type: 'single', item });
    }
  }
  return blocks;
}

function toLightboxImage(item: MediaItem): LightboxImage {
  return { url: item.url, alt: item.meta?.alt };
}

function MediaBlock({ item }: { item: MediaItem }): ReactNode {
  switch (item.kind) {
    case 'video':
      return <VideoPlayer item={item} />;
    case 'audio':
      return <AudioPlayer item={item} />;
    case 'youtube':
    case 'vimeo':
      return <VideoEmbed item={item} />;
    case 'spotify':
      return <SpotifyEmbed item={item} />;
    default:
      return null;
  }
}

// ---------- images ----------

function aspectFromDim(dim: ImetaInfo['dim'], fallback: number, min = 0.75, max = 2): number {
  if (!dim || dim.height === 0) return fallback;
  return Math.min(max, Math.max(min, dim.width / dim.height));
}

function ImageGallery({ items, onOpen }: { items: MediaItem[]; onOpen: (i: number) => void }): ReactNode {
  const n = items.length;

  if (n === 1) {
    const item = items[0];
    if (!item) return null;
    return (
      <div style={{ borderRadius: RADIUS, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <MediaImage item={item} onClick={() => onOpen(0)} aspectRatio={aspectFromDim(item.meta?.dim, 16 / 9, 0.8, 1.91)} />
      </div>
    );
  }

  const cells = items.slice(0, 4);
  const extra = n - 4;

  // Twitter-style layouts.
  const containerStyle: CSSProperties = {
    display: 'grid',
    gap: GAP,
    borderRadius: RADIUS,
    overflow: 'hidden',
    border: '1px solid var(--border)',
    height: n === 2 ? 280 : 340,
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: n === 2 ? '1fr' : '1fr 1fr',
  };

  return (
    <div style={containerStyle}>
      {cells.map((item, i) => {
        // 3 images: first spans both rows on the left.
        const span3 = n === 3 && i === 0 ? { gridRow: '1 / span 2' } : undefined;
        const isLast = i === 3 && extra > 0;
        return (
          <div key={i} style={{ position: 'relative', minHeight: 0, ...span3 }}>
            <MediaImage item={item} onClick={() => onOpen(i)} fill />
            {isLast ? (
              <div
                onClick={() => onOpen(i)}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(10,10,25,.5)',
                  color: '#fff',
                  fontSize: 24,
                  fontWeight: 700,
                  cursor: 'zoom-in',
                }}
              >
                +{extra + 1}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function MediaImage({
  item,
  onClick,
  aspectRatio,
  fill = false,
}: {
  item: MediaItem;
  onClick?: () => void;
  aspectRatio?: number;
  fill?: boolean;
}): ReactNode {
  const fallbacks = item.meta?.fallback ?? [];
  const [srcIndex, setSrcIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const blur = useMemo(() => (item.meta?.blurhash ? blurhashToDataUrl(item.meta.blurhash) : null), [item.meta?.blurhash]);

  const sources = [item.url, ...fallbacks];
  const src = sources[srcIndex];

  const onError = (): void => {
    if (srcIndex + 1 < sources.length) {
      setSrcIndex(srcIndex + 1);
      setLoaded(false);
    } else {
      setFailed(true);
    }
  };

  const wrapStyle: CSSProperties = fill
    ? { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: 'var(--surface-2)' }
    : { position: 'relative', width: '100%', aspectRatio: String(aspectRatio ?? 16 / 9), maxHeight: 510, overflow: 'hidden', background: 'var(--surface-2)' };

  if (failed || !src) {
    return (
      <a href={item.url} target="_blank" rel="noreferrer noopener" style={{ ...wrapStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', textDecoration: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <Icon name="image" size={18} /> Image unavailable
        </span>
      </a>
    );
  }

  return (
    <div style={wrapStyle}>
      {blur && !loaded ? (
        <img src={blur} aria-hidden alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : null}
      <img
        src={src}
        alt={item.meta?.alt ?? ''}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={onError}
        onClick={onClick}
        data-testid="media-image"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          opacity: loaded ? 1 : 0,
          transition: 'opacity .3s',
          cursor: onClick ? 'zoom-in' : 'default',
        }}
      />
    </div>
  );
}

// ---------- video / audio ----------

function VideoPlayer({ item }: { item: MediaItem }): ReactNode {
  return (
    <video
      controls
      preload="metadata"
      playsInline
      data-testid="media-video"
      style={{ width: '100%', maxHeight: 510, borderRadius: RADIUS, background: '#000', display: 'block', border: '1px solid var(--border)' }}
    >
      <source src={item.url} {...(item.meta?.mime ? { type: item.meta.mime } : {})} />
    </video>
  );
}

function AudioPlayer({ item }: { item: MediaItem }): ReactNode {
  return (
    <div
      data-testid="media-audio"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '12px 14px',
        border: '1px solid var(--border)',
        borderRadius: 14,
        background: 'var(--surface-2)',
      }}
    >
      <Icon name="music" size={20} stroke="var(--accent)" />
      <audio controls src={item.url} style={{ flex: 1, height: 36 }} />
    </div>
  );
}

// ---------- embeds ----------

function VideoEmbed({ item }: { item: MediaItem }): ReactNode {
  const [playing, setPlaying] = useState(false);
  const isYouTube = item.kind === 'youtube';
  const thumb = isYouTube && item.embedId ? `https://i.ytimg.com/vi/${item.embedId}/hqdefault.jpg` : null;
  const embedSrc = isYouTube
    ? `https://www.youtube-nocookie.com/embed/${item.embedId}?autoplay=1&rel=0`
    : `https://player.vimeo.com/video/${item.embedId}?autoplay=1`;

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: RADIUS, overflow: 'hidden', background: '#000', border: '1px solid var(--border)' }}>
      {playing ? (
        <iframe
          src={embedSrc}
          title={isYouTube ? 'YouTube video' : 'Vimeo video'}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        />
      ) : (
        <Btn
          onClick={() => setPlaying(true)}
          aria-label="Play video"
          data-testid="embed-facade"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', padding: 0, cursor: 'pointer', background: '#000' }}
        >
          {thumb ? (
            <img src={thumb} alt="" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.9 }} />
          ) : (
            <span style={{ position: 'absolute', inset: 0, background: 'linear-gradient(120deg,#1a1a2e,#16213e)' }} />
          )}
          <span
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 64,
              height: 64,
              borderRadius: 999,
              background: 'rgba(0,0,0,.6)',
              boxShadow: '0 6px 20px -6px rgba(0,0,0,.6)',
            }}
          >
            <Icon name="play" size={28} fill="#fff" stroke="#fff" />
          </span>
          <span style={{ position: 'absolute', bottom: 10, left: 12, fontSize: 11.5, fontWeight: 700, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>
            {isYouTube ? 'YouTube' : 'Vimeo'}
          </span>
        </Btn>
      )}
    </div>
  );
}

function SpotifyEmbed({ item }: { item: MediaItem }): ReactNode {
  const tall = item.embedId?.startsWith('album/') || item.embedId?.startsWith('playlist/') || item.embedId?.startsWith('show/');
  return (
    <iframe
      src={`https://open.spotify.com/embed/${item.embedId}`}
      title="Spotify"
      loading="lazy"
      allow="encrypted-media"
      referrerPolicy="no-referrer"
      style={{ width: '100%', height: tall ? 352 : 152, border: 0, borderRadius: 12 }}
    />
  );
}
