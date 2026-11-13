import { t } from '../i18n/index.ts';
import { Screen } from '../shell/Screen.tsx';
import { LinkButton } from '../ui/Button.tsx';
import { EmptyState } from '../ui/States.tsx';

export const NotFound = () => (
  <Screen title={t('ui.notFound.notFound')} back={{ href: '/', label: 'Home' }}>
    <EmptyState
      title={t('ui.notFound.nothingAtThisAddress')}
      action={<LinkButton href="/">{t('ui.notFound.goToHome')}</LinkButton>}
    >
      {t('ui.notFound.theLinkMayBe')}
    </EmptyState>
  </Screen>
);
