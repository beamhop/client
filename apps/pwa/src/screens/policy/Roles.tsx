/**
 * Roles — "what can each role do" (SCREENS §7 Roles, JOURNEYS §5.7). Desktop: a real table, rows =
 * actions, columns = roles, cells = shape + word (Auto / Asks owner / Never). Compact: one disclosure per
 * role with the action list inside (no horizontal table scrolling). Read-only here: there's no role
 * edit RPC yet, so the CLI strip shows how.
 */
import type { RoleDef } from '@beamhop/core';
import { CaretRight, Check, HandPalm, X } from '@phosphor-icons/react';
import { Disclosure, DisclosurePanel, Heading, Button as RACButton } from 'react-aria-components';
import { useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { useExpanded } from '../../lib/media.ts';
import { Screen } from '../../shell/Screen.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { Mono, Section } from './parts.tsx';
import { CELL_WORD, type Cell, cellFor, DLP_WORD, limitsOf, ROLE_ACTIONS } from './roles.ts';

const CellMark = ({ c }: { c: Cell }) => (
  <span
    className={cx(
      'inline-flex items-center gap-1.5 type-meta whitespace-nowrap',
      c === 'auto' ? 'text-go-text' : c === 'ask' ? 'text-caution-text' : 'text-ink-2',
    )}
  >
    {c === 'auto' ? (
      <Check size={14} weight="bold" aria-hidden="true" />
    ) : c === 'ask' ? (
      <HandPalm size={14} weight="bold" aria-hidden="true" />
    ) : (
      <X size={14} weight="bold" aria-hidden="true" />
    )}
    {CELL_WORD[c]}
  </span>
);

const RoleTable = ({ roles }: { roles: RoleDef[] }) => (
  <div
    role="region"
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
    tabIndex={0}
    aria-label={t('policy.tableRegion')}
    className="overflow-x-auto rounded-lg border border-line bg-surface outline-none focus-visible:outline-2 focus-visible:outline-focus"
  >
    <table className="w-full min-w-[40rem] border-collapse">
      <caption className="sr-only">{t('policy.roles.caption')}</caption>
      <thead>
        <tr className="border-b border-line">
          <th scope="col" className="px-4 py-3 text-left type-micro font-normal text-ink-2">
            {t('policy.roles.action')}
          </th>
          {roles.map((r) => (
            <th
              key={r.name}
              scope="col"
              className="px-3 py-3 text-left font-mono text-[14px] font-medium text-ink"
            >
              {r.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROLE_ACTIONS.map((a) => (
          <tr key={a.id} className="border-b border-line">
            <th scope="row" className="px-4 py-2.5 text-left type-body-sm font-normal text-ink">
              {a.label}
            </th>
            {roles.map((r) => (
              <td key={r.name} className="px-3 py-2.5">
                <CellMark c={cellFor(r, a)} />
              </td>
            ))}
          </tr>
        ))}
        <tr className="border-b border-line">
          <th scope="row" className="px-4 py-2.5 text-left type-body-sm font-normal text-ink">
            {t('policy.roles.sandbox')}
          </th>
          {roles.map((r) => (
            <td key={r.name} className="px-3 py-2.5 type-meta text-ink">
              {r.sandboxProfile}
            </td>
          ))}
        </tr>
        <tr className="border-b border-line">
          <th scope="row" className="px-4 py-2.5 text-left type-body-sm font-normal text-ink">
            {t('policy.roles.dlp')}
          </th>
          {roles.map((r) => (
            <td key={r.name} className="px-3 py-2.5 type-meta text-ink-2">
              {r.dlp}
            </td>
          ))}
        </tr>
        <tr>
          <th scope="row" className="px-4 py-2.5 text-left type-body-sm font-normal text-ink">
            {t('policy.roles.limits')}
          </th>
          {roles.map((r) => (
            <td key={r.name} className="px-3 py-2.5 align-top type-meta text-ink-2">
              {limitsOf(r).map((l) => (
                <span key={l} className="block whitespace-nowrap">
                  {l}
                </span>
              ))}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  </div>
);

const RoleAccordion = ({ roles }: { roles: RoleDef[] }) => (
  <div className="flex flex-col rounded-lg border border-line bg-surface">
    {roles.map((r) => (
      <Disclosure key={r.name} className="group border-b border-line last:border-b-0">
        <Heading level={3} className="m-0">
          <RACButton
            slot="trigger"
            className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-none data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-[15px] font-medium text-ink">{r.name}</span>
              <span className="type-body-sm text-ink-2">{r.description}</span>
            </span>
            <CaretRight
              size={16}
              aria-hidden="true"
              className="shrink-0 text-ink-2 group-data-[expanded]:rotate-90"
            />
          </RACButton>
        </Heading>
        <DisclosurePanel>
          <dl className="px-4 pb-3">
            {ROLE_ACTIONS.map((a) => (
              <div
                key={a.id}
                className="flex min-h-10 items-center justify-between gap-3 border-t border-line py-1.5"
              >
                <dt className="type-body-sm text-ink">{a.label}</dt>
                <dd>
                  <CellMark c={cellFor(r, a)} />
                </dd>
              </div>
            ))}
            <div className="flex min-h-10 items-center justify-between gap-3 border-t border-line py-1.5">
              <dt className="type-body-sm text-ink">{t('policy.roles.sandbox')}</dt>
              <dd className="type-meta text-ink">{r.sandboxProfile}</dd>
            </div>
            <div className="flex flex-col gap-0.5 border-t border-line py-2">
              <dt className="type-body-sm text-ink">{t('policy.roles.limits')}</dt>
              <dd className="type-meta text-ink-2">
                {limitsOf(r).join(' · ')} · {DLP_WORD[r.dlp]}
              </dd>
            </div>
          </dl>
        </DisclosurePanel>
      </Disclosure>
    ))}
  </div>
);

export const RolesScreen = () => {
  const roles = useApi('role.list');
  const expanded = useExpanded();
  const showSkeleton = useDelayedLoading(roles.isPending);
  const list = roles.data?.roles ?? [];
  const grants = Object.entries(roles.data?.grants ?? {});
  return (
    <Screen
      title={t('policy.roles.title')}
      back={{ href: '/policy', label: t('nav.policy') }}
      pane="detail"
      crumbs={[{ label: t('nav.policy'), href: '/policy' }, { label: t('policy.roles.title') }]}
      slug={<MetaLine items={[t('policy.roles.slug', { count: list.length })]} />}
    >
      <p className="mb-6 max-w-[62ch] type-body text-ink-2">{t('policy.roles.lead')}</p>
      {roles.error ? (
        <ErrorState
          title={t('policy.roles.error')}
          details={roles.error}
          onRetry={() => void roles.refetch()}
        >
          {roles.error.message}
        </ErrorState>
      ) : roles.isPending ? (
        showSkeleton ? (
          <Skeleton variant="detail" />
        ) : null
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1">
            {(['auto', 'ask', 'deny'] as Cell[]).map((c) => (
              <span key={c} className="inline-flex items-center gap-2 type-body-sm text-ink-2">
                <CellMark c={c} /> {t(`policy.roles.legend.${c}`)}
              </span>
            ))}
          </div>
          {expanded ? <RoleTable roles={list} /> : <RoleAccordion roles={list} />}
          <Section id="grants" title={t('policy.roles.grants', { count: grants.length })} className="mt-8">
            {grants.length === 0 ? (
              <p className="type-body-sm text-ink-2">{t('policy.roles.noGrants')}</p>
            ) : (
              <ul className="flex flex-col rounded-lg border border-line bg-surface">
                {grants.map(([who, role]) => (
                  <li
                    key={who}
                    className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 type-meta text-ink [overflow-wrap:anywhere]">{who}</span>
                    <Mono className="type-meta text-ink-2">{role}</Mono>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 type-body-sm text-ink-2">{t('policy.roles.ownerNote')}</p>
          </Section>
          <CliStrip className="mt-8" command="beamhop role grant <principal> <role> --agent <name>" />
        </>
      )}
    </Screen>
  );
};
