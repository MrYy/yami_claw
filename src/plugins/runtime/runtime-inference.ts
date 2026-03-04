/**
 * Lightweight inference capability for plugins.
 * Provides one-shot LLM calls using the first available model,
 * following the same pattern as media-understanding/providers/image.ts.
 */

import type { PluginRuntimeCore } from "./types-core.js";

export function createRuntimeInference(): NonNullable<PluginRuntimeCore["inference"]> {
  return {
    quickComplete: async (prompt: string): Promise<string> => {
      // Dynamic imports to avoid circular dependencies
      const { resolveOpenClawAgentDir } = await import("../../agents/agent-paths.js");
      const { discoverAuthStorage, discoverModels } =
        await import("../../agents/pi-model-discovery.js");
      const { getApiKeyForModel, requireApiKey } = await import("../../agents/model-auth.js");
      const { complete } = await import("@mariozechner/pi-ai");

      const agentDir = resolveOpenClawAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);

      // Pick a suitable model: prefer non-codex Chat Completions models,
      // then fall back to any available model.
      const available = modelRegistry.getAvailable();
      const preferredModel = available.find(
        (m) => m.provider !== "openai-codex" && !m.id.includes("codex"),
      );
      const model = preferredModel ?? available[0];
      if (!model) {
        throw new Error("quickComplete: no available model found (no API keys configured)");
      }

      const apiKeyInfo = await getApiKeyForModel({ model, agentDir });
      const apiKey = requireApiKey(apiKeyInfo, model.provider);
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      const log = (msg: string) => console.log(`[quickComplete] ${msg}`);
      log(`using model: ${model.provider}/${model.id}`);

      // Include a system message for API compatibility (Responses API requires "instructions")
      const message = await complete(
        model,
        {
          messages: [
            {
              role: "system",
              content: "You are a helpful assistant. Reply in the same language as the user.",
              timestamp: Date.now(),
            },
            { role: "user", content: prompt, timestamp: Date.now() },
          ],
        },
        { apiKey, maxTokens: 512 },
      );

      log(`stopReason=${message.stopReason}, errorMessage=${message.errorMessage ?? "none"}`);
      log(
        `content parts: ${message.content.length}, types: ${message.content.map((p) => p.type).join(",")}`,
      );
      log(`raw content: ${JSON.stringify(message.content).slice(0, 500)}`);

      // Extract text from AssistantMessage.content array
      const textParts = message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text);
      const result = textParts.join("\n") || "";
      log(`extracted text (${result.length} chars): ${result.slice(0, 200)}`);
      return result;
    },
  };
}
