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

/** Locks body scroll while enabled is true, restoring scroll position on cleanup. */
export function useBodyScrollLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const { body } = document
    const scrollY = window.scrollY
    const prev = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    }
    // iOS ignores overflow:hidden for touchmove — pinning the body is the only
    // reliable lock. Preserve and restore the scroll offset around the lock.
    body.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    return () => {
      body.style.overflow = prev.overflow
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.width = prev.width
      window.scrollTo(0, scrollY)
    }
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
