import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { createFeishuClient } from "./client.js";
import { buildCardWithoutButtons, getCachedCardContent } from "./streaming-card.js";

export type FeishuCardActionEvent = {
  operator: {
    tenant_key?: string;
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id?: string;
    user_id?: string;
    /** @deprecated Use open_chat_id instead (actual Feishu field name) */
    chat_id?: string;
    /** Chat ID of the message containing the clicked card */
    open_chat_id?: string;
    /** Message ID of the card that was clicked */
    open_message_id?: string;
  };
};

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;

  // Debug: log full event data to understand structure
  log(`feishu[${account.accountId}]: card action raw event: ${JSON.stringify(event)}`);

  // Extract action value
  const actionValue = event.action.value;
  let content = "";
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      content = actionValue.text;
    } else if ("command" in actionValue && typeof actionValue.command === "string") {
      content = actionValue.command;
    } else {
      content = JSON.stringify(actionValue);
    }
  } else {
    content = String(actionValue);
  }

  // Resolve real IDs from the event context (Feishu uses open_* prefixed field names)
  const openMessageId = event.context.open_message_id;
  const chatId = event.context.open_chat_id || event.context.chat_id || event.operator.open_id;
  const isGroup = !!(event.context.open_chat_id || event.context.chat_id);

  // Use real message ID so reply-dispatcher can correctly reply to the original
  // card message (fixes streaming progress bar + group chat routing)
  const realMessageId = openMessageId ?? `card-action-${event.token}`;

  // Construct a synthetic message event.
  // In group chats, inject a bot mention so the message passes the @-mention check
  // (card action clicks are explicit user intent, equivalent to @bot messages).
  const botOpenId = params.botOpenId;
  const mentions =
    isGroup && botOpenId
      ? [{ key: "@_user_1", id: { open_id: botOpenId }, name: "bot", tenant_key: "" }]
      : undefined;

  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: realMessageId,
      chat_id: chatId,
      chat_type: isGroup ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content }),
      mentions,
    },
  };

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}, messageId=${realMessageId}, chatId=${chatId}, isGroup=${isGroup}`,
  );

  // Button removal is handled by the callback response in monitor.account.ts
  // (returns updated card without buttons for instant removal by Feishu).

  // Dispatch as normal message
  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
