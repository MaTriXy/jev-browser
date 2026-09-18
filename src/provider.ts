// Jev transport: TypeSafe direct (default) or OpenRouter's Decisions API.
// Same {state, questions} / answers contract on both; only URL, auth, and
// model slug differ. OpenRouter is an alpha endpoint and adds a hop, so
// direct TypeSafe remains the recommended default.

import { TypeSafeClient } from "@typesafe-ai/sdk";

export type JevProvider = "typesafe" | "openrouter" | "cloudflare";

export interface AskResult {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  provider: JevProvider;
  model: string;
}

const X_TITLE = "jev-browser";
const REFERER = "https://github.com/jkudish/jev-browser";

let typesafeClient: TypeSafeClient | null = null;

function resolve(env: NodeJS.ProcessEnv): JevProvider {
  const explicit = (env.JEV_PROVIDER ?? "auto").toLowerCase();
  const hasTypesafe = Boolean(env.TYPESAFE_API_KEY);
  const hasOpenRouter = /^sk-or-/.test(env.OPENROUTER_API_KEY ?? "");
  if (explicit === "typesafe") {
    if (!hasTypesafe) throw new Error("JEV_PROVIDER=typesafe but TYPESAFE_API_KEY is not set.");
    return "typesafe";
  }
  if (explicit === "openrouter") {
    if (!hasOpenRouter) throw new Error("JEV_PROVIDER=openrouter but OPENROUTER_API_KEY is not set or not an sk-or- key.");
    return "openrouter";
  }
  const hasCloudflare = Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
  if (explicit === "cloudflare") {
    if (!hasCloudflare) throw new Error("JEV_PROVIDER=cloudflare but CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not both set.");
    return "cloudflare";
  }
  if (hasTypesafe) return "typesafe";
  if (hasOpenRouter) return "openrouter";
  if (hasCloudflare) return "cloudflare";
  throw new Error("No TYPESAFE_API_KEY, OPENROUTER_API_KEY (sk-or-), or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID found. Set one, or JEV_PROVIDER to choose explicitly.");
}

export async function askJev(
  state: unknown,
  questions: Record<string, unknown>,
  model: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const provider = resolve(process.env);

  if (provider === "typesafe") {
    typesafeClient ??= new TypeSafeClient(
      process.env.TYPESAFE_BASE_URL ? { baseURL: process.env.TYPESAFE_BASE_URL } : undefined,
    );
    const response = await (
      typesafeClient.systemOne as unknown as (
        payload: { state: unknown; questions: Record<string, unknown>; model?: string },
        options?: { signal?: AbortSignal },
      ) => Promise<any>
    )({ state, questions, model }, { signal });
    return {
      answers: response.answers,
      usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
      provider,
      model,
    };
  }

  // OpenRouter has no redirecting "latest" slug; map it to the current release.
  // Pin exact versions with the model env var when that matters.
  const OPENROUTER_LATEST = "jev-1.13";
  const effective = model === "jev-latest" ? OPENROUTER_LATEST : model;
  const slug = effective.startsWith("typesafe/") ? effective : `typesafe/${effective}`;
  const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": REFERER,
      "X-Title": X_TITLE,
      "X-OpenRouter-Title": X_TITLE,
    },
    body: JSON.stringify({ model: slug, state, questions }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter decisions API ${response.status}: ${body.slice(0, 200)}`);
  }
  const body = await response.json();
  return {
    answers: body.answers ?? {},
    // The decisions endpoint does not document a usage block; tolerate absence.
    usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
    provider,
    model: slug,
  };

  // Cloudflare Workers AI wraps the same contract in {model, input} and the
  // v4 {result, success} envelope. Single alias; no version pinning.
  const cfSlug = model.startsWith("typesafe/") ? model : `typesafe/${model === "jev-latest" ? "jev" : model}`;
  const cfResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfSlug, input: { state, questions } }),
      signal,
    },
  );
  const cfBody = await cfResponse.json().catch(() => ({}));
  if (!cfResponse.ok || cfBody.success === false) {
    throw new Error(`Cloudflare AI run ${cfResponse.status}: ${JSON.stringify(cfBody.errors ?? cfBody).slice(0, 200)}`);
  }
  const cfPayload = cfBody.result ?? cfBody;
  return {
    answers: cfPayload.answers ?? {},
    usage: { input_tokens: cfPayload.usage?.input_tokens ?? 0, output_tokens: cfPayload.usage?.output_tokens ?? 0 },
    provider,
    model: cfPayload.model ?? cfSlug,
  };
}
