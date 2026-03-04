/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { FeishuDomain } from "./types.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = { cardId: string; messageId: string; sequence: number; currentText: string };

/** Optional header for streaming cards (title bar with color template) */
export type StreamingCardHeader = {
  title: string;
  /** Color template: blue, green, red, orange, purple, indigo, wathet, turquoise, yellow, grey, carmine, violet, lime */
  template?: string;
};

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
    policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
    auditContext: "feishu.streaming-card.token",
  });
  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  await release();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous || next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }
  // Fallback for fragmented partial chunks: append as-is to avoid losing tokens.
  return `${previous}${next}`;
}

/** Multi-stage thinking animation frames with progressive progress bar.
 *  `basePct` is the center value; actual displayed % is basePct ± random jitter. */
const THINKING_FRAMES: Array<{ text: string; filled: number; basePct: number; jitter: number }> = [
  { text: "🔍 正在理解问题...", filled: 2, basePct: 12, jitter: 4 },
  { text: "🔍 正在理解问题...", filled: 6, basePct: 28, jitter: 5 },
  { text: "🔍 正在理解问题...", filled: 7, basePct: 33, jitter: 3 },
  { text: "📚 正在检索知识...", filled: 10, basePct: 47, jitter: 5 },
  { text: "📚 正在检索知识...", filled: 10, basePct: 52, jitter: 4 },
  { text: "🧠 正在组织回答...", filled: 14, basePct: 65, jitter: 4 },
  { text: "🧠 正在组织回答...", filled: 14, basePct: 71, jitter: 3 },
  { text: "✍️ 即将开始输出...", filled: 16, basePct: 78, jitter: 4 },
  { text: "✍️ 即将开始输出...", filled: 18, basePct: 88, jitter: 3 },
];

/** Return basePct with random jitter, clamped so pct never decreases below prevPct */
function jitteredPct(basePct: number, jitter: number, prevPct: number): number {
  const raw = basePct + (Math.random() * 2 - 1) * jitter;
  // Round to 1 decimal, ensure monotonically increasing
  return Math.max(prevPct + 0.1, Math.round(raw * 10) / 10);
}
const PROGRESS_BAR_LENGTH = 20;
const CONVERGENCE_RATE = 0.1; // Each tick advances 10% of remaining distance
const THINKING_STAGE_INTERVAL_MS = 2000;

function buildThinkingFrame(text: string, filled: number, pct: number): string {
  const bar = "🟩".repeat(filled) + "⬜".repeat(PROGRESS_BAR_LENGTH - filled);
  return `${text}\n${bar} ${pct.toFixed(1)}%`;
}

/** Max button label length (truncated with ellipsis) */
const MAX_BUTTON_LABEL_LENGTH = 25;

/** Patterns that indicate a prose-style suggestion/offer sentence */
const PROSE_SUGGESTION_PATTERNS = [
  /我.{0,6}可以.{0,2}(?:继续|帮|给|为|再|补|做|写|画|生成|分析|整理|提供|输出)/,
  /你可以(?:试试|尝试|考虑|选择)/,
  /是否需要我/,
  /如果你(?:愿意|需要|想|要)/,
  /要不要我/,
  /需要我(?:帮|给|做|继续)/,
  /下一步.{0,4}(?:可以|建议|推荐)/,
  /(?:还能|还可以|也可以).{0,6}(?:帮|给|做|试|看)/,
];

/** Extract actionable suggestions from the tail of LLM response text.
 *  Strategy 1: Scan backwards for consecutive bullet/numbered list items.
 *  Strategy 2: If no list found, scan tail lines for prose-style suggestion patterns. */
