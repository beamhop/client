import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import gsap from 'gsap';

export type BunnyState = 'idle' | 'spinner';
export type BunnyExpression = 'neutral' | 'smile' | 'angry';

export interface BeamhopBunnyProps {
  /** Base animation: standing micro-life, or a looping loading hop. */
  state?: BunnyState;
  /** Mouth/brow overlay on top of the base state. */
  expression?: BunnyExpression;
  /** Secret mode — paws cover the eyes. */
  secret?: boolean;
  /** Rendered square size in px. */
  size?: number;
  /** Accessible label (the SVG itself is decorative). */
  label?: string;
}

const EAR_L = -11;
const EAR_R = 11;

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The beamhop bunny mascot. GSAP-driven SVG ported from the brand demo, made
 * instance-safe for React: animated parts use classes (scoped via gsap.context)
 * and gradient/filter ids are unique per instance so multiple bunnies and other
 * SVGs never collide. Honors prefers-reduced-motion.
 */
export function BeamhopBunny({
  state = 'idle',
  expression = 'neutral',
  secret = false,
  size = 64,
  label = 'beamhop bunny',
}: BeamhopBunnyProps): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gBody = `gBody-${uid}`;
  const gEar = `gEar-${uid}`;
  const soft = `soft-${uid}`;
  const glow = `glow-${uid}`;

  // Single context keyed on every visual input. Expression/secret rarely change
  // (the loader never does), so a full re-init on change is fine and avoids
  // cross-context transform-origin bugs.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const reduced = prefersReduced();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const ctx = gsap.context(() => {
      // Fixed SVG-space pivots (constant across the hop so the bunny stays planted).
      gsap.set('.earL', { rotation: EAR_L, svgOrigin: '136 183' });
      gsap.set('.earR', { rotation: EAR_R, svgOrigin: '164 183' });
      gsap.set('.body', { svgOrigin: '150 250' });
      gsap.set('.head', { svgOrigin: '150 226' });
      gsap.set('.eyeL', { svgOrigin: '135 197' });
      gsap.set('.eyeR', { svgOrigin: '165 197' });
      gsap.set('.shadow', { svgOrigin: '150 256' });
      gsap.set('.handL', { svgOrigin: '120 232' });
      gsap.set('.handR', { svgOrigin: '180 232' });
      gsap.set('.mouthSmile', { svgOrigin: '150 218' });

      restPose();
      applyExpression();
      applySecret();
      if (state === 'spinner') (reduced ? buildHopReduced : buildHop)();
      else startIdle();

      function restPose(): void {
        gsap.set('.bunny', { y: 0 });
        gsap.set('.body', { scaleX: 1, scaleY: 1, skewX: 0 });
        gsap.set('.head', { rotation: 0 });
        gsap.set('.face', { x: 0 });
        gsap.set('.earL', { rotation: EAR_L });
        gsap.set('.earR', { rotation: EAR_R });
        gsap.set(['.eyeL', '.eyeR'], { scaleY: 1 });
        gsap.set('.shadow', { scaleX: 1, scaleY: 1, opacity: 0.36 });
      }

      function applyExpression(): void {
        const smile = expression === 'smile';
        const angry = expression === 'angry';
        gsap.set('.mouth', { opacity: smile ? 0 : 0.7 });
        gsap.set('.mouthSmile', { opacity: smile ? 0.9 : 0 });
        gsap.set('.brows', { opacity: angry ? 1 : 0 });
      }

      function applySecret(): void {
        if (!secret) {
          gsap.set('.hands', { opacity: 0 });
          return;
        }
        gsap.set('.hands', { opacity: 1 });
        gsap.set('.handL', { scale: 1, rotation: 0 });
        gsap.set('.handR', { scale: 1, rotation: 0 });
      }

      // ---- spinner: a physical hop, looped ----
      function buildHop(): void {
        const up = -70;
        const tl = gsap.timeline({ repeat: -1 });
        tl.to('.body', { scaleY: 0.82, scaleX: 1.16, duration: 0.1, ease: 'power2.out' }, 0);
        tl.addLabel('launch', 0.1);
        tl.to('.bunny', { y: up, duration: 0.26, ease: 'power2.out' }, 'launch');
        tl.to('.body', { scaleY: 1.2, scaleX: 0.88, duration: 0.14, ease: 'power2.out' }, 'launch');
        tl.to('.body', { scaleY: 1, scaleX: 1, duration: 0.12, ease: 'sine.in' }, 'launch+=0.14');
        tl.to('.earL', { rotation: -30, duration: 0.22, ease: 'power2.out' }, 'launch');
        tl.to('.earR', { rotation: 30, duration: 0.22, ease: 'power2.out' }, 'launch');
        tl.to('.shadow', { scaleX: 0.6, scaleY: 0.7, opacity: 0.16, duration: 0.26, ease: 'power2.out' }, 'launch');
        tl.addLabel('fall', 'launch+=0.26');
        tl.to('.bunny', { y: 0, duration: 0.24, ease: 'power2.in' }, 'fall');
        tl.to('.earL', { rotation: 2, duration: 0.24, ease: 'power1.in' }, 'fall');
        tl.to('.earR', { rotation: -2, duration: 0.24, ease: 'power1.in' }, 'fall');
        tl.to('.shadow', { scaleX: 1.08, scaleY: 1.05, opacity: 0.42, duration: 0.24, ease: 'power2.in' }, 'fall');
        tl.addLabel('land', 'fall+=0.24');
        tl.to('.body', { scaleY: 0.74, scaleX: 1.24, skewX: 8, duration: 0.07, ease: 'power3.in' }, 'land');
        tl.to(['.eyeL', '.eyeR'], { scaleY: 0.35, duration: 0.07, yoyo: true, repeat: 1, ease: 'power2.inOut' }, 'land');
        tl.to('.earL', { rotation: 12, duration: 0.09, ease: 'power2.in' }, 'land');
        tl.to('.earR', { rotation: -12, duration: 0.09, ease: 'power2.in' }, 'land');
        tl.to('.body', { scaleY: 1, scaleX: 1, skewX: 0, duration: 0.5, ease: 'elastic.out(1,0.4)' }, 'land+=0.07');
        tl.to('.earL', { rotation: EAR_L, duration: 0.62, ease: 'elastic.out(1,0.34)' }, 'land+=0.09');
        tl.to('.earR', { rotation: EAR_R, duration: 0.62, ease: 'elastic.out(1,0.34)' }, 'land+=0.09');
        tl.to('.shadow', { scaleX: 1, scaleY: 1, opacity: 0.36, duration: 0.4, ease: 'elastic.out(1,0.5)' }, 'land+=0.07');
        tl.to({}, { duration: 0.16 });
      }

      function buildHopReduced(): void {
        const tl = gsap.timeline({ repeat: -1, yoyo: true });
        tl.to('.bunny', { y: -14, duration: 0.7, ease: 'sine.inOut' }).to(
          '.body',
          { scaleY: 0.96, scaleX: 1.03, duration: 0.7, ease: 'sine.inOut' },
          0,
        );
      }

      // ---- idle: stand + random micro-life ----
      function blink(): void {
        gsap.to(['.eyeL', '.eyeR'], { scaleY: 0.1, duration: 0.06, yoyo: true, repeat: 1, ease: 'power2.inOut', overwrite: 'auto' });
      }
      function foldEar(): void {
        const left = Math.random() < 0.5;
        const sel = left ? '.earL' : '.earR';
        const rest = left ? EAR_L : EAR_R;
        const fold = left ? 40 : -40;
        gsap.to(sel, {
          rotation: fold,
          duration: 0.16,
          ease: 'power2.out',
          overwrite: 'auto',
          onComplete: () => gsap.to(sel, { rotation: rest, duration: 0.7, ease: 'elastic.out(1,0.4)' }),
        });
      }
      function lookAround(): void {
        const dir = Math.random() < 0.5 ? -1 : 1;
        gsap.to('.head', { rotation: 7 * dir, duration: 0.45, ease: 'power2.out', overwrite: 'auto' });
        gsap.to('.face', {
          x: 6 * dir,
          duration: 0.45,
          ease: 'power2.out',
          overwrite: 'auto',
          onComplete: () => {
            gsap.to('.head', { rotation: 0, duration: 0.7, ease: 'power2.inOut', delay: 0.55 });
            gsap.to('.face', { x: 0, duration: 0.7, ease: 'power2.inOut', delay: 0.55 });
          },
        });
        if (Math.random() < 0.5) gsap.delayedCall(0.2, blink);
      }
      function twitch(): void {
        gsap.to('.earL', { rotation: EAR_L - 3.5, duration: 0.09, yoyo: true, repeat: 3, ease: 'sine.inOut', overwrite: 'auto' });
        gsap.to('.earR', { rotation: EAR_R + 3.5, duration: 0.09, yoyo: true, repeat: 3, ease: 'sine.inOut', overwrite: 'auto' });
      }
      function scheduleIdle(): void {
        const acts = [blink, blink, foldEar, lookAround, twitch, blink];
        const pick = acts[Math.floor(Math.random() * acts.length)];
        pick?.();
        idleTimer = setTimeout(scheduleIdle, 1100 + Math.random() * 2700);
      }
      function startIdle(): void {
        if (reduced) return;
        gsap.to('.body', { scaleY: 1.03, scaleX: 0.99, duration: 1.7, ease: 'sine.inOut', yoyo: true, repeat: -1 });
        scheduleIdle();
      }
    }, root);

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      ctx.revert();
    };
  }, [state, expression, secret]);

  const wrap: CSSProperties = { width: size, height: size, display: 'inline-flex' };

  return (
    <div ref={rootRef} role="img" aria-label={label} style={wrap}>
      <svg width="100%" height="100%" viewBox="0 0 300 320" aria-hidden>
        <defs>
          <radialGradient id={gBody} cx="50%" cy="34%" r="72%">
            <stop offset="0%" stopColor="#9DF8EA" />
            <stop offset="52%" stopColor="#5EEAD4" />
            <stop offset="100%" stopColor="#39BCAD" />
          </radialGradient>
          <radialGradient id={gEar} cx="50%" cy="20%" r="90%">
            <stop offset="0%" stopColor="#8FF6E6" />
            <stop offset="100%" stopColor="#48CDBC" />
          </radialGradient>
          <filter id={soft} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <ellipse className="shadow" cx="150" cy="256" rx="50" ry="11" fill="#000" opacity="0.36" filter={`url(#${soft})`} />

        <g className="bunny">
          <g className="body">
            <g className="head">
              <g className="earL">
                <ellipse cx="136" cy="142" rx="12" ry="41" fill={`url(#${gEar})`} />
                <ellipse cx="136" cy="140" rx="5.4" ry="29" fill="#8B7BFF" opacity="0.7" />
              </g>
              <g className="earR">
                <ellipse cx="164" cy="142" rx="12" ry="41" fill={`url(#${gEar})`} />
                <ellipse cx="164" cy="140" rx="5.4" ry="29" fill="#8B7BFF" opacity="0.7" />
              </g>

              <circle className="blob" cx="150" cy="204" r="46" fill={`url(#${gBody})`} filter={`url(#${glow})`} />

              <g className="face">
                <ellipse cx="128" cy="210" rx="9" ry="6" fill="#8B7BFF" opacity="0.22" />
                <ellipse cx="172" cy="210" rx="9" ry="6" fill="#8B7BFF" opacity="0.22" />

                <g className="brows" opacity="0">
                  <path d="M125 189 L145 196" stroke="#0A0E1A" strokeWidth="3.6" strokeLinecap="round" />
                  <path d="M175 189 L155 196" stroke="#0A0E1A" strokeWidth="3.6" strokeLinecap="round" />
                </g>

                <g className="eyeL">
                  <circle cx="135" cy="197" r="6" fill="#0A0E1A" />
                  <circle cx="133" cy="194.5" r="1.8" fill="#EAF0FF" />
                </g>
                <g className="eyeR">
                  <circle cx="165" cy="197" r="6" fill="#0A0E1A" />
                  <circle cx="163" cy="194.5" r="1.8" fill="#EAF0FF" />
                </g>

                <path d="M150 215 l-4.5 -5 h9 z" fill="#8B7BFF" />

                <path className="mouth" d="M150 215 q0 6 -6 8 M150 215 q0 6 6 8" stroke="#2C8E83" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity="0.7" />
                <path className="mouthSmile" d="M150 217 q-7 4 -13 -3 M150 217 q7 4 13 -3" stroke="#2C8E83" strokeWidth="1.9" fill="none" strokeLinecap="round" opacity="0" />

                <g className="hands" opacity="0">
                  <g className="handL">
                    <path d="M120 232 Q124 209 135 201" stroke="#2C8E83" strokeWidth="17" fill="none" strokeLinecap="round" />
                    <path d="M120 232 Q124 209 135 201" stroke="#54D9C9" strokeWidth="13" fill="none" strokeLinecap="round" />
                    <ellipse cx="135" cy="198" rx="13" ry="15" fill={`url(#${gBody})`} stroke="#2C8E83" strokeWidth="1.6" />
                    <circle cx="129" cy="187" r="3.4" fill={`url(#${gBody})`} />
                    <circle cx="135" cy="185" r="3.6" fill={`url(#${gBody})`} />
                    <circle cx="141" cy="187" r="3.4" fill={`url(#${gBody})`} />
                    <ellipse cx="135" cy="201" rx="6" ry="7.5" fill="#8B7BFF" opacity="0.4" />
                  </g>
                  <g className="handR">
                    <path d="M180 232 Q176 209 165 201" stroke="#2C8E83" strokeWidth="17" fill="none" strokeLinecap="round" />
                    <path d="M180 232 Q176 209 165 201" stroke="#54D9C9" strokeWidth="13" fill="none" strokeLinecap="round" />
                    <ellipse cx="165" cy="198" rx="13" ry="15" fill={`url(#${gBody})`} stroke="#2C8E83" strokeWidth="1.6" />
                    <circle cx="159" cy="187" r="3.4" fill={`url(#${gBody})`} />
                    <circle cx="165" cy="185" r="3.6" fill={`url(#${gBody})`} />
                    <circle cx="171" cy="187" r="3.4" fill={`url(#${gBody})`} />
                    <ellipse cx="165" cy="201" rx="6" ry="7.5" fill="#8B7BFF" opacity="0.4" />
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
