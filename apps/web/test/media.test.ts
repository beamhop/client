import { describe, test, expect } from 'bun:test';
import { classifyUrl, parseImeta, parseContent, contentWarning } from '../src/lib/media.js';

describe('classifyUrl', () => {
  test('detects images by extension', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']) {
      expect(classifyUrl(`https://x.com/a.${ext}`)?.kind).toBe('image');
    }
  });
  test('detects images with query strings', () => {
    expect(classifyUrl('https://cdn.example.com/pic.jpg?width=600&v=2')?.kind).toBe('image');
  });
  test('detects video and audio', () => {
    expect(classifyUrl('https://x.com/v.mp4')?.kind).toBe('video');
    expect(classifyUrl('https://x.com/v.webm')?.kind).toBe('video');
    expect(classifyUrl('https://x.com/a.mp3')?.kind).toBe('audio');
    expect(classifyUrl('https://x.com/a.flac')?.kind).toBe('audio');
  });
  test('detects YouTube in all common forms', () => {
    const id = 'dQw4w9WgXcQ';
    expect(classifyUrl(`https://www.youtube.com/watch?v=${id}`)).toMatchObject({ kind: 'youtube', embedId: id });
    expect(classifyUrl(`https://youtu.be/${id}`)).toMatchObject({ kind: 'youtube', embedId: id });
    expect(classifyUrl(`https://www.youtube.com/shorts/${id}`)).toMatchObject({ kind: 'youtube', embedId: id });
    expect(classifyUrl(`https://m.youtube.com/watch?v=${id}&t=10`)).toMatchObject({ kind: 'youtube', embedId: id });
  });
  test('detects Vimeo and Spotify', () => {
    expect(classifyUrl('https://vimeo.com/123456789')).toMatchObject({ kind: 'vimeo', embedId: '123456789' });
    expect(classifyUrl('https://open.spotify.com/track/abc123')).toMatchObject({ kind: 'spotify', embedId: 'track/abc123' });
    expect(classifyUrl('https://open.spotify.com/album/xyz')).toMatchObject({ kind: 'spotify', embedId: 'album/xyz' });
  });
  test('rejects non-media and non-http URLs', () => {
    expect(classifyUrl('https://example.com/article')).toBeNull();
    expect(classifyUrl('https://example.com/page.html')).toBeNull();
    expect(classifyUrl('javascript:alert(1)')).toBeNull();
    expect(classifyUrl('data:image/png;base64,xxxx')).toBeNull();
    expect(classifyUrl('not a url')).toBeNull();
  });
});

describe('parseImeta', () => {
  test('parses a full NIP-92 imeta tag', () => {
    const tags = [
      [
        'imeta',
        'url https://nostr.build/i/my-image.jpg',
        'm image/jpeg',
        'blurhash eVF$^OI:${M{o#*0-nNFxakD',
        'dim 3024x4032',
        'alt A scenic photo',
        'fallback https://void.cat/alt1.jpg',
      ],
    ];
    const map = parseImeta(tags);
    const info = map.get('https://nostr.build/i/my-image.jpg');
    expect(info).toBeDefined();
    expect(info?.mime).toBe('image/jpeg');
    expect(info?.dim).toEqual({ width: 3024, height: 4032 });
    expect(info?.alt).toBe('A scenic photo');
    expect(info?.fallback).toEqual(['https://void.cat/alt1.jpg']);
  });
  test('ignores non-imeta tags and entries without a url', () => {
    expect(parseImeta([['e', 'abc'], ['imeta', 'm image/png']]).size).toBe(0);
  });
});

describe('parseContent', () => {
  test('strips a trailing image URL into a media block', () => {
    const { tokens, media } = parseContent('check this out https://x.com/cat.jpg');
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'image', url: 'https://x.com/cat.jpg' });
    expect(tokens).toEqual([{ type: 'text', text: 'check this out' }]);
  });
  test('keeps non-media links inline', () => {
    const { tokens, media } = parseContent('read https://example.com/post');
    expect(media).toHaveLength(0);
    expect(tokens).toContainEqual({ type: 'link', url: 'https://example.com/post' });
  });
  test('extracts mentions', () => {
    const { tokens } = parseContent('hi nostr:npub1abc def');
    expect(tokens).toContainEqual({ type: 'mention', token: 'npub1abc' });
  });
  test('collects multiple images and dedupes repeats', () => {
    const { media } = parseContent('https://x.com/a.png https://x.com/b.png https://x.com/a.png');
    expect(media.map((m) => m.url)).toEqual(['https://x.com/a.png', 'https://x.com/b.png']);
  });
  test('attaches matching imeta metadata to media', () => {
    const imeta = parseImeta([['imeta', 'url https://x.com/a.png', 'alt a cat']]);
    const { media } = parseContent('https://x.com/a.png', imeta);
    expect(media[0]?.meta?.alt).toBe('a cat');
  });
  test('preserves order: text, image, text', () => {
    const { tokens, media } = parseContent('before https://x.com/a.mp4 after');
    expect(media[0]?.kind).toBe('video');
    expect(tokens[0]).toEqual({ type: 'text', text: 'before ' });
    expect(tokens[tokens.length - 1]).toEqual({ type: 'text', text: ' after' });
  });
});

describe('contentWarning', () => {
  test('returns the reason when present', () => {
    expect(contentWarning([['content-warning', 'nsfw']])).toBe('nsfw');
    expect(contentWarning([['content-warning']])).toBe('');
    expect(contentWarning([['e', 'x']])).toBeNull();
  });
});
