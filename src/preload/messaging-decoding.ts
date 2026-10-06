// What main answers for the Slack workspaces and Telegram chats of this computer. These guard the renderer.

import {
  type AddSlackOrchestratorResult,
  isAddSlackOrchestratorResult,
  isSlackOverview,
  isTelegramOverview,
  type SlackOverview,
  type TelegramOverview,
} from "@openbot/contracts/ipc";

/** The orchestrator that main created, and the sidebar section it went to. */
export function decodeAddSlackOrchestratorReply(value: unknown): AddSlackOrchestratorResult {
  if (!isAddSlackOrchestratorResult(value)) throw new Error("Invalid Slack orchestrator response.");
  return value;
}

export function decodeSlackOverviewReply(value: unknown): SlackOverview {
  if (!isSlackOverview(value)) throw new Error("Invalid Slack overview response.");
  return value;
}

export function decodeTelegramOverviewReply(value: unknown): TelegramOverview {
  if (!isTelegramOverview(value)) throw new Error("Invalid Telegram overview response.");
  return value;
}
