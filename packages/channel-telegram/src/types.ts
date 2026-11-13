// Subset of Telegram Bot API types used by this plugin.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  can_read_all_group_messages?: boolean;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
  url?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  sender_chat?: TgChat;
  date: number;
  chat: TgChat;
  reply_to_message?: TgMessage;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  photo?: TgPhotoSize[];
  document?: TgDocument;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgChatMember {
  user: TgUser;
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  date: number;
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TgUserProfilePhotos {
  total_count: number;
  photos: TgPhotoSize[][];
}
