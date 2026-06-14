import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import gsap from 'gsap';

const SVGNS = 'http://www.w3.org/2000/svg';
const WORD = 'beamhop';
const FS = 56;
const BASE = 250;
const CENTER = 400;
const BEAM = '#5EEAD4';
const INK = 'var(--text)';
// Which glyphs are teal ("beam" + the o); the rest ("h", "p") use theme ink.
const BEAM_IDX = new Set([0, 1, 2, 3, 5]);

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Glyph {
  el: SVGTextElement | null; // null for the "o" slot (filled by the packet)
  cx: number;
  cy: number;
  topY: number;
}

export interface BeamhopLogoAnimatedProps {
  /** Wrapper styles. The SVG fills its container width; constrain via the parent. */
  style?: CSSProperties;
}

/**
 * Animated beamhop wordmark, ported from the brand demo: on mount a scan beam
 * writes "beam", a packet hops across the letters and lands as the "o", then on
 * hover the "o" morphs into a rabbit head. GSAP-driven, instance-safe (scoped
 * selectors + unique def ids), and falls back to a static wordmark under
 * prefers-reduced-motion.
 */
export function BeamhopLogoAnimated({ style }: BeamhopLogoAnimatedProps): ReactNode {
  const rootRef = useRef<SVGSVGElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ID = (name: string): string => `${name}-${uid}`;
  const url = (name: string): string => `url(#${ID(name)})`;

  useEffect(() => {
    const svg = rootRef.current;
    if (!svg) return undefined;
    const root = svg; // non-null binding for use inside hoisted closures
    const reduced = prefersReduced();
    let settled = false;
    let isRabbit = false;
    let cleanupHover: (() => void) | undefined;
    let ctx: ReturnType<typeof gsap.context> | undefined;
    let cancelled = false;

    const setup = (): void => {
      if (cancelled) return;
      ctx = gsap.context(() => {
      const q = <T extends Element>(s: string): T => root.querySelector(s) as T;
      const set = (s: string, v: gsap.TweenVars): void => void gsap.set(s, v);
      let sweepWidth = 0;

      const packet = q<SVGGElement>('.packet');
      const body = q<SVGEllipseElement>('.packetBody');
      const ears = q<SVGGElement>('.ears');
      set('.packet', { transformOrigin: '50% 50%' });
      set('.packetBody', { transformOrigin: '50% 100%' });
      set('.ears', { transformOrigin: '50% 100%' });

      const LET = layoutWord();

      // rabbit rest state
      set('.rFace', { transformOrigin: '50% 50%' });
      set('.rEarL', { rotation: -16, scaleY: 0, transformOrigin: '50% 100%' });
      set('.rEarR', { rotation: 16, scaleY: 0, transformOrigin: '50% 100%' });

      if (reduced) showStatic();
      else play();

      const box = q<SVGRectElement>('.hoverbox');
      const onEnter = (): void => { if (settled) setRabbit(true); };
      const onLeave = (): void => { if (settled) setRabbit(false); };
      box.addEventListener('pointerenter', onEnter);
      box.addEventListener('pointerleave', onLeave);
      cleanupHover = () => {
        box.removeEventListener('pointerenter', onEnter);
        box.removeEventListener('pointerleave', onLeave);
      };

      // ---- layout: measure real glyph metrics, place letters, crop viewBox ----
      function layoutWord(): Glyph[] {
        const wm = q<SVGGElement>('.wordmark');
        wm.textContent = '';
        const ref = document.createElementNS(SVGNS, 'text');
        ref.setAttribute('x', String(CENTER));
        ref.setAttribute('y', String(BASE));
        ref.setAttribute('text-anchor', 'middle');
        ref.setAttribute('font-size', String(FS));
        ref.setAttribute('font-weight', '700');
        ref.setAttribute('letter-spacing', '-1');
        ref.setAttribute('opacity', '0');
        ref.textContent = WORD;
        wm.appendChild(ref);

        const glyphs: Glyph[] = [];
        for (let i = 0; i < WORD.length; i++) {
          const start = ref.getStartPositionOfChar(i);
          const ext = ref.getExtentOfChar(i);
          const cx = ext.x + ext.width / 2;
          const cy = ext.y + ext.height / 2;
          const topY = ext.y;
          if (i === 5) {
            const o = q<SVGTextElement>('.oGlyph');
            o.setAttribute('x', String(start.x));
            o.setAttribute('y', String(BASE));
            o.setAttribute('letter-spacing', '-1');
            set('.oGlyph', { transformOrigin: '50% 50%' });
            glyphs.push({ el: null, cx, cy, topY });
            continue;
          }
          const t = document.createElementNS(SVGNS, 'text');
          t.setAttribute('x', String(start.x));
          t.setAttribute('y', String(BASE));
          t.setAttribute('font-size', String(FS));
          t.setAttribute('font-weight', '700');
          t.setAttribute('letter-spacing', '-1');
          if (BEAM_IDX.has(i)) t.setAttribute('fill', BEAM);
          else t.style.fill = INK;
          t.textContent = WORD[i] ?? '';
          wm.appendChild(t);
          gsap.set(t, { transformOrigin: '50% 100%' });
          glyphs.push({ el: t, cx, cy, topY });
        }
        ref.remove();

        const first = glyphs[0];
        const last = glyphs[WORD.length - 1];
        const o = glyphs[5];
        if (!first || !last || !o) return glyphs;

        const sweep = q<SVGRectElement>('.sweep');
        sweep.setAttribute('x', String(first.cx - 18));
        sweep.setAttribute('y', String(BASE + 9));
        sweepWidth = last.cx + 18 - (first.cx - 18);

        q<SVGGElement>('.rabbit').setAttribute('transform', `translate(${o.cx},${o.cy})`);

        // Crop the viewBox tight to the word so the resting wordmark fills the
        // container width. The intro hop overflows above (svg overflow:visible),
        // so we only need a little headroom here.
        const bb = wm.getBBox();
        const padX = 6;
        const padTop = 8;
        const padBottom = 10;
        const vx = bb.x - padX;
        const vy = bb.y - padTop;
        const vw = bb.width + padX * 2;
        const vh = bb.height + padTop + padBottom;
        root.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);

        const hb = q<SVGRectElement>('.hoverbox');
        hb.setAttribute('x', String(vx));
        hb.setAttribute('y', String(vy));
        hb.setAttribute('width', String(vw));
        hb.setAttribute('height', String(vh));

        // Confine the flash to the logo box (it's only a brief reveal pop).
        const flash = q<SVGRectElement>('.flash');
        flash.setAttribute('x', String(vx));
        flash.setAttribute('y', String(vy));
        flash.setAttribute('width', String(vw));
        flash.setAttribute('height', String(vh));
        return glyphs;
      }

      function squish(tl: gsap.core.Timeline, t: number, el: SVGTextElement): void {
        tl.to(el, { scaleY: 0.7, scaleX: 1.04, skewX: -8, duration: 0.09, ease: 'power3.in' }, t);
        tl.to(el, { scaleY: 1, scaleX: 1, skewX: 0, duration: 0.55, ease: 'elastic.out(1,0.4)' }, t + 0.09);
      }

      function hop(tl: gsap.core.Timeline, t: number, from: { x: number; y: number }, to: { x: number; y: number }, h: number, dur: number): number {
        tl.to(body, { scaleX: 1.28, scaleY: 0.74, duration: 0.1, ease: 'power2.out' }, t);
        const L = t + 0.1;
        const peakY = Math.min(from.y, to.y) - h;
        tl.fromTo(packet, { x: from.x }, { x: to.x, duration: dur, ease: 'none', immediateRender: false }, L);
        tl.fromTo(packet, { y: from.y }, { y: peakY, duration: dur * 0.5, ease: 'power2.out', immediateRender: false }, L);
        tl.to(packet, { y: to.y, duration: dur * 0.5, ease: 'power2.in' }, L + dur * 0.5);
        tl.to(body, { scaleX: 0.82, scaleY: 1.28, duration: 0.14, ease: 'power2.out' }, L);
        tl.to(body, { scaleX: 1, scaleY: 1, duration: dur * 0.5, ease: 'sine.in' }, L + dur * 0.5);
        tl.to(ears, { rotation: -18, duration: 0.16, ease: 'power2.out' }, L);
        tl.to(ears, { rotation: 10, duration: 0.18, ease: 'power1.inOut' }, L + dur * 0.55);
        const land = L + dur;
        tl.to(body, { scaleX: 1.36, scaleY: 0.62, duration: 0.07, ease: 'power3.in' }, land - 0.02);
        tl.to(body, { scaleX: 1, scaleY: 1, duration: 0.42, ease: 'elastic.out(1,0.45)' }, land + 0.05);
        tl.to(ears, { rotation: 0, duration: 0.5, ease: 'elastic.out(1,0.4)' }, land + 0.05);
        return land;
      }

      function buildTimeline(): gsap.core.Timeline {
        settled = false;
        isRabbit = false;
        set('.rabbit', { opacity: 0 });
        set('.rEarL,.rEarR', { scaleY: 0 });
        LET.forEach((g) => { if (g.el) gsap.set(g.el, { opacity: 0, y: 14, scaleX: 1, scaleY: 1, skewX: 0 }); });
        set('.oGlyph', { opacity: 0, scale: 0 });
        set('.sweep', { opacity: 0, attr: { width: 0 } });
        set('.flash', { opacity: 0 });
        gsap.set(body, { scaleX: 1, scaleY: 1, opacity: 1 });
        gsap.set(ears, { rotation: 0, scale: 1, opacity: 1 });
        set('.halo', { opacity: 0.18 });
        set('.scanbeam', { opacity: 0 });

        const first = LET[0];
        if (!first) return gsap.timeline();
        const START = { x: first.cx - 115, y: first.topY - 15 };
        gsap.set(packet, { opacity: 0, scale: 0, x: START.x, y: START.y });

        const tl = gsap.timeline({ onComplete: () => { settled = true; } });

        // --- scan beam writes B, e, a, m ---
        const beamY = (first.topY + BASE) / 2;
        const m = LET[3];
        const x0 = first.cx - 42;
        const xEnd = (m ? m.cx : first.cx) + 24;
        const SWEEP = 0.9;
        const TRAIL = 160;
        const leftBound = x0 - 34;
        set('.beamGlow', { attr: { y: beamY - 9 } });
        set('.beamBar', { attr: { y: beamY - 2.5 } });
        set('.beamCore', { attr: { y: beamY - 1 } });
        set('.beamHead', { attr: { cx: x0, cy: beamY } });
        set('.beamGlow,.beamBar,.beamCore', { attr: { width: 0 } });

        const bs = { head: x0 };
        const renderBeam = (len: number | null): void => {
          const head = bs.head;
          const useLen = len == null ? Math.min(TRAIL, head - leftBound) : len;
          const left = head - useLen;
          const w = Math.max(0, useLen);
          for (const s of ['.beamGlow', '.beamBar', '.beamCore']) {
            const e = q<SVGRectElement>(s);
            e.setAttribute('x', String(left));
            e.setAttribute('width', String(w));
          }
          q<SVGEllipseElement>('.beamHead').setAttribute('cx', String(head));
        };
        const reveal = (g: Glyph | undefined, at: number): void => {
          if (g?.el) tl.to(g.el, { opacity: 1, y: 0, duration: 0.32, ease: 'power2.out' }, at);
        };

        tl.to('.scanbeam', { opacity: 1, duration: 0.12 }, 0);
        tl.to(bs, { head: xEnd, duration: SWEEP, ease: 'none', onUpdate: () => renderBeam(null) }, 0);
        [0, 1, 2, 3].forEach((i) => {
          const g = LET[i];
          if (!g) return;
          const at = ((g.cx - x0) / (xEnd - x0)) * SWEEP;
          reveal(g, Math.max(0, at - 0.04));
        });
        reveal(LET[4], SWEEP); // h
        const ls = { len: TRAIL };
        tl.to(ls, { len: 0, duration: 0.36, ease: 'power2.in', onUpdate: () => renderBeam(ls.len) }, SWEEP);
        tl.to('.scanbeam', { opacity: 0, duration: 0.36, ease: 'power2.in' }, SWEEP + 0.04);
        reveal(LET[6], SWEEP + 0.12); // p

        // --- packet arrives and hops along the letters ---
        tl.fromTo(packet, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.34, ease: 'back.out(2.2)', immediateRender: false }, SWEEP + 0.25);
        tl.to(packet, { y: START.y - 10, duration: 0.22, yoyo: true, repeat: 1, ease: 'sine.inOut' }, SWEEP + 0.4);
        let t = SWEEP + 0.75;
        let pos = START;
        const letterHop = (g: Glyph | undefined, h: number, dur: number, gap: number, squishIt: boolean, asO: boolean): number => {
          if (!g) return t;
          const target = asO ? { x: g.cx, y: g.cy } : { x: g.cx, y: g.topY - 15 };
          const land = hop(tl, t, pos, target, h, dur);
          if (squishIt && g.el) squish(tl, land, g.el);
          pos = target;
          t = land + gap;
          return land;
        };
        letterHop(LET[0], 70, 0.5, 0.07, true, false);
        [1, 2, 3, 4].forEach((i) => letterHop(LET[i], 56, 0.34, 0.06, true, false));

        // --- drop into the o slot and become the o ---
        const oLand = letterHop(LET[5], 50, 0.36, 0, false, true);
        tl.to('.ears', { scale: 0, opacity: 0, duration: 0.18, ease: 'power2.in' }, oLand);
        tl.to('.halo', { opacity: 0, duration: 0.3 }, oLand);
        tl.to('.flash', { opacity: 0.5, duration: 0.06 }, oLand + 0.02).to('.flash', { opacity: 0, duration: 0.45 }, oLand + 0.08);
        tl.to(body, { opacity: 0, duration: 0.22, ease: 'power2.in' }, oLand + 0.06);
        tl.fromTo('.oGlyph', { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'elastic.out(1,0.5)', immediateRender: false }, oLand + 0.04);

        // --- underline sweep ---
        const w = oLand + 0.5;
        tl.to('.sweep', { opacity: 1, attr: { width: sweepWidth }, duration: 0.5, ease: 'power3.out' }, w);
        tl.to('.sweep', { opacity: 0.5, duration: 0.4 }, w + 0.5);
        return tl;
      }

      function showStatic(): void {
        set('.scanbeam', { opacity: 0 });
        LET.forEach((g) => { if (g.el) gsap.set(g.el, { opacity: 1, y: 0 }); });
        set('.oGlyph', { opacity: 1, scale: 1 });
        set('.sweep', { opacity: 0.5, attr: { width: sweepWidth } });
        set('.packet', { opacity: 0 });
        settled = true;
      }

      function play(): void {
        buildTimeline();
      }

      function setRabbit(on: boolean): void {
        if (on === isRabbit) return;
        isRabbit = on;
        if (on) {
          gsap.to('.oGlyph', { opacity: 0, scale: 0.55, duration: 0.16, ease: 'power2.in' });
          gsap.to('.rabbit', { opacity: 1, duration: 0.12 });
          gsap.fromTo('.rFace', { scale: 0.6 }, { scale: 1, duration: 0.34, ease: 'back.out(2.4)' });
          gsap.fromTo('.rFeatures', { opacity: 0 }, { opacity: 1, duration: 0.2, delay: 0.08 });
          gsap.to('.rEarL,.rEarR', { scaleY: 1, duration: 0.55, ease: 'elastic.out(1,0.45)' });
        } else {
          gsap.to('.rEarL,.rEarR', { scaleY: 0, duration: 0.2, ease: 'power2.in' });
          gsap.to('.rabbit', { opacity: 0, duration: 0.22, ease: 'power2.in' });
          gsap.to('.oGlyph', { opacity: 1, scale: 1, duration: 0.28, ease: 'back.out(1.8)', delay: 0.04 });
        }
      }
      }, root);
    };

    // Measure glyphs once the brand font is ready, else metrics use a fallback
    // font and the packet lands off the letters.
    if (typeof document !== 'undefined' && document.fonts && document.fonts.status !== 'loaded') {
      void document.fonts.ready.then(() => {
        if (!cancelled) requestAnimationFrame(setup);
      });
    } else {
      setup();
    }

    return () => {
      cancelled = true;
      cleanupHover?.();
      const wm = root.querySelector('.wordmark');
      if (wm) wm.textContent = '';
      ctx?.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <svg
      ref={rootRef}
      viewBox="0 0 800 450"
      role="img"
      aria-label="beamhop"
      data-testid="beamhop-logo"
      style={{ display: 'block', width: '100%', height: 'auto', overflow: 'visible', pointerEvents: 'none', ...style }}
    >
      <defs>
        <radialGradient id={ID('gBeam')} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FDFBFF" />
          <stop offset="35%" stopColor="#5EEAD4" />
          <stop offset="100%" stopColor="#8B7BFF" />
        </radialGradient>
        <linearGradient id={ID('gWire')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#5EEAD4" />
          <stop offset="100%" stopColor="#8B7BFF" />
        </linearGradient>
        <linearGradient id={ID('gScan')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#38E1FF" stopOpacity="0" />
          <stop offset="50%" stopColor="#38E1FF" stopOpacity="0.3" />
          <stop offset="84%" stopColor="#7DF9FF" stopOpacity="0.82" />
          <stop offset="100%" stopColor="#EAFEFF" stopOpacity="1" />
        </linearGradient>
        <linearGradient id={ID('gScanCore')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#EAFEFF" stopOpacity="0" />
          <stop offset="72%" stopColor="#CFF7FF" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="1" />
        </linearGradient>
        <filter id={ID('glow')} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={ID('softglow')} x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      <g className="scanbeam" opacity="0">
        <rect className="beamGlow" x="0" y="0" width="0" height="18" rx="9" fill={url('gScan')} filter={url('softglow')} opacity="0.6" />
        <rect className="beamBar" x="0" y="0" width="0" height="5" rx="2.5" fill={url('gScan')} opacity="0.95" />
        <rect className="beamCore" x="0" y="0" width="0" height="2" rx="1" fill={url('gScanCore')} />
        <ellipse className="beamHead" cx="0" cy="0" rx="9" ry="6" fill="#F2FFFF" filter={url('glow')} />
      </g>

      <g className="wordmark" />
      <text className="oGlyph" fontSize="56" fontWeight="700" fill={BEAM} filter={url('glow')} opacity="0">o</text>

      <g className="rabbit" opacity="0">
        <g className="rEarL">
          <ellipse cx="-6" cy="-23" rx="4.6" ry="13" fill={url('gBeam')} />
          <ellipse cx="-6" cy="-23" rx="2" ry="8.5" fill="#8B7BFF" opacity="0.65" />
        </g>
        <g className="rEarR">
          <ellipse cx="6" cy="-23" rx="4.6" ry="13" fill={url('gBeam')} />
          <ellipse cx="6" cy="-23" rx="2" ry="8.5" fill="#8B7BFF" opacity="0.65" />
        </g>
        <circle className="rFace" cx="0" cy="0" r="14" fill={url('gBeam')} filter={url('glow')} />
        <g className="rFeatures">
          <circle cx="-5" cy="-2" r="2.1" fill="#0B0E1A" />
          <circle cx="5" cy="-2" r="2.1" fill="#0B0E1A" />
          <path d="M0 3 l-2.6 -2.8 h5.2 z" fill="#8B7BFF" />
        </g>
      </g>

      <rect className="sweep" x="0" y="0" width="0" height="2.5" rx="1.5" fill={url('gWire')} opacity="0" />
      <rect className="flash" x="0" y="0" width="0" height="0" fill="#FDFBFF" opacity="0" />
      <rect className="hoverbox" fill="transparent" style={{ pointerEvents: 'all', cursor: 'pointer' }} />

      <g className="packet" opacity="0">
        <circle className="halo" r="22" fill="#5EEAD4" opacity="0.18" filter={url('softglow')} />
        <g className="ears">
          <path d="M-7 -12 C -10 -28, -2 -30, -2 -14 Z" fill={url('gBeam')} />
          <path d="M 7 -12 C 10 -28, 2 -30, 2 -14 Z" fill={url('gBeam')} />
        </g>
        <ellipse className="packetBody" rx="13" ry="15" fill={url('gBeam')} filter={url('glow')} />
      </g>
    </svg>
  );
}
