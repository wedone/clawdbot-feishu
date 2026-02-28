import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Harness = {
  handleFeishuMessage: (params: any) => Promise<void>;
  getMessageFeishu: ReturnType<typeof vi.fn>;
  dispatchReplyFromConfig: ReturnType<typeof vi.fn>;
  createFeishuReplyDispatcher: ReturnType<typeof vi.fn>;
};

async function setupHarness(params?: {
  getMessageFeishuImpl?: (args: { messageId: string }) => Promise<any>;
}): Promise<Harness> {
  vi.resetModules();
  vi.clearAllMocks();

  const getMessageFeishu = vi.fn(async (args: { messageId: string }) => ({
    messageId: args.messageId,
    chatId: "oc_group",
    content: "[Alice] merged forward content",
    contentType: "merge_forward",
  }));
  if (params?.getMessageFeishuImpl) {
    getMessageFeishu.mockImplementation(params.getMessageFeishuImpl);
  }
  const sendMessageFeishu = vi.fn(async () => undefined);
  vi.doMock("../send.js", () => ({
    getMessageFeishu,
    sendMessageFeishu,
  }));

  const createFeishuReplyDispatcher = vi.fn(() => ({
    dispatcher: vi.fn(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }));
  vi.doMock("../reply-dispatcher.js", () => ({
    createFeishuReplyDispatcher,
  }));

  vi.doMock("../client.js", () => ({
    createFeishuClient: vi.fn(() => ({
      contact: {
        user: {
          get: vi.fn(async () => ({
            data: { user: { name: "Sender" } },
          })),
        },
      },
    })),
  }));

  const runtimeMod = await import("../runtime.js");
  const botMod = await import("../bot.js");

  const dispatchReplyFromConfig = vi.fn(async () => ({
    queuedFinal: false,
    counts: { final: 1, partial: 0 },
  }));

  runtimeMod.setFeishuRuntime({
    version: "test",
    channel: {
      text: {
        hasControlCommand: vi.fn(() => false),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        shouldHandleTextCommands: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => true),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "TEST1234", created: true })),
        buildPairingReply: vi.fn(() => "OpenClaw: access not configured."),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "feishu:default:session",
          accountId: "default",
          agentId: "assistant",
          matchedBy: "default",
        })),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext: vi.fn((ctx: any) => ctx),
        dispatchReplyFromConfig,
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
  } as any);

  return {
    handleFeishuMessage: botMod.handleFeishuMessage,
    getMessageFeishu,
    dispatchReplyFromConfig,
    createFeishuReplyDispatcher,
  };
}

function buildCfg() {
  return {
    channels: {
      feishu: {
        appId: "cli_test",
        appSecret: "sec_test",
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        requireMention: false,
        allowMentionlessInMultiBotGroup: true,
      },
    },
    commands: {},
  } as any;
}

async function flushForwardedCoalesceWindow() {
  await vi.advanceTimersByTimeAsync(1800);
}