export function extractSuggestions(text: string, max = 3): string[] {
  const lines = text.split("\n").filter((l) => l.trim());

  // Strategy 1: trailing bullet/numbered list
  const listItems: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^\s*(?:[-•*]|\d+[.、)]\s*)\s*(.+)/);
    if (match) {
      listItems.unshift(match[1].trim());
    } else {
      break;
    }
  }
  if (listItems.length > 0) {
    return listItems.slice(0, max);
  }

  // Strategy 2: prose-style suggestions in the last few lines
  const proseSuggestions: string[] = [];
  const tailLines = lines.slice(-5); // Only check last 5 lines
  for (const line of tailLines) {
    const trimmed = line.trim();
    if (PROSE_SUGGESTION_PATTERNS.some((p) => p.test(trimmed))) {
      // Strip markdown bold/code for cleaner extraction
      const clean = trimmed.replace(/\*\*/g, "").replace(/`/g, "").trim();
      proseSuggestions.push(clean);
    }
  }
  return proseSuggestions.slice(0, max);
}

function truncateLabel(text: string, max = MAX_BUTTON_LABEL_LENGTH): string {
  // Strip markdown formatting for label display
  const clean = text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

// In-memory cache: messageId → markdown content (for button removal after click)
const cardContentCache = new Map<string, string>();

/** Get cached markdown content for a card message (used by card-action to remove buttons) */
export function getCachedCardContent(messageId: string): string | undefined {
  return cardContentCache.get(messageId);
}

/** Build card JSON without any buttons (used after button click to clean up) */
export function buildCardWithoutButtons(
  content: string,
  header?: { title: { tag: string; content: string }; template?: string },
): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: "2.0",
    body: {
      elements: [{ tag: "markdown", content, element_id: "content" }],
    },
  };
  if (header) {
    card.header = header;
  }
  return card;
}

/** Build card JSON with dynamic buttons based on suggestions */
function buildFinalCardJson(
  content: string,
  suggestions: string[],
  header?: { title: string; template?: string },
): Record<string, unknown> {
  // Build button columns: use flex_mode "flow" so buttons auto-wrap when
  // the row is too narrow, keeping text fully visible without truncation.
  const buttonColumns =
    suggestions.length > 0
      ? suggestions.map((s, i) => ({
          tag: "column" as const,
          width: "auto" as const,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: s },
              type: "primary",
              value: { text: s },
              element_id: `btn_suggest_${i}`,
              behaviors: [{ type: "callback", value: { text: s } }],
            },
          ],
        }))
      : [
          {
            tag: "column" as const,
            width: "auto" as const,
            elements: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "👍Good Job" },
                type: "primary",
                value: { action: "approve" },
                element_id: "btn_approve",
                behaviors: [{ type: "callback", value: { action: "approve" } }],
              },
            ],
          },
          {
            tag: "column" as const,
            width: "auto" as const,
            elements: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "👎Bad Job" },
                type: "danger",
                value: { action: "reject" },
                element_id: "btn_reject",
                behaviors: [{ type: "callback", value: { action: "reject" } }],
              },
            ],
          },
        ];

  const card: Record<string, unknown> = {
    schema: "2.0",
    body: {
      elements: [
        { tag: "markdown", content, element_id: "content" },
        { tag: "hr" },
        {
          tag: "column_set",
          flex_mode: "flow",
          horizontal_spacing: "small",
          columns: buttonColumns,
        },
      ],
    },
  };
  if (header) {
    card.header = {
      title: { tag: "plain_text", content: header.title },
      template: header.template ?? "blue",
    };
  }
  return card;
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private updateThrottleMs = 100; // Throttle updates to max 10/sec
  private thinkingTimer: ReturnType<typeof setInterval> | null = null;
  private thinkingStageIndex = 0;
  private currentPct = 0; // Tracks percentage for convergence phase
  private quickComplete?: (prompt: string) => Promise<string>;

  constructor(
    client: Client,
    creds: Credentials,
    log?: (msg: string) => void,
    quickComplete?: (prompt: string) => Promise<string>,
  ) {
    this.client = client;
    this.creds = creds;
    this.log = log;
    this.quickComplete = quickComplete;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: {
      replyToMessageId?: string;
      replyInThread?: boolean;
      rootId?: string;
      header?: StreamingCardHeader;
    },
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 2 } },
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: buildThinkingFrame(
              THINKING_FRAMES[0].text,
              THINKING_FRAMES[0].filled,
              jitteredPct(THINKING_FRAMES[0].basePct, THINKING_FRAMES[0].jitter, 0),
            ),
            element_id: "content",
          },
        ],
      },
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: options.header.template ?? "blue",
      };
    }

    // Create card entity
    const { response: createRes, release: releaseCreate } = await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.create",
    });
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    await releaseCreate();
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Topic-group replies require root_id routing. Prefer create+root_id when available.
    let sendRes;
    if (options?.rootId) {
      const createData = {
        receive_id: receiveId,
        msg_type: "interactive",
        content: cardContent,
        root_id: options.rootId,
      };
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: createData,
      });
    } else if (options?.replyToMessageId) {
      sendRes = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...(options.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = { cardId, messageId: sendRes.data.message_id, sequence: 1, currentText: "" };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
    this.startThinkingAnimation();
  }

  /** Progressive thinking animation: predefined frames then asymptotic convergence */
  private startThinkingAnimation(): void {
    this.thinkingStageIndex = 0;
    this.currentPct = 0;
    this.thinkingTimer = setInterval(() => {
      if (!this.state || this.closed) {
        this.stopThinkingAnimation();
        return;
      }
      this.thinkingStageIndex += 1;
      let frame: string;
      if (this.thinkingStageIndex < THINKING_FRAMES.length) {
        // Phase 1: predefined frames with random jitter (12%~88%)
        const f = THINKING_FRAMES[this.thinkingStageIndex];
        this.currentPct = jitteredPct(f.basePct, f.jitter, this.currentPct);
        frame = buildThinkingFrame(f.text, f.filled, this.currentPct);
      } else {
        // Phase 2: asymptotic convergence — never reaches 100%
        this.currentPct += (100 - this.currentPct) * CONVERGENCE_RATE;
        frame = buildThinkingFrame("✍️ 即将开始输出...", 18, this.currentPct);
      }
      this.queue = this.queue.then(async () => {
        if (this.thinkingTimer && this.state) {
          await this.updateCardContent(frame);
        }
      });
    }, THINKING_STAGE_INTERVAL_MS);
  }

  private stopThinkingAnimation(): void {
    if (this.thinkingTimer) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  private async updateCardContent(text: string, onError?: (error: unknown) => void): Promise<void> {
    if (!this.state) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
      init: {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: text,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.update",
    })
      .then(async ({ release }) => {
        await release();
      })
      .catch((error) => onError?.(error));
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    // Flash 100% completion frame, then stop thinking animation
    if (this.thinkingTimer) {
      const doneFrame = buildThinkingFrame("✅ 开始输出...", PROGRESS_BAR_LENGTH, 100);
      this.queue = this.queue.then(async () => {
        if (this.state && !this.closed) {
          await this.updateCardContent(doneFrame);
        }
      });
    }
    this.stopThinkingAnimation();
    const mergedInput = mergeStreamingText(this.pendingText ?? this.state.currentText, text);
    if (!mergedInput || mergedInput === this.state.currentText) {
      return;
    }

    // Throttle: skip if updated recently, but remember pending text
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = mergedInput;
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      const mergedText = mergeStreamingText(this.state.currentText, mergedInput);
      if (!mergedText || mergedText === this.state.currentText) {
        return;
      }
      this.state.currentText = mergedText;
      await this.updateCardContent(mergedText, (e) => this.log?.(`Update failed: ${String(e)}`));
    });
    await this.queue;
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.stopThinkingAnimation();
    this.closed = true;
    await this.queue;

    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;
    const apiBase = resolveApiBase(this.creds.domain);

    // Only send final update if content differs from what's already displayed
    if (text && text !== this.state.currentText) {
      await this.updateCardContent(text);
      this.state.currentText = text;
    }

    // Close streaming mode
    this.state.sequence += 1;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
      init: {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: truncateSummary(text) } },
          }),
          sequence: this.state.sequence,
          uuid: `c_${this.state.cardId}_${this.state.sequence}`,
        }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.close",
    })
      .then(async ({ release }) => {
        await release();
      })
      .catch((e) => this.log?.(`Close failed: ${String(e)}`));

    this.log?.(`Closed streaming: cardId=${this.state.cardId}`);

    // Update buttons based on extracted suggestions from the response
    await this.updateDynamicButtons(text);
  }

  /** Replace card buttons with dynamic suggestions extracted from the response */
  private async updateDynamicButtons(text: string): Promise<void> {
    if (!this.state) {
      this.log?.("[updateDynamicButtons] skipped: no state");
      return;
    }
    this.log?.(
      `[updateDynamicButtons] start: textLen=${text.length}, hasQuickComplete=${!!this.quickComplete}`,
    );
    let suggestions: string[] = [];

    // Priority: LLM-based extraction
    if (this.quickComplete) {
      try {
        const tailText = text.slice(-800);
        this.log?.(
          `[updateDynamicButtons] LLM input tail (${tailText.length} chars): ${tailText.slice(0, 120)}...`,
        );
        const prompt = `你是一个对话助手。下面是 AI 助手刚给用户的回复。
请站在用户的角度，生成 1-3 条用户最可能的后续回复。
要求：
- 每条是用户会直接发送的自然回复（如"好的，帮我生成一个带 jq 的版本"）
- 不超过 20 字，语气自然口语化
- 基于回复中的建议或可选方案来生成
返回 JSON 数组格式。如果没有明显的后续建议，返回空数组 []。
只返回 JSON 数组，不要其他文字。

回复内容：
${tailText}`;
        const result = await this.quickComplete(prompt);
        this.log?.(`[updateDynamicButtons] LLM raw result: ${result}`);
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as unknown;
          this.log?.(`[updateDynamicButtons] LLM parsed: ${JSON.stringify(parsed)}`);
          if (Array.isArray(parsed) && parsed.length > 0) {
            suggestions = parsed.slice(0, 3).map(String);
            this.log?.(
              `[updateDynamicButtons] LLM extracted ${suggestions.length} suggestions: ${JSON.stringify(suggestions)}`,
            );
          } else {
            this.log?.("[updateDynamicButtons] LLM returned empty or non-array");
          }
        } else {
          this.log?.("[updateDynamicButtons] LLM result has no JSON array match");
        }
      } catch (e) {
        this.log?.(`[updateDynamicButtons] LLM failed: ${String(e)}`);
      }
    } else {
      this.log?.("[updateDynamicButtons] quickComplete not available, using regex only");
    }

    // Fallback: regex-based extraction
    if (suggestions.length === 0) {
      suggestions = extractSuggestions(text);
      this.log?.(
        `[updateDynamicButtons] regex fallback: ${suggestions.length} suggestions: ${JSON.stringify(suggestions)}`,
      );
    }

    this.log?.(
      `[updateDynamicButtons] final suggestions (${suggestions.length}): ${JSON.stringify(suggestions)}`,
    );

    const card = buildFinalCardJson(this.state.currentText, suggestions);
    try {
      const response = await this.client.im.message.patch({
        path: { message_id: this.state.messageId },
        data: { content: JSON.stringify(card) },
      });
      if (response.code !== 0) {
        this.log?.(
          `[updateDynamicButtons] patch failed: ${response.msg || `code ${response.code}`}`,
        );
      } else {
        this.log?.(`[updateDynamicButtons] patch success: ${suggestions.length} buttons`);
        // Cache content so card-action can rebuild card without buttons
        cardContentCache.set(this.state.messageId, this.state.currentText);
      }
    } catch (e) {
      this.log?.(`[updateDynamicButtons] patch error: ${String(e)}`);
    }
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
