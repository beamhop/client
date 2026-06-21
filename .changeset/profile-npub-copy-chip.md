---
"@beamhop/client": minor
---

feat(client): copyable public-key chip on every profile

The profile identity header now renders a compact, pill-shaped chip showing the
abbreviated `npub`; clicking it copies the full bech32 public key to the
clipboard. Previously only your own profile exposed key-copying (as a full-width
bar) and other people's profiles offered no way to grab their key at all. The
chip replaces that self-only bar and sits beside the verified NIP-05 handle.
