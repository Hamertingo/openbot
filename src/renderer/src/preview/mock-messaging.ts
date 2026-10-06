import type { MessagingConnection, MessagingDesktopApi } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { clone } from "./mock-support";

const PREVIEW_WORKSPACE = { workspaceId: "T0PREVIEW", workspaceName: "Preview workspace" };

/** The time Telegram takes in the preview before a chat links: the user picks the chat there. */
const TELEGRAM_LINK_MS = 1_500;

/**
 * The Slack workspaces and Telegram chats of the preview host. Connecting Slack connects a preview
 * workspace at once. A Telegram link adds a preview chat after a moment, as the user picks it in Telegram.
 * `orchestrator` names the preview agent that stands in for the Slack and Telegram Orchestrators.
 */
export function createMockMessaging(orchestrator: () => string): MessagingDesktopApi {
  const connections = new Map<string, MessagingConnection>();
  const change = (workspaceId: string, update: Partial<MessagingConnection>) => {
    const current = connections.get(workspaceId);
    if (!current) throw new Error(sourceText("error.messaging.notConnected"));
    connections.set(workspaceId, { ...current, ...update });
  };
  const chats = new Map<string, MessagingConnection>();
  /** One orchestrator answers every Telegram chat, so a new chat gets it too. */
  let telegramOrchestrator: string | null = null;
  let linkedChats = 0;
  const changeChat = (workspaceId: string, update: Partial<MessagingConnection>) => {
    const current = chats.get(workspaceId);
    if (!current) throw new Error(sourceText("error.messaging.notConnected"));
    chats.set(workspaceId, { ...current, ...update });
  };
  return {
    getSlackOverview: async () => clone({ connections: [...connections.values()] }),
    connectSlackWorkspace: async () => {
      connections.set(PREVIEW_WORKSPACE.workspaceId, {
        ...PREVIEW_WORKSPACE,
        platform: "slack",
        enabled: true,
        state: "connected",
        botUserId: "U0PREVIEW",
        missingScopes: [],
        retryAt: null,
        credentials: "saved",
        orchestratorAgentId: null,
      });
    },
    disconnectSlackWorkspace: async ({ workspaceId }) => {
      connections.delete(workspaceId);
    },
    reconnectSlackWorkspace: async ({ workspaceId }) => change(workspaceId, { enabled: true, state: "connected" }),
    setSlackEnabled: async ({ workspaceId, enabled }) =>
      change(workspaceId, { enabled, state: enabled ? "connected" : "paused" }),
    addSlackOrchestrator: async ({ workspaceId }) => {
      const agentId = orchestrator();
      change(workspaceId, { orchestratorAgentId: agentId });
      return { agentId, sectionId: null };
    },
    getTelegramOverview: async () => clone({ connections: [...chats.values()] }),
    connectTelegramChat: async ({ place }) => {
      linkedChats += 1;
      const count = linkedChats;
      // Telegram gives a group a negative chat ID, and a direct chat a positive one.
      const chat =
        place === "group"
          ? { workspaceId: `-100${count}`, workspaceName: `Preview group ${count}` }
          : { workspaceId: `${700_000 + count}`, workspaceName: `Preview chat ${count}` };
      setTimeout(() => {
        chats.set(chat.workspaceId, {
          ...chat,
          platform: "telegram",
          enabled: true,
          state: "connected",
          botUserId: "7000000000",
          missingScopes: [],
          retryAt: null,
          credentials: "saved",
          orchestratorAgentId: telegramOrchestrator,
        });
      }, TELEGRAM_LINK_MS);
    },
    disconnectTelegramChat: async ({ workspaceId }) => {
      chats.delete(workspaceId);
    },
    reconnectTelegramChat: async ({ workspaceId }) => changeChat(workspaceId, { enabled: true, state: "connected" }),
    setTelegramEnabled: async ({ workspaceId, enabled }) =>
      changeChat(workspaceId, { enabled, state: enabled ? "connected" : "paused" }),
    addTelegramOrchestrator: async () => {
      const agentId = orchestrator();
      telegramOrchestrator = agentId;
      for (const workspaceId of chats.keys()) changeChat(workspaceId, { orchestratorAgentId: agentId });
      return { agentId, sectionId: null };
    },
  };
}
