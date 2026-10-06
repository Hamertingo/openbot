import { decodeSignalServerMessage } from "@openbot/contracts/signal-protocol/decode";
import {
  SIGNAL_PROTOCOL_VERSION,
  type SignalClientMessage,
  SLACK_DELIVERY_RESPONSE_BYTES_LIMIT,
} from "@openbot/contracts/signal-protocol/messages";
import {
  TELEGRAM_CAPABILITY,
  type TelegramCallMethod,
  type TelegramCallParams,
  type TelegramCallResult,
} from "@openbot/contracts/signal-protocol/telegram-route";
import { createOpenBotLogger } from "@openbot/logging";
import { Context, Effect, Exit, Layer, ManagedRuntime, Result, Scope } from "effect";
import WebSocket from "ws";
import {
  type IngressAnswer,
  type IngressHandler,
  type IngressState,
  MessagingAdapterError,
  type MessagingIngress,
  TelegramCallError,
  type TelegramGateway,
  type TelegramIngressHandler,
} from "../backend/messaging/messaging-types";
import { type RemoteWorkflowError, remoteDecode } from "./remote-service-effects";
import { downloadTelegramFile, signalHttpOrigin, uploadTelegramFile } from "./telegram-files";

const logger = createOpenBotLogger("slack-ingress");

const BACKOFF_START_MS = 2_000;
const BACKOFF_LIMIT_MS = 5 * 60_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
/** How long a Telegram call waits for the socket to be ready, and then for Signal's answer. */
const TELEGRAM_READY_TIMEOUT_MS = 10_000;
const TELEGRAM_CALL_TIMEOUT_MS = 20_000;

export interface SlackIngressOptions {
  /** The remote host id of this computer, or null before it has a name. */
  hostId(): string | null;
  signedIn(): boolean;
  issueTicket(hostId: string): Effect.Effect<{ ticket: string; signalUrl: string }, RemoteWorkflowError>;
  /** The Slack route ticket: the workspaces that the account service links to this host. */
  issueSlackRoute(hostId: string): Effect.Effect<string, RemoteWorkflowError>;
  /**
   * The Telegram route ticket: the chats that the account service links to this host. A failure, such
   * as an account service without Telegram, leaves the socket without Telegram chats.
   */
  issueTelegramRoute?(hostId: string): Effect.Effect<string, RemoteWorkflowError>;
}

class SlackIngressAccount extends Context.Service<
  SlackIngressAccount,
  {
    ticket(hostId: string): Effect.Effect<{ ticket: string; signalUrl: string }, RemoteWorkflowError>;
    route(hostId: string): Effect.Effect<string, RemoteWorkflowError>;
    telegramRoute(hostId: string): Effect.Effect<string | null>;
  }
>()("openbot/main/SlackIngressAccount") {
  static layer(options: SlackIngressOptions) {
    return Layer.succeed(
      SlackIngressAccount,
      SlackIngressAccount.of({
        ticket: (hostId) => options.issueTicket(hostId),
        route: (hostId) => options.issueSlackRoute(hostId),
        telegramRoute: (hostId) =>
          options.issueTelegramRoute
            ? options.issueTelegramRoute(hostId).pipe(Effect.catch(() => Effect.succeed(null)))
            : Effect.succeed(null),
      }),
    );
  }
}

/**
 * Owns this host's `ingress` socket to Signal, which brings the Events API requests of the Slack
 * workspaces linked to this host, and the updates of its Telegram chats. It also carries this host's
 * Telegram Bot API calls, which Signal makes with the bot token that only it has. It needs no WebRTC, so it lives here in main rather than in the
 * hidden peer window. It is open while a connection holds it, and it reconnects with a new ticket and
 * route ticket after every close. It never logs a frame: a delivery carries Slack message text.
 */
export class SlackIngress implements MessagingIngress {
  readonly #options: SlackIngressOptions;
  readonly #runtime: ManagedRuntime.ManagedRuntime<SlackIngressAccount, never>;
  readonly #scope = Scope.makeUnsafe();
  #disposing = false;
  readonly #listeners = new Set<(state: IngressState) => void>();
  #holders = 0;
  #state: IngressState = "unavailable";
  #handler: IngressHandler | null = null;
  #telegramHandler: TelegramIngressHandler | null = null;
  /** What the Signal of the open socket can do, from its `ready`. */
  #capabilities = new Set<string>();
  /** The HTTPS origin of the Signal of the open socket, for Telegram files. */
  #signalOrigin: string | null = null;
  readonly #telegramCalls = new Map<string, (answer: TelegramCallAnswer) => void>();
  #socket: WebSocket | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #backoffMs = BACKOFF_START_MS;
  #generation = 0;

  constructor(options: SlackIngressOptions) {
    this.#options = options;
    this.#runtime = ManagedRuntime.make(SlackIngressAccount.layer(options));
  }