describe("forwarded dispatch coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-28T12:00:00Z"));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches standalone forwarded message after coalesce window", async () => {
    const harness = await setupHarness();

    await harness.handleFeishuMessage({
      cfg: buildCfg(),
      event: {
        sender: {
          sender_id: {
            open_id: "ou_sender",
            user_id: "u_sender",
          },
        },
        message: {
          message_id: "om_forward_only",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "merge_forward",
          content: JSON.stringify({ message_count: 1 }),
        },
      },
      accountId: "default",
      runtime: { log: vi.fn(), error: vi.fn() } as any,
    });

    await flushForwardedCoalesceWindow();

    expect(harness.getMessageFeishu).toHaveBeenCalledTimes(1);
    expect(harness.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const dispatcherArg = harness.createFeishuReplyDispatcher.mock.calls[0]?.[0];
    expect(dispatcherArg?.replyToMessageId).toBe("om_forward_only");
  });

  it("merges pending forwarded content into parent-reply follow-up even when sender ids differ", async () => {
    const harness = await setupHarness();
    const runtime = { log: vi.fn(), error: vi.fn() } as any;

    await harness.handleFeishuMessage({
      cfg: buildCfg(),
      event: {
        sender: {
          sender_id: {
            open_id: "ou_sender",
          },
        },
        message: {
          message_id: "om_forward_first",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "merge_forward",
          content: JSON.stringify({ message_count: 1 }),
        },
      },
      accountId: "default",
      runtime,
    });

    await harness.handleFeishuMessage({
      cfg: buildCfg(),
      event: {
        sender: {
          sender_id: {
            user_id: "u_sender_only",
          },
        },
        message: {
          message_id: "om_followup_with_parent",
          parent_id: "om_forward_first",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "please summarize" }),
        },
      },
      accountId: "default",
      runtime,
    });

    await flushForwardedCoalesceWindow();

    expect(harness.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const dispatchedRawBody = harness.dispatchReplyFromConfig.mock.calls[0]?.[0]?.ctx?.RawBody;
    expect(dispatchedRawBody).toContain("merged forward content");
    expect(dispatchedRawBody).toContain("please summarize");
  });

  it("skips late companion forwarded event after parent-reply was already processed", async () => {
    const harness = await setupHarness();
    const runtime = { log: vi.fn(), error: vi.fn() } as any;

    await harness.handleFeishuMessage({
      cfg: buildCfg(),
      event: {
        sender: {
          sender_id: {
            user_id: "u_sender_only",
          },
        },
        message: {
          message_id: "om_followup_first",
          parent_id: "om_forward_late",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "please review this context" }),
        },
      },
      accountId: "default",
      runtime,
    });

    await harness.handleFeishuMessage({
      cfg: buildCfg(),
      event: {
        sender: {
          sender_id: {
            open_id: "ou_sender",
          },
        },
        message: {
          message_id: "om_forward_late",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "merge_forward",
          content: JSON.stringify({ message_count: 1 }),
        },
      },
      accountId: "default",
      runtime,
    });

    await flushForwardedCoalesceWindow();

    expect(harness.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(harness.getMessageFeishu).toHaveBeenCalledTimes(1);
    const dispatchedRawBody = harness.dispatchReplyFromConfig.mock.calls[0]?.[0]?.ctx?.RawBody;
    expect(dispatchedRawBody).toContain("merged forward content");
    expect(dispatchedRawBody).toContain("please review this context");
  });

  it("does not enqueue deferred forwarded dispatch when parent-reply is processed during forwarded fetch", async () => {
    let firstForwardFetch = true;
    let releaseForwardFetch: (() => void) | undefined;
    const blockForwardFetch = new Promise<void>((resolve) => {
      releaseForwardFetch = resolve;
    });

    const harness = await setupHarness({
      getMessageFeishuImpl: async (args: { messageId: string }) => {
        if (args.messageId === "om_forward_race" && firstForwardFetch) {
          firstForwardFetch = false;
          await blockForwardFetch;
        }
        return {
          messageId: args.messageId,
          chatId: "oc_group",
          content: "[Alice] merged forward content",
          contentType: "merge_forward",
        };
      },
    });

    const runtime = { log: vi.fn(), error: vi.fn() } as any;

    const forwardedPromise = harness.handleFeishuMessage({
      cfg: buildCfg(),
      event: {
        sender: { sender_id: { open_id: "ou_sender", user_id: "u_sender" } },
        message: {
          message_id: "om_forward_race",
          chat_id: "oc_group",
          chat_type: "p2p",
          message_type: "merge_forward",
          content: JSON.stringify({ message_count: 1 }),
        },
      },
      accountId: "default",
      runtime,
    });

    // Let forwarded message enter fetch-await section.
    await Promise.resolve();
    await Promise.resolve();

    await harness.handleFeishuMessage({
      cfg: buildCfg(),
      event: {
        sender: { sender_id: { open_id: "ou_sender", user_id: "u_sender" } },
        message: {
          message_id: "om_followup_race",
          parent_id: "om_forward_race",
          chat_id: "oc_group",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "follow-up question" }),
        },
      },
      accountId: "default",
      runtime,
    });

    releaseForwardFetch?.();
    await forwardedPromise;
    await flushForwardedCoalesceWindow();

    expect(harness.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const dispatchedRawBody = harness.dispatchReplyFromConfig.mock.calls[0]?.[0]?.ctx?.RawBody;
    expect(dispatchedRawBody).toContain("merged forward content");
    expect(dispatchedRawBody).toContain("follow-up question");
  });
});
