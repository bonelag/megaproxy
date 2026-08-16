import { describe, expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { buildModelsRequest } from "../src/oauth";
import { listManagementModelRows } from "../src/server/management/model-rows";
import { handleModelRoutes } from "../src/server/management/model-routes";
import type { ManagementContext } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openrouter",
    providers: {
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        models: ["qwen/qwen-2.5-72b-instruct"],
      },
    },
    customModels: [
      {
        id: "cm-qwen-free",
        provider: "openrouter",
        modelId: "qwen/qwen3.8-max-free",
        displayName: "Qwen 3.8 Max Free",
      },
    ],
  };
}

describe("Slash Model Support (e.g. qwen/qwen3.8-max-free)", () => {
  test("buildModelsRequest strips trailing slash from baseUrl before appending /models", () => {
    const req = buildModelsRequest(
      {
        adapter: "openai-chat",
        baseUrl: "https://api.example.com/v1/",
        apiKey: "sk-test",
      },
      "sk-test",
      "custom-provider",
    );
    expect(req.url).toBe("https://api.example.com/v1/models");
    expect(req.url).not.toContain("//models");
  });

  test("routeModel decodes Codex single-slash slug openrouter/qwen-qwen3.8-max-free back to native qwen/qwen3.8-max-free", () => {
    const config = baseConfig();
    const result = routeModel(config, "openrouter/qwen-qwen3.8-max-free");
    expect(result.providerName).toBe("openrouter");
    expect(result.modelId).toBe("qwen/qwen3.8-max-free");
  });

  test("routeModel accepts raw multi-slash selector openrouter/qwen/qwen3.8-max-free", () => {
    const config = baseConfig();
    const result = routeModel(config, "openrouter/qwen/qwen3.8-max-free");
    expect(result.providerName).toBe("openrouter");
    expect(result.modelId).toBe("qwen/qwen3.8-max-free");
  });

  test("listManagementModelRows projects custom slash model with encoded namespaced slug and native id", async () => {
    const config = baseConfig();
    const rows = await listManagementModelRows(config);
    const customRow = rows.find(r => r.customId === "cm-qwen-free");
    expect(customRow).toBeDefined();
    expect(customRow?.id).toBe("qwen/qwen3.8-max-free");
    expect(customRow?.namespaced).toBe("openrouter/qwen-qwen3.8-max-free");
    expect(customRow?.displayName).toBe("Qwen 3.8 Max Free");
    expect(customRow?.provider).toBe("openrouter");
  });

  test("POST /api/custom-models accepts model IDs with slashes", async () => {
    const config = baseConfig();
    let savedConfig: OcxConfig | null = null;
    const ctx: ManagementContext = {
      req: new Request("http://127.0.0.1:10100/api/custom-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openrouter",
          modelId: "meta-llama/llama-3.3-70b-instruct",
          displayName: "Llama 3.3 70B",
        }),
      }),
      url: new URL("http://127.0.0.1:10100/api/custom-models"),
      config,
      deps: {
        saveConfigPreservingClaudeCode: (cfg) => { savedConfig = cfg; },
      },
      convergeCodexCatalog: async () => ({ status: "ok" as const }),
      syncClaudeAgentDefsBestEffort: () => {},
    };

    const res = await handleModelRoutes(ctx);
    expect(res?.status).toBe(201);
    const body = await res?.json() as { provider: string; modelId: string; displayName?: string };
    expect(body.provider).toBe("openrouter");
    expect(body.modelId).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(body.displayName).toBe("Llama 3.3 70B");
    expect(savedConfig?.customModels?.some(cm => cm.modelId === "meta-llama/llama-3.3-70b-instruct")).toBe(true);
  });
});
