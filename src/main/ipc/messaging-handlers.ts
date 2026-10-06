// The Slack workspaces and Telegram chats where this computer's agents answer. Tokens only travel towards the host; no
// result carries one.

import { runCauseEffect } from "../../backend/effect-boundary";
import type { MessagingService } from "../../backend/messaging/messaging-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import {
  parseAddSlackOrchestratorInput,
  parseAddTelegramOrchestratorInput,
  parseConnectTelegramChatInput,
  parseSetSlackEnabledInput,
  parseSlackWorkspaceInput,
} from "./messaging-inputs";

interface MessagingIpcDependencies {
  messaging: Pick<
    MessagingService,
    | "slackOverview"
    | "connectSlackWorkspace"
    | "disconnectSlackWorkspace"
    | "reconnect"
    | "setEnabled"
    | "addOrchestrator"
    | "telegramOverview"
    | "connectTelegramChat"
    | "disconnectTelegramChat"
    | "addTelegramOrchestrator"
  >;
}

export function messagingIpcHandlers({ messaging }: MessagingIpcDependencies): Pick<IpcGroupHandlers, "messaging"> {
  return {
    messaging: {
      getSlackOverview: handler(() => messaging.slackOverview()),
      connectSlackWorkspace: handler(() => runCauseEffect(messaging.connectSlackWorkspace())),
      disconnectSlackWorkspace: payloadHandler(parseSlackWorkspaceInput, ({ workspaceId }) =>
        runCauseEffect(messaging.disconnectSlackWorkspace(workspaceId)),
      ),
      reconnectSlackWorkspace: payloadHandler(parseSlackWorkspaceInput, ({ workspaceId }) =>
        runCauseEffect(messaging.reconnect("slack", workspaceId)),
      ),
      setSlackEnabled: payloadHandler(parseSetSlackEnabledInput, ({ workspaceId, enabled }) =>
        runCauseEffect(messaging.setEnabled("slack", workspaceId, enabled)),
      ),
      addSlackOrchestrator: payloadHandler(parseAddSlackOrchestratorInput, (input) =>
        runCauseEffect(messaging.addOrchestrator(input)),
      ),
      getTelegramOverview: handler(() => messaging.telegramOverview()),
      connectTelegramChat: payloadHandler(parseConnectTelegramChatInput, ({ place }) =>
        runCauseEffect(messaging.connectTelegramChat(place)),
      ),
      disconnectTelegramChat: payloadHandler(parseSlackWorkspaceInput, ({ workspaceId }) =>
        runCauseEffect(messaging.disconnectTelegramChat(workspaceId)),
      ),
      reconnectTelegramChat: payloadHandler(parseSlackWorkspaceInput, ({ workspaceId }) =>
        runCauseEffect(messaging.reconnect("telegram", workspaceId)),
      ),
      setTelegramEnabled: payloadHandler(parseSetSlackEnabledInput, ({ workspaceId, enabled }) =>
        runCauseEffect(messaging.setEnabled("telegram", workspaceId, enabled)),
      ),
      addTelegramOrchestrator: payloadHandler(parseAddTelegramOrchestratorInput, (input) =>
        runCauseEffect(messaging.addTelegramOrchestrator(input)),
      ),
    },
  };
}
