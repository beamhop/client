/**
 * TODO(pairing builder): Device pairing (hosted PWA side) — SCREENS §0.1 /pair, JOURNEYS §9.
 * Owns: src/screens/pair/**. Route: /pair (token in the URL fragment: /pair#<one-time token>), bare chrome.
 * Build: "Pair with Alice's MacBook", device name (prefilled from UA), 4-word safety phrase, Enter code
 * (paste allowed), NIP-46 / NIP-07 alternatives, then install + push flow.
 * Data: 'device.pairComplete' (over the Nostr control transport once it exists — see api/nostr.ts).
 */
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { Wordmark } from '../../shell/Wordmark.tsx';
import { QrCode } from '../../ui/QrCode.tsx';

export const PairScreen = () => (
  <div
    className="mx-auto flex min-h-svh max-w-[560px] flex-col gap-6 px-gutter pt-[calc(var(--bh-safe-top)+24px)] pb-10"
    id="bh-main-content"
  >
    <Wordmark />
    <h1 className="type-title-1 text-ink">Pair with your computer</h1>
    <p className="type-body text-ink-2">
      Scan the code that <code className="font-mono text-[0.875em] text-ink">beamhop pair-device</code> shows,
      or enter the 8-character code.
    </p>
    <QrCode value="https://app.beamhop.dev/pair#demo" label="Example pairing QR code" size={200} />
    <ScreenStub
      spec="JOURNEYS §9"
      owner="src/screens/pair/"
      outline={[
        'Device name + 4-word safety phrase',
        'Confirm happens on the computer (trusted side)',
        'Install sheet (iOS instructions / Android prompt)',
        'Push permission after a purpose pre-prompt',
      ]}
    />
  </div>
);
