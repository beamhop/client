/**
 * 4-word pairing safety phrase (JOURNEYS §1.04, §9; DESIGN §12 "the safety-phrase comparison is a
 * *match* check, not recall").
 *
 * TODO(pairing): switch to the shared derivation in `packages/channel-nostr/src/pairing.ts` once it lands
 * (another builder is adding it). It should derive the words from the pairing handshake (both device
 * keys + the one-time token), not from the token alone. Until then both sides of the PWA (computer:
 * Settings → Devices / onboarding 04; phone: /pair) use this local function, so they always agree.
 *
 * Derivation here: SHA-256("beamhop-pair-v1:" + normalized secret) → first 4 bytes → 4 words from a
 * 256-word list (32 bits; a short authentication string is only meant to catch a swapped QR / relayed
 * pairing, the token itself is the secret). Words are short, concrete, and visually distinct.
 */
import { useEffect, useState } from 'react';

// 256 words: radio/transmitter, weather and field vocabulary. Unique, 3–6 letters, no homophones.
export const PHRASE_WORDS = [
  'AMBER', 'RELAY', 'OTTER', 'NINE', 'ANCHOR', 'APRIL', 'ARCH', 'ARROW', 'ASPEN', 'ATLAS',
  'BADGE', 'BAKER', 'BAMBOO', 'BANJO', 'BARN', 'BASIL', 'BEACON', 'BEAR', 'BIRCH', 'BISON',
  'BLADE', 'BLOOM', 'BOLT', 'BRASS', 'BRICK', 'BRIDGE', 'BROOK', 'CABLE', 'CACTUS', 'CAMEL',
  'CANOE', 'CANYON', 'CARGO', 'CEDAR', 'CHALK', 'CHERRY', 'CHESS', 'CIDER', 'CLAMP', 'CLIFF',
  'CLOCK', 'CLOUD', 'CLOVER', 'COAST', 'COBALT', 'COMET', 'CORAL', 'COYOTE', 'CRANE', 'CREEK',
  'CROWN', 'CUBE', 'DAISY', 'DELTA', 'DENIM', 'DESK', 'DIAL', 'DINGO', 'DOCK', 'DOVE',
  'DRAGON', 'DRUM', 'DUNE', 'EAGLE', 'ECHO', 'EIGHT', 'ELBOW', 'ELM', 'EMBER', 'FABLE',
  'FALCON', 'FERN', 'FERRY', 'FIELD', 'FIG', 'FJORD', 'FLAME', 'FLINT', 'FLUTE', 'FORGE',
  'FOX', 'FROST', 'GALAXY', 'GARNET', 'GATE', 'GECKO', 'GINGER', 'GLACIER', 'GLOBE', 'GOOSE',
  'GRAPE', 'GRAVEL', 'GROVE', 'GULL', 'HAMMER', 'HARBOR', 'HAWK', 'HAZEL', 'HELIX', 'HERON',
  'HILL', 'HONEY', 'HOOK', 'HORN', 'IGLOO', 'INDIGO', 'IRIS', 'IRON', 'IVORY', 'JADE',
  'JAGUAR', 'JASPER', 'JELLY', 'JETTY', 'JUNIPER', 'KAYAK', 'KELP', 'KERNEL', 'KETTLE', 'KITE',
  'KIWI', 'KNOT', 'LADDER', 'LAGOON', 'LAMP', 'LANTERN', 'LARCH', 'LASER', 'LATCH', 'LEMON',
  'LEVER', 'LILAC', 'LIME', 'LINEN', 'LION', 'LOBSTER', 'LOTUS', 'LYNX', 'MAGNET', 'MANGO',
  'MAPLE', 'MARBLE', 'MARSH', 'MEADOW', 'MESA', 'METEOR', 'MINT', 'MIRROR', 'MOOSE', 'MOSS',
  'MOTH', 'NECTAR', 'NEEDLE', 'NICKEL', 'NOMAD', 'NORTH', 'NUTMEG', 'OAK', 'OASIS', 'OCEAN',
  'OLIVE', 'ONYX', 'OPAL', 'ORBIT', 'ORCHID', 'OWL', 'OXIDE', 'PADDLE', 'PANDA', 'PAPER',
  'PARROT', 'PEACH', 'PEARL', 'PEBBLE', 'PEPPER', 'PILOT', 'PINE', 'PIXEL', 'PLANET', 'PLUM',
  'POLAR', 'POPPY', 'PRISM', 'PUFFIN', 'QUARTZ', 'QUILL', 'RADAR', 'RADIO', 'RAVEN', 'REED',
  'RIDGE', 'RIVER', 'ROBIN', 'ROCKET', 'ROSE', 'RUBY', 'SADDLE', 'SAFFRON', 'SAGE', 'SALMON',
  'SAND', 'SCARF', 'SEAL', 'SEVEN', 'SHELL', 'SIGNAL', 'SILVER', 'SLATE', 'SNOW', 'SOLAR',
  'SPARK', 'SPRUCE', 'SQUID', 'STONE', 'STORM', 'SUMMIT', 'SWAN', 'TABLE', 'TANGO', 'THREAD',
  'THUNDER', 'TIDE', 'TIGER', 'TIMBER', 'TOAST', 'TOPAZ', 'TORCH', 'TOWER', 'TRAIL', 'TULIP',
  'TUNDRA', 'TURTLE', 'UMBER', 'VALLEY', 'VELVET', 'VIOLET', 'VOLT', 'WAFFLE', 'WALNUT', 'WALRUS',
  'WAVE', 'WHEAT', 'WILLOW', 'WINTER', 'WREN', 'YARROW', 'YOGURT', 'ZEBRA', 'ZENITH', 'ZINC',
  'ACORN', 'BEETLE', 'CASTLE', 'FOSSIL', 'GRANITE', 'MANTIS',
] as const;

/** Normalize what both sides know: a link token as-is, or an 8-char code without dashes/case. */
export const normalizePairSecret = (raw: string): string => {
  const s = raw.trim().replace(/^#/, '');
  return /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(s) ? s.replace('-', '').toUpperCase() : s;
};

/** Format a manual code as `AMBR-RLY8`; returns null when it isn't 8 base32-ish characters. */
export const formatPairCode = (raw: string): string | null => {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
};

const fnv = (s: string): Uint8Array => {
  // Fallback for insecure contexts without SubtleCrypto: 4 rounds of FNV-1a, enough to pick words.
  const out = new Uint8Array(4);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  for (let i = 0; i < 4; i++) {
    out[i] = (h >>> (i * 8)) & 0xff;
  }
  return out;
};

export const safetyPhrase = async (secret: string): Promise<string[]> => {
  const input = `beamhop-pair-v1:${normalizePairSecret(secret)}`;
  let bytes: Uint8Array;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    bytes = new Uint8Array(digest).slice(0, 4);
  } catch {
    bytes = fnv(input);
  }
  return [...bytes].map((b) => PHRASE_WORDS[b]!);
};

/** Hook: the phrase for a secret (undefined while hashing or when there is no secret). */
export const useSafetyPhrase = (secret: string | undefined): string[] | undefined => {
  const [words, setWords] = useState<string[]>();
  useEffect(() => {
    let live = true;
    setWords(undefined);
    if (secret) void safetyPhrase(secret).then((w) => live && setWords(w));
    return () => {
      live = false;
    };
  }, [secret]);
  return words;
};

/** Token from a pairing URI (`https://app.beamhop.dev/pair#<token>`) or bare fragment. */
export const tokenFromUri = (uri: string): string => {
  const i = uri.indexOf('#');
  return i === -1 ? uri : uri.slice(i + 1);
};
