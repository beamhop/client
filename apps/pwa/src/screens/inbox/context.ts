import type { ApprovalView } from '@beamhop/core';
import { createContext, useContext } from 'react';
import type { SlipGroup } from './model.ts';

export interface InboxActions {
  /** Allow: commits "allow once" for LOW, opens the scope / access sheet otherwise. */
  allow: (g: SlipGroup, opts?: { forceSheet?: boolean }) => void;
  deny: (g: SlipGroup) => void;
  details: (g: SlipGroup) => void;
}

export interface InboxContextValue {
  /** Visible, filtered pending groups in triage order. */
  groups: SlipGroup[];
  /** Every approval the daemon knows (pending + decided), for detail lookups. */
  all: ApprovalView[];
  /** Your names on this daemon (`system.whoami`), to match votes and `decidedBy`. */
  me: ReadonlySet<string>;
  now: number;
  act: InboxActions;
}

export const InboxContext = createContext<InboxContextValue | null>(null);
export const useInbox = () => useContext(InboxContext);
