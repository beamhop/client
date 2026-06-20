import type { NostrEvent } from '../nostr/types'

/** Copies the canonical note URL to the clipboard and fires a success toast. */
export async function shareNote(
  note: NostrEvent,
  toast: (msg: string, tone?: 'check' | 'info' | 'warn' | 'copy' | 'repost') => void,
): Promise<void> {
  const url = `${window.location.origin}/#/note/${note.id}`
  await navigator.clipboard?.writeText(url)
  toast('Link copied to clipboard', 'copy')
}
