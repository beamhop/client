import { useState, type ReactNode } from 'react';
import { DEFAULT_RELAYS } from '@verity/core';
import { useApp } from '../store/AppContext.js';
import { Modal } from '../components/Modal.js';
import { Btn } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { normalizeRelayUrl } from '../lib/session.js';

export function RelaysModal(): ReactNode {
  const { state, engine, closeRelays, toast } = useApp();
  const [relays, setRelays] = useState<string[]>([...state.relays]);
  const [draft, setDraft] = useState('');

  const add = () => {
    const url = normalizeRelayUrl(draft);
    if (!url) {
      toast('Enter a valid ws:// or wss:// relay URL', 'warn');
      return;
    }
    if (relays.includes(url)) {
      toast('That relay is already in your list', 'info');
      return;
    }
    setRelays((r) => [...r, url]);
    setDraft('');
  };

  const remove = (url: string) => setRelays((r) => r.filter((x) => x !== url));

  const save = () => {
    if (relays.length === 0) {
      toast('Keep at least one relay', 'warn');
      return;
    }
    engine.setRelays(relays);
    toast('Relays updated', 'check');
    closeRelays();
  };

  return (
    <Modal
      title="Manage relays"
      onClose={closeRelays}
      testId="relays-modal"
      footer={
        <>
          <Btn
            onClick={() => setRelays([...DEFAULT_RELAYS])}
            data-testid="reset-relays"
            style={{ padding: '9px 16px', borderRadius: 999, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-2)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}
          >
            Reset to defaults
          </Btn>
          <div style={{ flex: 1 }} />
          <Btn onClick={closeRelays} style={{ padding: '9px 18px', borderRadius: 999, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </Btn>
          <Btn
            onClick={save}
            data-testid="save-relays"
            style={{ padding: '9px 22px', borderRadius: 999, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
            activeStyle={{ transform: 'scale(.96)' }}
          >
            Save
          </Btn>
        </>
      }
    >
      <div style={{ padding: 20 }}>
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Verity reads from and publishes to these relays. Add the relays your team uses, or remove ones you don't trust.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            data-testid="relay-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder="wss://relay.example.com"
            style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 11, background: 'var(--surface-2)', padding: '11px 13px', outline: 'none', fontSize: 14, color: 'var(--text)', fontFamily: "'JetBrains Mono',monospace" }}
          />
          <Btn
            onClick={add}
            data-testid="add-relay"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 16px', borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
          >
            <Icon name="plus" size={16} strokeWidth={2.4} />
            Add
          </Btn>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {relays.map((url) => (
            <div
              key={url}
              data-testid="relay-row"
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 11, background: 'var(--surface-2)' }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
              <code style={{ flex: 1, fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</code>
              <Btn
                onClick={() => remove(url)}
                aria-label={`Remove ${url}`}
                data-testid="remove-relay"
                style={{ display: 'flex', padding: 6, border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--text-3)', cursor: 'pointer' }}
                hoverStyle={{ background: 'var(--surface-3)', color: 'var(--danger)' }}
              >
                <Icon name="x" size={16} strokeWidth={2.2} />
              </Btn>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
