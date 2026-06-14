import { useState, type ReactNode } from 'react';
import type { ProfileMetadata } from '@verity/core';
import { useApp } from '../store/AppContext.js';
import { Modal } from '../components/Modal.js';
import { Btn } from '../components/common.js';

interface FormState {
  name: string;
  about: string;
  nip05: string;
  website: string;
  picture: string;
  banner: string;
}

const FIELDS: ReadonlyArray<{ key: keyof FormState; label: string; placeholder: string; multiline?: boolean }> = [
  { key: 'name', label: 'Display name', placeholder: 'Maya Okonkwo' },
  { key: 'about', label: 'Bio', placeholder: 'What should people know about you?', multiline: true },
  { key: 'nip05', label: 'NIP-05 identifier', placeholder: 'you@yourdomain.co' },
  { key: 'website', label: 'Website', placeholder: 'https://…' },
  { key: 'picture', label: 'Avatar URL', placeholder: 'https://…/avatar.png' },
  { key: 'banner', label: 'Banner URL', placeholder: 'https://…/banner.png' },
];

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function EditProfileModal(): ReactNode {
  const { state, engine, closeEdit, toast } = useApp();
  const current = state.profiles[state.pubkey]?.metadata;
  const [form, setForm] = useState<FormState>({
    name: asString(current?.name ?? current?.display_name),
    about: asString(current?.about),
    nip05: asString(current?.nip05),
    website: asString(current?.website),
    picture: asString(current?.picture),
    banner: asString(current?.banner),
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const metadata: ProfileMetadata = {
        ...current,
        name: form.name,
        display_name: form.name,
        about: form.about,
        nip05: form.nip05,
        website: form.website,
        picture: form.picture,
        banner: form.banner,
      };
      await engine.setProfile(metadata);
      toast('Profile published to relays', 'check');
      closeEdit();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to publish profile', 'warn');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: '100%',
    border: '1px solid var(--border)',
    borderRadius: 11,
    background: 'var(--surface-2)',
    padding: '11px 13px',
    outline: 'none',
    fontSize: 14.5,
    color: 'var(--text)',
    fontFamily: 'inherit',
  } as const;

  return (
    <Modal
      title="Edit profile"
      onClose={closeEdit}
      testId="edit-modal"
      footer={
        <>
          <div style={{ flex: 1 }} />
          <Btn onClick={closeEdit} style={{ padding: '9px 18px', borderRadius: 999, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </Btn>
          <Btn
            onClick={() => void save()}
            data-testid="save-profile"
            disabled={saving}
            style={{ padding: '9px 22px', borderRadius: 999, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
            activeStyle={{ transform: 'scale(.96)' }}
          >
            {saving ? 'Publishing…' : 'Save'}
          </Btn>
        </>
      }
    >
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {FIELDS.map((field) => (
          <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>{field.label}</span>
            {field.multiline ? (
              <textarea
                data-testid={`field-${field.key}`}
                value={form[field.key]}
                onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
              />
            ) : (
              <input
                data-testid={`field-${field.key}`}
                value={form[field.key]}
                onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                style={inputStyle}
              />
            )}
          </label>
        ))}
      </div>
    </Modal>
  );
}
