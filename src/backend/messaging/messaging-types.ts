// The seam between the platform-agnostic messaging core and one chat platform. A platform is one
// `MessagingDriver`: an adapter for its API and a transport for its inbound events. The OpenBot
// Slack app uses the Events API: Slack posts to Signal, Signal checks Slack's signature, and passes
// each request of a workspace linked to this host over the `MessagingIngress` socket, which the host
// opens. The OpenBot Telegram bot works the same way: Telegram posts each update to Signal, which
// passes it over the same socket, and the host calls the Bot API through Signal, which holds the
// bot token. No transport needs a public endpoint on the host.

import type { MessagingConnectionState, MessagingPlatform } from "@openbot/contracts/ipc";
import type {
  TelegramCallMethod,
  TelegramCallParams,
  TelegramCallResult,
} from "@openbot/contracts/signal-protocol/telegram-route";
import { type Effect, Schema } from "effect";
import type { MessagingOperationFailed } from "./messaging-service";
import type { MessagingAnswerFile } from "./messaging-threads";

/** Where a post goes: a platform channel, and the thread in it or the top level. */
export interface MessageTarget {
  platformChannelId: string;
  replyThreadId: string | null;
}

export interface InboundFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

/** One message that addresses OpenBot, in the same shape for every platform. */
export interface InboundMessage {
  /** Stable for one message across redeliveries. */
  dedupKey: string;
  platformChannelId: string;
  /** Names the conversation: one link, and so one execution thread, per key and channel. */
  threadKey: string;
  target: MessageTarget;
  platformMessageId: string;
  isDirect: boolean;
  /** True for a reply that does not name OpenBot: it counts only in a conversation that already has an agent. */
  requiresLink: boolean;
  authorId: string;
  text: string;
  files: InboundFile[];
}

export type InboundAction =
  | {
      type: "approval";
      token: string;
      decision: "accept" | "decline";
      actorId: string;
      target: MessageTarget;
      platformMessageId: string;
    }
  | { type: "stop"; token: string; actorId: string; target: MessageTarget; platformMessageId: string };

interface MessageButton {
  action: "accept" | "decline" | "stop";
  label: string;
  /** Opaque and single use. It maps to the request only in the host's memory. */
  token: string;
  style?: "primary" | "danger";
}

export interface MessageBody {
  text: string;
  buttons?: MessageButton[];
}

export type StatusReaction = "received" | "done" | "failed" | "stopped";

export interface ConnectionIdentity {
  workspaceId: string;
  workspaceName: string;
  botUserId: string;
  appId: string;
  missingScopes: string[];
}

export interface ContextEntry {
  id: string;
  authorName: string;
  text: string;
  sentAt: string;
}

/** A failure the connection cannot recover from alone. The user must act. */
export class MessagingConnectionError extends Error {
  constructor(readonly state: Extract<MessagingConnectionState, "invalid_token">) {
    super(state);
  }
}

export class MessagingAdapterError extends Schema.TaggedError<MessagingAdapterError>()("MessagingAdapterError", {
  cause: Schema.Defect(),
}) {}

export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  identify(): Effect.Effect<ConnectionIdentity, MessagingAdapterError>;
  post(target: MessageTarget, body: MessageBody): Effect.Effect<string, MessagingAdapterError>;
  edit(target: MessageTarget, messageId: string, body: MessageBody): Effect.Effect<void, MessagingAdapterError>;
  postPrivate(target: MessageTarget, userId: string, text: string): Effect.Effect<void, MessagingAdapterError>;
  react(
    target: MessageTarget,
    messageId: string,
    reaction: StatusReaction,
    on: boolean,
  ): Effect.Effect<void, MessagingAdapterError>;
  /**
   * Posts the agent's answer, in as many posts as the platform needs. The first part replaces
   * `replaceMessageId` when it is given.
   */
  postAnswer(
    target: MessageTarget,
    markdown: string,
    replaceMessageId: string | null,
  ): Effect.Effect<void, MessagingAdapterError>;
  /** Uploads files to the conversation, and returns the names it did not send. */
  upload(target: MessageTarget, files: MessagingAnswerFile[]): Effect.Effect<string[], MessagingAdapterError>;
  /** Earlier messages of the conversation, oldest first, after `afterId` and before `beforeId`. */
  history(
    platformChannelId: string,
    threadKey: string,
    afterId: string | null,
    beforeId: string,
  ): Effect.Effect<ContextEntry[], MessagingAdapterError>;
  /** Downloads one file to `destination`. Refuses a file larger than `maxBytes`. */
  download(file: InboundFile, destination: string, maxBytes: number): Effect.Effect<void, MessagingAdapterError>;
  authorName(userId: string): Effect.Effect<string, MessagingAdapterError>;
  placeName(platformChannelId: string): Effect.Effect<string, MessagingAdapterError>;
  mention(userId: string): string;
  /** Joins every public place the platform lets OpenBot join without an invitation. */
  joinPublicPlaces?(): Effect.Effect<void, MessagingAdapterError>;
  /** Joins one public place, such as a channel that was just created. */
  joinPlace?(platformChannelId: string): Effect.Effect<void, MessagingAdapterError>;
}

