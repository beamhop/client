/**
 * Harness logins for sandboxed agents: status, Log in (paste a key or token into the vault), Check (a
 * real verification by the daemon), Log out. The harness's own login (keychain, ~/.config) cannot be used
 * inside the sandbox, so beamhop keeps one credential per harness (catalog `auth.methods`):
 *   broker: a provider key the broker adds to requests; the agent never sees it.
 *   env:    a token handed to the harness (GitHub Copilot); the agent can read it.
 */
import type { HarnessView } from '@beamhop/core';
import { useState } from 'react';
import type { LampState } from '../../api/derive.ts';
import { useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { clock } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Radio, RadioGroup } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { SecretField } from '../../ui/Field.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';

type Login = NonNullable<HarnessView['login']>;

/** Harnesses whose login beamhop manages. */
export const managesLogin = (h: HarnessView): h is HarnessView & { login: Login } =>
  !!h.login && h.login.status !== 'unmanaged';

const lamp = (s: Login['status']): LampState =>
  s === 'logged-in' ? 'ready' : s === 'unchecked' ? 'paused' : s === 'invalid' ? 'error' : 'needs-you';

export const loginWord = (l: Login): string =>
  ({
    'logged-in': t('harnesses.login.loggedIn'),
    'logged-out': t('harnesses.login.loggedOut'),
    invalid: t('harnesses.login.invalid'),
    unchecked: t('harnesses.login.unchecked'),
    unmanaged: t('harnesses.login.unmanaged'),
  })[l.status];

const activeLabel = (l: Login) => l.methods.find((m) => m.id === l.method)?.label;

/** One-line login status with the method in use. */
export const LoginStatus = ({ login }: { login: Login }) => (
  <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2">
    <StatusDot state={lamp(login.status)} label={loginWord(login)} />
    {activeLabel(login) && <span className="type-meta text-ink-2">{activeLabel(login)}</span>}
  </span>
);

