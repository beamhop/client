import { useMemo, type ReactNode } from "react";
import { tokenizeMentions } from "@beamhop/nostr";
import { ProfileToastChip } from "./ProfileToastChip.tsx";

/**
 * Render note text with an inline profile chip wherever someone is mentioned by
 * their public key (`@npub1…` / `nostr:npub1…` / `nostr:nprofile1…`). Plain runs
 * are emitted as bare strings so the parent paragraph's `white-space: pre-wrap`
 * keeps the author's spacing and line breaks intact.
 */
export const PostContent = ({ text }: { text: string }): ReactNode => {
  const tokens = useMemo(() => tokenizeMentions(text), [text]);
  return (
    <>
      {tokens.map((token, i) =>
        token.type === "mention" ? (
          <ProfileToastChip key={`mention-${i}`} pubkey={token.pubkey} />
        ) : (
          token.value
        ),
      )}
    </>
  );
};
