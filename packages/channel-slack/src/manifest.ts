/**
 * Slack app manifest generator.
 *
 * Manifest reference: https://api.slack.com/reference/manifests
 * Prefilled "create app" link: https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded JSON>
 * (documented under "Creating apps using manifests" → "Share a link").
 */

export interface SlackManifestOptions {
  /** App name (max 35 chars) and bot display name (max 80 chars). */
  botName?: string;
  /** Who operates the agent — shown in the description (AI disclosure, PLAN §1). */
  operator?: string;
}

/** Bot token scopes — https://api.slack.com/scopes */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'channels:history',
  'groups:history',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'files:read',
  'files:write',
  'users:read',
  'reactions:write',
  // `member_left_channel` requires channels:read / groups:read
  // (https://api.slack.com/events/member_left_channel).
  'channels:read',
  'groups:read',
] as const;

/** Bot events — https://api.slack.com/events */
export const SLACK_BOT_EVENTS = [
  'app_mention',
  'message.im',
  'message.channels',
  'message.groups',
  'message.mpim',
  'member_left_channel',
  'channel_left',
] as const;

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export const buildSlackManifest = (opts: SlackManifestOptions = {}) => {
  const name = (opts.botName ?? 'beamhop agent').trim() || 'beamhop agent';
  const operator = opts.operator?.trim();
  const description = clamp(
    operator ? `AI agent operated by ${operator}, powered by beamhop.` : 'AI agent powered by beamhop.',
    140,
  );
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: clamp(name, 35),
      description,
      background_color: '#1f2937',
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: clamp(name, 80), always_online: true },
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: {
        bot_events: [...SLACK_BOT_EVENTS],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
};

export const slackManifestUrl = (opts: SlackManifestOptions = {}): string =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(buildSlackManifest(opts)))}`;