export interface TransportSink {
  state(state: MessagingConnectionState, detail?: { retryAt?: string }): void;
  message(message: InboundMessage): void;
  action(action: InboundAction): void;
  /** A public place was created that OpenBot can join. */
  placeCreated?(platformChannelId: string): void;
  /** The workspace, such as a Telegram chat, has a new name. */
  renamed?(workspaceName: string): void;
}

export interface MessagingTransport {
  start(sink: TransportSink): void;
  /** Reconnects now, such as after the computer wakes. */
  reconnect(): void;
  stop(): Effect.Effect<void>;
  /** Handles one request that the ingress relay brought, for a transport that gets its events that way. */
  deliver?(delivery: IngressDelivery): Effect.Effect<IngressAnswer>;
}

/**
 * One HTTP request that a platform sent to its request URL, as Signal passed it on. Signal has
 * already checked the platform's signature.
 */
export interface IngressDelivery {
  /** `telegram` is one Telegram update, which needs no answer. */
  kind: "events" | "interactivity" | "telegram";
  retryNum: number | null;
  body: Uint8Array;
}

/** The HTTP answer the platform gets. A body only for a URL check or a button reply. */
export interface IngressAnswer {
  status: 200 | 400 | 401 | 404 | 503;
  contentType?: "application/json" | "text/plain";
  body?: string;
}

/** `unavailable` has a reason the user can act on: sign in, name this computer, or wait for Signal. */
export type IngressState = "online" | "connecting" | "signed_out" | "no_host" | "unavailable";

/** Handles one request for a workspace, by the platform's workspace id. */
export type IngressHandler = (
  workspaceId: string,
  delivery: IngressDelivery,
) => Effect.Effect<IngressAnswer, MessagingOperationFailed>;

/** Handles one Telegram update of a chat routed to this host. */
export type TelegramIngressHandler = (
  botId: string,
  chatId: string,
  body: Uint8Array,
) => Effect.Effect<void, MessagingOperationFailed>;

/**
 * The Bot API of the OpenBot Telegram bot, through Signal, which holds the token. Signal accepts a
 * call only for a chat routed to this host.
 */
export interface TelegramGateway {
  /** False until Signal says it has a Telegram bot. */
  available(): boolean;
  call<M extends TelegramCallMethod>(
    botId: string,
    method: M,
    params: TelegramCallParams[M],
  ): Effect.Effect<TelegramCallResult, MessagingAdapterError>;
  /** Downloads the file of a `getFile` token. Refuses a file larger than `maxBytes`. */
  download(fileToken: string, destination: string, maxBytes: number): Effect.Effect<void, MessagingAdapterError>;
  /** Posts a file for a `sendDocument` token, and returns the message ID. */
  upload(uploadToken: string, path: string): Effect.Effect<number, MessagingAdapterError>;
}

/** A Bot API call that failed. The description is Telegram's, and never quotes message text. */
export class TelegramCallError extends Error {
  readonly code: string;
  constructor(
    readonly errorCode: number,
    description: string,
    readonly retryAfter: number | null,
  ) {
    super(description);
    this.name = "TelegramCallError";
    this.code = `telegram_${errorCode}`;
  }
}

/**
 * The relay that brings a platform's HTTP requests to this host: Signal's `ingress` socket, which
 * the main process owns. It is open while anything holds it.
 */
export interface MessagingIngress {
  /** Keeps the relay open until the returned function runs. */
  acquire(): () => void;
  state(): IngressState;
  onState(listener: (state: IngressState) => void): () => void;
  /** Sets the one handler of the requests the relay receives, or removes it. */
  handle(handler: IngressHandler | null): void;
  /** Sets the one handler of the Telegram updates the relay receives, or removes it. */
  handleTelegram(handler: TelegramIngressHandler | null): void;
  readonly telegram: TelegramGateway;
  /**
   * Opens the socket again, such as after the computer wakes, or after a workspace was connected or
   * disconnected: Signal learns the workspaces of this host when the socket connects.
   */
  reconnect(): void;
}

export interface MessagingDriverOptions {
  /** Called when the platform asks the host to wait, with the time it can try again. */
  rateLimited(retryAt: string): void;
}

export interface MessagingDriver {
  readonly platform: MessagingPlatform;
  /** The credential a connection must have to start, such as the Slack bot token. */
  readonly credentialKey: string;
  createAdapter(credentials: Record<string, string>, options: MessagingDriverOptions): MessagingAdapter;
  createTransport(credentials: Record<string, string>, identity: ConnectionIdentity): MessagingTransport;
}