export const LoginSheet = ({
  h,
  isOpen,
  onOpenChange,
}: {
  h: HarnessView & { login: Login };
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const methods = h.login.methods;
  const [methodId, setMethodId] = useState(h.login.method ?? methods[0]?.id ?? '');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const login = useMutationApi('harness.login');
  const toast = useToast();
  const m = methods.find((x) => x.id === methodId) ?? methods[0];
  const result = login.data?.login;
  const close = () => {
    setValue('');
    setTouched(false);
    login.reset();
    onOpenChange(false);
  };
  const save = async () => {
    setTouched(true);
    if (!m || !value.trim()) {
      haptic('error');
      return;
    }
    try {
      const v = await login.mutateAsync({ id: h.id, method: m.id, value });
      if (v.login?.status === 'logged-in' || v.login?.status === 'unchecked') {
        toast.show({ message: t('harnesses.login.done', { name: h.displayName }), tone: 'success' });
        close();
      } else haptic('error');
    } catch {
      haptic('error');
    }
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title={t('harnesses.login.title', { name: h.displayName })}
      isDismissable={false}
      footer={
        <div className="grid gap-2 expanded:grid-cols-2 expanded:[&>*:first-child]:order-2">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            isPending={login.isPending}
            onPress={() => void save()}
          >
            {t('harnesses.login.saveAndCheck')}
          </Button>
          <Button variant="secondary" size="lg" fullWidth onPress={close}>
            {t('settings.identity.cancel')}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="type-body-sm text-ink-2">{t('harnesses.login.lead', { name: h.displayName })}</p>
        {methods.length > 1 && (
          <RadioGroup
            label={t('harnesses.login.method')}
            value={m?.id ?? ''}
            onChange={(v) => {
              setMethodId(v);
              login.reset();
            }}
          >
            {methods.map((x) => (
              <Radio key={x.id} value={x.id} description={x.set ? t('harnesses.login.stored') : undefined}>
                {x.label}
              </Radio>
            ))}
          </RadioGroup>
        )}
        {m && (
          <SecretField
            label={m.label}
            value={value}
            onChange={setValue}
            isInvalid={touched && !value.trim()}
            errorMessage={t('harnesses.login.required')}
            description={
              <>
                {m.hint && <span className="block">{m.hint}</span>}
                <span className="block">
                  {m.kind === 'env' ? t('harnesses.login.agentReads') : t('harnesses.login.agentNeverSees')}
                </span>
              </>
            }
          />
        )}
        {result && (result.status === 'invalid' || (result.status !== 'logged-in' && result.message)) && (
          <p role="alert" className="type-body-sm text-stop-text">
            {result.status === 'invalid' ? t('harnesses.login.rejected') : ''} {result.message}
          </p>
        )}
        {login.isError && <p className="type-body-sm text-stop-text">{login.error.message}</p>}
        <CliStrip
          command={
            m?.importFrom === 'gh'
              ? `beamhop harness login ${h.id} --from gh`
              : `beamhop harness login ${h.id}${m && m.id !== methods[0]?.id ? ` --method ${m.id}` : ''}   # reads stdin`
          }
        />
      </form>
    </Sheet>
  );
};

/** Login block for the details panel: status, message, Log in / Check / Log out. */
export const LoginPanel = ({ h }: { h: HarnessView & { login: Login } }) => {
  const [open, setOpen] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const check = useMutationApi('harness.checkLogin');
  const logout = useMutationApi('harness.logout');
  const toast = useToast();
  const l = h.login;
  const anySet = l.methods.some((m) => m.set);
  const runCheck = async () => {
    try {
      const v = await check.mutateAsync({ id: h.id });
      toast.show({
        message: `${h.displayName}: ${v.login ? loginWord(v.login) : ''}`,
        tone: v.login?.status === 'logged-in' ? 'success' : 'error',
      });
    } catch {
      haptic('error');
    }
  };
  return (
    <section aria-labelledby={`login-${h.id}`} className="flex flex-col gap-3">
      <h3 id={`login-${h.id}`} className="type-title-3 text-ink">
        {t('harnesses.login.heading')}
      </h3>
      <LoginStatus login={l} />
      {l.message && <p className="type-body-sm text-ink-2">{l.message}</p>}
      {l.checkedAt && (
        <p className="type-meta text-ink-2">
          {t('harnesses.login.checkedAt', { time: clock(new Date(l.checkedAt)) })}
        </p>
      )}
      {check.isError && <p className="type-body-sm text-stop-text">{check.error.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant={anySet ? 'secondary' : 'primary'} size="sm" onPress={() => setOpen(true)}>
          {anySet ? t('harnesses.login.change') : t('harnesses.login.logIn')}
        </Button>
        {anySet && (
          <Button variant="secondary" size="sm" isPending={check.isPending} onPress={() => void runCheck()}>
            {t('harnesses.login.check')}
          </Button>
        )}
        {anySet && (
          <Button variant="quiet" size="sm" onPress={() => setConfirmOut(true)}>
            {t('harnesses.login.logOut')}
          </Button>
        )}
      </div>
      <CliStrip command={`beamhop harness status ${h.id} --check`} />
      <LoginSheet h={h} isOpen={open} onOpenChange={setOpen} />
      <ConfirmDialog
        isOpen={confirmOut}
        onOpenChange={setConfirmOut}
        title={t('harnesses.login.logOutTitle', { name: h.displayName })}
        confirmLabel={t('harnesses.login.logOut')}
        isPending={logout.isPending}
        onConfirm={async () => {
          await logout.mutateAsync({ id: h.id });
          setConfirmOut(false);
        }}
      >
        {t('harnesses.login.logOutBody', {
          secrets: l.methods
            .filter((m) => m.set)
            .map((m) => m.secret)
            .join(', '),
        })}
      </ConfirmDialog>
    </section>
  );
};