  acquire(): () => void {
    this.#holders += 1;
    if (this.#holders === 1) this.#run(this.#open());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holders -= 1;
      if (this.#holders === 0) this.#close();
    };
  }

  state(): IngressState {
    return this.#state;
  }

  onState(listener: (state: IngressState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  handle(handler: IngressHandler | null): void {
    this.#handler = handler;
  }

  handleTelegram(handler: TelegramIngressHandler | null): void {
    this.#telegramHandler = handler;
  }

  readonly telegram: TelegramGateway = {
    available: () => this.#state === "online" && this.#capabilities.has(TELEGRAM_CAPABILITY),
    call: <M extends TelegramCallMethod>(botId: string, method: M, params: TelegramCallParams[M]) =>
      this.#telegramCall(botId, method, params),
    download: (fileToken, destination, maxBytes) =>
      Effect.suspend(() =>
        this.#signalOrigin
          ? downloadTelegramFile(this.#signalOrigin, fileToken, destination, maxBytes)
          : Effect.fail(unavailable()),
      ),
    upload: (uploadToken, path) =>
      Effect.suspend(() =>
        this.#signalOrigin ? uploadTelegramFile(this.#signalOrigin, uploadToken, path) : Effect.fail(unavailable()),
      ),
  };

  /**
   * A socket can be dead without knowing it after the computer sleeps, or the account, the name or
   * the linked workspaces changed.
   */
  reconnect(): void {
    if (this.#holders === 0) return;
    this.#close();
    this.#run(this.#open());
  }

  readonly dispose = Effect.fn("SlackIngress.dispose")(function* (this: SlackIngress) {
    this.#disposing = true;
    this.#holders = 0;
    this.#close();
    this.#listeners.clear();
    yield* Scope.close(this.#scope, Exit.void);
    yield* this.#runtime.disposeEffect;
  }, Effect.uninterruptible);

  readonly #open = Effect.fn("SlackIngress.open")(function* (this: SlackIngress) {
    if (this.#disposing) return;
    const generation = ++this.#generation;
    this.#clearRetry();
    const hostId = this.#options.hostId();
    if (!this.#options.signedIn()) return this.#wait("signed_out");
    if (!hostId) return this.#wait("no_host");
    this.#setState("connecting");
    const account = yield* SlackIngressAccount;
    const issued = yield* Effect.all([account.ticket(hostId), account.route(hostId), account.telegramRoute(hostId)], {
      concurrency: "unbounded",
    }).pipe(Effect.result);
    if (Result.isFailure(issued)) {
      if (generation === this.#generation) this.#wait("unavailable");
      return;
    }
    const [bootstrap, slackRoute, telegramRoute] = issued.success;
    if (generation !== this.#generation || this.#holders === 0) return;
    const socket = new WebSocket(bootstrap.signalUrl);
    this.#socket = socket;
    this.#signalOrigin = signalHttpOrigin(bootstrap.signalUrl);
    socket.on("open", () => {
      const hello: SignalClientMessage = {
        type: "hello",
        version: SIGNAL_PROTOCOL_VERSION,
        peer: "ingress",
        token: bootstrap.ticket,
        slackRoute,
        ...(telegramRoute ? { telegramRoute } : {}),
      };
      socket.send(JSON.stringify(hello));
    });
    socket.on("message", (data) => this.#run(this.#receive(socket, data.toString())));
    socket.on("pong", () => pongs.set(socket, true));
    socket.on("close", () => {
      if (socket !== this.#socket) return;
      this.#socket = null;
      this.#endTelegram();
      this.#stopPing();
      if (this.#holders > 0) this.#wait("unavailable");
    });
    socket.on("error", () => {
      // `close` follows and schedules the retry. The error can carry the URL.
    });
  });

  readonly #receive = Effect.fn("SlackIngress.receive")(function* (
    this: SlackIngress,
    socket: WebSocket,
    text: string,
  ) {
    if (this.#disposing || socket !== this.#socket) return;
    const decoded = yield* remoteDecode(() => decodeSignalServerMessage(JSON.parse(text))).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      socket.close(1002);
      return;
    }
    const message = decoded.success;
    if (!message || socket !== this.#socket) return;
    if (message.type === "ready") {
      this.#capabilities = new Set(message.capabilities ?? []);
      this.#backoffMs = BACKOFF_START_MS;
      this.#startPing(socket);
      this.#setState("online");
      return;
    }
    if (message.type === "error") {
      // Signal closes the socket after an error that ends it. Only the code is logged.
      logger.warn("Signal refused the Slack ingress socket.", { code: message.code });
      return;
    }
    if (message.type === "telegram-call-result") {
      this.#telegramCalls.get(message.requestId)?.(message);
      return;
    }
    if (message.type === "telegram-delivery") {
      const telegramHandler = this.#telegramHandler;
      if (telegramHandler)
        yield* telegramHandler(
          message.botId,
          message.chatId,
          Buffer.from(message.bodyBase64, "base64"),
          message.linked === true,
        ).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (message.type !== "slack-delivery") return;
    const handler = this.#handler;
    const answer: IngressAnswer = handler
      ? yield* handler(message.teamId, {
          kind: message.kind,
          retryNum: message.retryNum,
          body: Buffer.from(message.bodyBase64, "base64"),
        }).pipe(Effect.catch(() => Effect.succeed<IngressAnswer>({ status: 503 })))
      : { status: 503 };
    if (socket.readyState !== WebSocket.OPEN) return;
    const body =
      answer.contentType && answer.body !== undefined && answer.body.length <= SLACK_DELIVERY_RESPONSE_BYTES_LIMIT
        ? { contentType: answer.contentType, body: answer.body }
        : {};
    const result: SignalClientMessage = {
      type: "slack-delivery-result",
      version: SIGNAL_PROTOCOL_VERSION,
      requestId: message.requestId,
      status: answer.status,
      ...body,
    };
    socket.send(JSON.stringify(result));
  });

  #run(operation: Effect.Effect<void, never, SlackIngressAccount>): void {
    if (this.#disposing) return;
    this.#runtime.runFork(
      operation.pipe(Effect.uninterruptible, Effect.forkIn(this.#scope, { startImmediately: true })),
    );
  }

  #wait(state: Exclude<IngressState, "online" | "connecting">): void {
    this.#setState(state);
    if (this.#holders === 0 || this.#retry) return;
    const delay = this.#backoffMs * (0.5 + Math.random() / 2);
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_LIMIT_MS);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#run(this.#open());
    }, delay);
  }

  /**
   * One Bot API call through Signal. It waits a short time for the socket to be ready, so a call made
   * while the socket reconnects does not fail at once.
   */
  #telegramCall<M extends TelegramCallMethod>(
    botId: string,
    method: M,
    params: TelegramCallParams[M],
  ): Effect.Effect<TelegramCallResult, MessagingAdapterError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.#telegramReady();
      const socket = this.#socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return yield* unavailable();
      const requestId = crypto.randomUUID().replaceAll("-", "");
      const answer = yield* Effect.callback<TelegramCallAnswer>((resume) => {
        this.#telegramCalls.set(requestId, (value) => resume(Effect.succeed(value)));
        const request: SignalClientMessage = {
          type: "telegram-call",
          version: SIGNAL_PROTOCOL_VERSION,
          requestId,
          botId,
          method,
          params,
        };
        socket.send(JSON.stringify(request));
      }).pipe(
        Effect.timeoutOrElse({ duration: TELEGRAM_CALL_TIMEOUT_MS, orElse: () => Effect.succeed(TIMED_OUT) }),
        Effect.ensuring(Effect.sync(() => this.#telegramCalls.delete(requestId))),
      );
      if (answer.ok) return answer.result;
      return yield* new MessagingAdapterError({
        cause: new TelegramCallError(answer.errorCode, answer.description, answer.retryAfter ?? null),
      });
    });
  }

  #telegramReady(): Effect.Effect<void, MessagingAdapterError> {
    if (this.telegram.available()) return Effect.void;
    // A Signal that answered `ready` without Telegram does not gain it on this socket.
    if (this.#state === "online") return Effect.fail(unavailable());
    return Effect.callback<void>((resume) => {
      const stop = this.onState(() => {
        if (!this.telegram.available()) return;
        stop();
        resume(Effect.void);
      });
      return Effect.sync(stop);
    }).pipe(Effect.timeoutOrElse({ duration: TELEGRAM_READY_TIMEOUT_MS, orElse: () => Effect.fail(unavailable()) }));
  }

  /** The socket closed: no answer comes for the calls in flight. */
  #endTelegram(): void {
    this.#capabilities = new Set();
    for (const settle of [...this.#telegramCalls.values()]) settle(UNAVAILABLE_ANSWER);
    this.#telegramCalls.clear();
  }

  #close(): void {
    this.#generation += 1;
    this.#clearRetry();
    this.#stopPing();
    this.#endTelegram();
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
    this.#backoffMs = BACKOFF_START_MS;
    this.#setState("unavailable");
  }

  #setState(state: IngressState): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  #clearRetry(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  #startPing(socket: WebSocket): void {
    this.#stopPing();
    this.#ping = setInterval(() => {
      if (socket !== this.#socket) return;
      pongs.set(socket, false);
      socket.ping();
      setTimeout(() => {
        if (pongs.get(socket) === false) socket.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  #stopPing(): void {
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = null;
  }
}

const pongs = new WeakMap<WebSocket, boolean>();

type TelegramCallAnswer =
  | { ok: true; result: TelegramCallResult }
  | { ok: false; errorCode: number; description: string; retryAfter?: number };

const UNAVAILABLE_ANSWER: TelegramCallAnswer = { ok: false, errorCode: 503, description: "relay_unavailable" };
const TIMED_OUT: TelegramCallAnswer = { ok: false, errorCode: 504, description: "timeout" };

function unavailable(): MessagingAdapterError {
  return new MessagingAdapterError({ cause: new TelegramCallError(503, "relay_unavailable", null) });
}
