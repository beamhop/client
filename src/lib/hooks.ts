import { useEffect, useRef, useState } from 'react'

/** Calls callback when Escape is pressed, while enabled is true. Stable across re-renders via ref. */
export function useEscapeKey(callback: () => void, enabled: boolean): void {
  const cbRef = useRef(callback)
  cbRef.current = callback
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') cbRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

/** Locks body scroll while enabled is true, restoring the previous overflow on cleanup. */
export function useBodyScrollLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [enabled])
}

/** Returns true when the viewport width is at or below the breakpoint (default 900px). */
export function useIsMobile(breakpoint = 900): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth <= breakpoint)
  useEffect(() => {
    const update = (): void => setMobile(window.innerWidth <= breakpoint)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [breakpoint])
  return mobile
}
