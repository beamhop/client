import { useCallback, useState } from 'react';
import { useApp } from '../store/AppContext.js';

export interface Composer {
  text: string;
  setText: (t: string) => void;
  charCount: string;
  canPost: boolean;
  submitting: boolean;
  submit: () => Promise<void>;
  isReply: boolean;
}

/**
 * Shared composer logic for the inline home composer and the compose modal.
 * Reads/writes the shared compose text in context and routes to reply vs post.
 */
export function useComposer(onDone?: () => void): Composer {
  const { composeText, setComposeText, replyTarget, engine, toast, closeCompose } = useApp();
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async () => {
    const text = composeText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      if (replyTarget) {
        await engine.reply(replyTarget, text);
        toast('Reply published', 'check');
      } else {
        await engine.post(text);
        toast('Published to relays', 'check');
      }
      setComposeText('');
      closeCompose();
      onDone?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to publish', 'warn');
    } finally {
      setSubmitting(false);
    }
  }, [composeText, submitting, replyTarget, engine, toast, setComposeText, closeCompose, onDone]);

  return {
    text: composeText,
    setText: setComposeText,
    charCount: `${composeText.length} chars`,
    canPost: composeText.trim().length > 0,
    submitting,
    submit,
    isReply: replyTarget !== null,
  };
}
