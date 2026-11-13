/**
 * Sandbox profiles explained in plain language: a side-by-side comparison (desktop overview when no
 * agent is selected) and a page per profile (/policy/strict|workspace|custom) with who uses it.
 */
import { Check, LockSimple, Minus, X } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { Screen } from '../../shell/Screen.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { PACKAGE_HOSTS, PROFILES, type Profile } from './model.ts';
import { Mono, Section } from './parts.tsx';

type Mark = 'yes' | 'no' | 'some' | 'locked';
const MARK: Record<Mark, ReactNode> = {
  yes: <Check size={16} weight="bold" aria-hidden="true" className="text-go-text" />,
  no: <X size={16} weight="bold" aria-hidden="true" className="text-stop-text" />,
  some: <Minus size={16} weight="bold" aria-hidden="true" className="text-caution-text" />,
  locked: <LockSimple size={16} weight="bold" aria-hidden="true" className="text-ink-2" />,
};

/** Rows of the comparison: capability → per-profile mark + short word. */
const ROWS: Array<{ id: string; cells: Record<Profile, [Mark, string]> }> = [
  { id: 'read', cells: { strict: ['yes', 'mounted'], workspace: ['yes', 'mounted'], custom: ['some', 'your list'] } },
  { id: 'write', cells: { strict: ['no', 'nothing'], workspace: ['yes', 'rw mounts'], custom: ['some', 'your list'] } },
  { id: 'net', cells: { strict: ['some', 'AI provider'], workspace: ['yes', '+ registries'], custom: ['some', 'your list'] } },
  { id: 'private', cells: { strict: ['no', 'blocked'], workspace: ['no', 'blocked'], custom: ['some', 'your choice'] } },
  { id: 'locked', cells: { strict: ['locked', 'never'], workspace: ['locked', 'never'], custom: ['locked', 'never'] } },
];

export const ProfileCompare = () => {
  const agents = useApi('agent.list');
  const roles = useApi('role.list');
  return (
    <Screen title={t('policy.compare.title')} pane="detail" slug={<MetaLine items={[t('policy.compare.slug')]} />}>
      <p className="mb-6 max-w-[62ch] type-body text-ink-2">{t('policy.compare.lead')}</p>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[34rem] border-collapse">
          <caption className="sr-only">{t('policy.compare.caption')}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="w-[34%] px-4 py-3 text-left type-micro font-normal text-ink-2">
                {t('policy.compare.can')}
              </th>
              {PROFILES.map((p) => (
                <th key={p} scope="col" className="px-4 py-3 text-left">
                  <Link to="/policy/$profile" params={{ profile: p }} className="font-mono text-[15px] font-medium text-ink underline-offset-[3px] hover:underline">
                    {p}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-4 py-3 text-left type-body-sm font-normal text-ink">
                  {t(`policy.compare.row.${r.id}` as 'policy.compare.row.read')}
                </th>
                {PROFILES.map((p) => {
                  const [m, word] = r.cells[p];
                  return (
                    <td key={p} className={m === 'locked' ? 'relative px-4 py-3' : 'px-4 py-3'}>
                      {m === 'locked' && <span aria-hidden="true" className="hatch absolute inset-0 text-ink-3" />}
                      <span className="relative inline-flex items-center gap-1.5 type-meta text-ink-2">
                        {MARK[m]}
                        {word}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row" className="px-4 py-3 text-left type-body-sm font-normal text-ink">
                {t('policy.compare.used')}
              </th>
              {PROFILES.map((p) => {
                const names = (agents.data?.agents ?? []).filter((a) => a.config.sandbox.profile === p).map((a) => a.config.name);
                const rs = (roles.data?.roles ?? []).filter((r) => r.sandboxProfile === p).map((r) => r.name);
                return (
                  <td key={p} className="px-4 py-3 align-top type-meta text-ink">
                    {names.join(', ') || '—'}
                    {rs.length > 0 && (
                      <span className="block text-ink-2">{t('policy.compare.roles', { names: rs.join(', ') })}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-4 type-body-sm text-ink-2">{t('policy.compare.foot')}</p>
    </Screen>
  );
};

export const ProfileScreen = ({ profile }: { profile: Profile }) => {
  const agents = useApi('agent.list');
  const roles = useApi('role.list');
  const using = (agents.data?.agents ?? []).filter((a) => a.config.sandbox.profile === profile);
  const rs = (roles.data?.roles ?? []).filter((r) => r.sandboxProfile === profile);
  const bullets = [1, 2, 3].map((i) => t(`policy.profile.${profile}.b${i}` as 'policy.profile.strict.b1'));
  return (
    <Screen
      title={profile}
      back={{ href: '/policy', label: t('nav.policy') }}
      pane="detail"
      maxWidth="prose"
      crumbs={[{ label: t('nav.policy'), href: '/policy' }, { label: profile }]}
      slug={<MetaLine items={[t('policy.profile.slug'), t('policy.list.agentsCount', { count: using.length })]} />}
    >
      <p className="type-body text-ink">{t(`policy.profile.${profile}.blurb`)}</p>
      <Section id="p-means" title={t('policy.profile.means')} className="mt-8">
        <ul className="flex flex-col gap-2">
          {bullets.map((b) => (
            <li key={b} className="flex gap-2.5 type-body-sm text-ink">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 bg-ink" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
        {profile === 'workspace' && (
          <p className="mt-3 type-body-sm text-ink-2">
            {t('policy.profile.registries')}{' '}
            {PACKAGE_HOSTS.map((h, i) => (
              <span key={h}>
                {i > 0 && ', '}
                <Mono>{h}</Mono>
              </span>
            ))}
          </p>
        )}
      </Section>
      <Section id="p-always" title={t('policy.profile.always')} className="mt-8">
        <p className="type-body-sm text-ink">{t('policy.reach.neverNote')}</p>
      </Section>
      <Section id="p-used" title={t('policy.profile.usedBy', { count: using.length })} className="mt-8">
        {using.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('policy.list.unused')}</p>
        ) : (
          <ul className="flex flex-col rounded-lg border border-line bg-surface">
            {using.map((a) => (
              <li key={a.config.name} className="border-b border-line last:border-b-0">
                <Link
                  to="/policy/$profile"
                  params={{ profile: a.config.name }}
                  className="flex min-h-12 items-center justify-between gap-3 px-3 type-body text-ink hover:bg-sunken"
                >
                  {a.config.name}
                  <span className="type-meta text-ink-2">{t('policy.profile.edit')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {rs.length > 0 && (
          <p className="mt-3 type-body-sm text-ink-2">
            {t('policy.profile.rolesDefault', { names: rs.map((r) => r.name).join(', ') })}
          </p>
        )}
      </Section>
      <CliStrip className="mt-8" command={`beamhop agent set <name> --sandbox ${profile}`} />
    </Screen>
  );
};
