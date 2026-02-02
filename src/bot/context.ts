import type { ConversationFlavor } from "@grammyjs/conversations";
import type { Context, SessionFlavor } from "grammy";

export type SessionData = {
  __conversations?: unknown;
};

type BaseBotContext = Context & SessionFlavor<SessionData>;

export type BotContext = BaseBotContext & ConversationFlavor<BaseBotContext>;
