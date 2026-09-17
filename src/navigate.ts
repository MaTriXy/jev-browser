// The navigation loop. Code owns control flow; Jev owns the judgments.
import { chromium, type Browser, type Page } from "playwright";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import TurndownService from "turndown";
import * as gfm from "turndown-plugin-gfm";
import {
  buildActionSpace,
  buildCriteria,
  heuristicQuery,
  MAX_ELEMENTS,
  pickAlternate,
  PRICE_PER_MTOK_IN,
  RawElement,
  selectorFor,
} from "./lib.js";
import { selectOptionQuestion, stepQuestions } from "./questions.js";

const MODEL = process.env.JEV_BROWSER_MODEL ?? "jev-latest";
const MAX_CONSOLE_EVENTS = 200;

export interface NavigateOptions {
  task: string;
  startUrl: string;
  maxSteps?: number;
  maxSeconds?: number;
  allowTyping?: boolean;
  format?: "text" | "markdown" | "html" | "aria";
  maxChars?: number;
  screenshot?: "final" | "none";
}

export interface StepRecord {
  step: number;
  action: string;
  detail: string;
  outcome: string;
  confidence: number | null;
  goal_done: number;
  stuck: number;
}

export interface ConsoleEvent {
  step: number;
  type: "console_error" | "console_warning" | "page_error" | "request_failed";
  text: string;
}

const DEFAULT_CAPS: Record<string, number> = {
  text: 8_000,
  markdown: 16_000,
  html: 1_000_000,
  aria: 16_000,
};

const jev = new TypeSafeClient();
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.use(gfm.gfm);

// ── Typing generator: provider-agnostic via the Vercel AI SDK ────────────────
function resolveGeneratorModel(): { model: Parameters<typeof generateText>[0]["model"]; label: string } | null {
  const providerEnv = process.env.JEV_BROWSER_TYPE_PROVIDER;
  const modelEnv = process.env.JEV_BROWSER_TYPE_MODEL;

  // An explicit OpenAI-compatible endpoint wins: Ollama, LM Studio, vLLM, proxies.
  const baseUrl = process.env.JEV_BROWSER_TYPE_BASE_URL;
  if (baseUrl) {
    const provider = createOpenAICompatible({
      name: "custom",
      baseURL: baseUrl,
      apiKey: process.env.JEV_BROWSER_TYPE_API_KEY ?? "",
    });
    return { model: provider(modelEnv ?? "gpt-5.6-luna"), label: "compatible-endpoint" };
  }

  const candidates: Array<{ provider: string; test: RegExp; make: (m: string) => any; defaultModel: string }> = [
    {
      provider: "openai",
      test: /^sk-/,
      make: (m) => createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(m),
      defaultModel: "gpt-5.6-luna",
    },
    {
      provider: "openrouter",
      test: /^sk-or-/,
      make: (m) => createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY! })(m),
      defaultModel: "openai/gpt-5.6-luna",
    },
    {
      provider: "anthropic",
      test: /^sk-ant-/,
      make: (m) => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(m),
      defaultModel: "claude-haiku-4.5",
    },
    {
      provider: "google",
      test: /^AIza/,
      make: (m) => createGoogleGenerativeAI({ apiKey: (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY)! })(m),
      defaultModel: "gemini-2.5-flash",
    },
  ];

  // Explicit provider first, then auto-detection by key shape.
  const ordered = providerEnv
    ? [...candidates.filter((c) => c.provider === providerEnv), ...candidates.filter((c) => c.provider !== providerEnv)]
    : candidates;

  for (const candidate of ordered) {
    const key =
      candidate.provider === "openai" ? (process.env.OPENAI_API_KEY ?? "") :
      candidate.provider === "openrouter" ? (process.env.OPENROUTER_API_KEY ?? "") :
      candidate.provider === "anthropic" ? (process.env.ANTHROPIC_API_KEY ?? "") :
      (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "");
    if (key.length > 20 && candidate.test.test(key)) {
      return { model: candidate.make(modelEnv ?? candidate.defaultModel), label: candidate.provider };
    }
  }
  return null;
}

async function generateTextToType(task: string, elementDescription: string, url: string): Promise<{ text: string; via: string }> {
  const generator = resolveGeneratorModel();
  if (!generator) return { text: heuristicQuery(task), via: "keyword-heuristic" };
  try {
    const { text } = await generateText({
      model: generator.model,
      prompt: `A browser agent is performing this task: "${task}". It must type into the ${elementDescription} on ${url}. Reply with ONLY the exact text to type (for a search box: a short search query; no quotes, no explanation).`,
      maxOutputTokens: 48,
    });
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    if (cleaned.length === 0) throw new Error("empty generation");
    return { text: cleaned, via: generator.label };
  } catch {
    // A bad model id or provider outage must not kill the task; degrade and say so.
    return { text: heuristicQuery(task), via: "keyword-heuristic-after-generator-error" };
  }
}

// ── Jev ───────────────────────────────────────────────────────────────────────
export interface JevUsage {
  jev_calls: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

const usage: JevUsage = { jev_calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 };

async function askJev(state: unknown, questions: Record<string, unknown>) {
  const response = await (jev.systemOne as unknown as (p: unknown) => any)({
    state,
    questions,
    model: MODEL,
  });
  usage.jev_calls += 1;
  usage.input_tokens += response.usage?.input_tokens ?? 0;
  usage.output_tokens += response.usage?.output_tokens ?? 0;
  usage.est_cost_usd = (usage.input_tokens / 1e6) * PRICE_PER_MTOK_IN;
  return response.answers;
}

// ── Extraction: DOM-first (a11y trees under-report inputs) ───────────────────
async function extractAndStamp(page: Page): Promise<RawElement[]> {
  return page.evaluate(() => {
    // Clear stamps from previous steps first: elements that dropped out of the
    // candidate list keep their old data-jev-id, which would make selectors
    // match more than one element.
    document.querySelectorAll("[data-jev-id]").forEach((el) => el.removeAttribute("data-jev-id"));
    const SEL =
      'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="searchbox"], [role="textbox"]';
    const nodes = Array.from(document.querySelectorAll(SEL)).slice(0, 2000);
    let n = 0;
    const out: any[] = [];
    for (const el of nodes as HTMLElement[]) {
      const rects = el.getClientRects();
      if (!rects.length) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const tag = el.tagName.toLowerCase();
      const roleAttr = el.getAttribute("role") || "";
      const typeAttr = (el.getAttribute("type") || "").toLowerCase();
      const label = (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.innerText ||
        el.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      const href = tag === "a" ? el.getAttribute("href") || "" : "";
      const clickable =
        ["a", "button"].includes(tag) ||
        ["button", "link"].includes(roleAttr) ||
        ["submit", "button", "checkbox", "radio"].includes(typeAttr);
      const typeable =
        tag === "textarea" ||
        (tag === "input" && !["submit", "button", "checkbox", "radio", "file", "hidden", "range", "password"].includes(typeAttr)) ||
        ["searchbox", "textbox"].includes(roleAttr);
      const selectable = tag === "select";
      if (!clickable && !typeable && !selectable) continue;
      n += 1;
      const attr = `j${n}`;
      el.setAttribute("data-jev-id", attr);
      const options =
        tag === "select"
          ? Array.from((el as unknown as HTMLSelectElement).options)
              .map((o) => (o.label || o.value || "").trim())
              .filter(Boolean)
              .slice(0, 200)
          : undefined;
      out.push({ attr, tag, role: roleAttr || tag, text: label.slice(0, 80), href: el.getAttribute("href") || (href as string), typeAttr, clickable, typeable, options });
    }
    return out;
  });
}

async function pageObservables(page: Page): Promise<{ url: string; title: string; textLength: number }> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const textLength = await page
    .evaluate(() => document.body?.innerText?.length ?? 0)
    .catch(() => 0);
  return { url, title, textLength };
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

// ── The loop ─────────────────────────────────────────────────────────────────
export async function navigate(options: NavigateOptions) {
  const {
    task,
    startUrl,
    maxSteps = 24,
    maxSeconds = 180,
    allowTyping = true,
    format = "text",
    screenshot = "final",
  } = options;
  const maxChars = options.maxChars ?? DEFAULT_CAPS[format];
  const started = performance.now();
  const deadline = started + maxSeconds * 1000;
  usage.jev_calls = 0;
  usage.input_tokens = 0;
  usage.output_tokens = 0;
  usage.est_cost_usd = 0;

  const steps: StepRecord[] = [];
  const consoleEvents: ConsoleEvent[] = [];
  let consoleDropped = 0;
  const currentStep = { n: 0 };

  const browser: Browser = await chromium.launch({ headless: process.env.JEV_BROWSER_HEADED !== "1" });
  let status: string = "error";
  let error: string | undefined;

  try {
    const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
    let page = await context.newPage();

    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      record({ step: currentStep.n, type: `console_${type}` as ConsoleEvent["type"], text: msg.text().slice(0, 300) });
    });
    page.on("pageerror", (err) => record({ step: currentStep.n, type: "page_error", text: String(err).slice(0, 300) }));
    page.on("requestfailed", (req) =>
      record({ step: currentStep.n, type: "request_failed", text: `${req.method()} ${req.url().slice(0, 200)} ${req.failure()?.errorText ?? ""}`.slice(0, 300) }),
    );
    // New-tab adoption: popups and target=_blank become the active page.
    let pendingPage: Page | null = null;
    context.on("page", (p) => {
      pendingPage = p;
    });

    function record(event: ConsoleEvent) {
      if (consoleEvents.length >= MAX_CONSOLE_EVENTS) {
        consoleDropped += 1;
        return;
      }
      consoleEvents.push(event);
    }

    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    let lastAction: string | null = null;
    let lastOutcome: string | null = null;
    const history: Array<{ step: number; action: string; outcome: string }> = [];

    for (let step = 1; step <= maxSteps; step++) {
      currentStep.n = step;
      if (performance.now() > deadline) {
        status = "timeout";
        break;
      }

      const raw = await extractAndStamp(page);
      const { elements, truncated } = buildActionSpace(raw);
      if (elements.length === 0) {
        steps.push({ step, action: "none", detail: "no interactive elements found", outcome: "empty action space", confidence: null, goal_done: 0, stuck: 1 });
        status = "stuck";
        break;
      }

      const observables = await pageObservables(page);
      const state = {
        task,
        current_page: { url: observables.url, title: observables.title },
        interactive_elements: elements.map((e) => ({ id: e.id, description: e.description })),
        element_list_truncated: truncated,
        history,
      };
      const answers = await askJev(state, stepQuestions(buildCriteria(elements)));
      const actionAnswer = answers.action;
      let chosen: string = actionAnswer.choice;

      // Repeat-no-op recovery: switch to the next-best option from the distribution.
      // Deliberately no low-confidence override: split distributions between similar
      // options are legitimate (several acceptable alternatives).
      if (lastAction === chosen && lastOutcome === "no visible change") {
        const alternate = pickAlternate(actionAnswer.probabilities, new Set([chosen]));
        if (alternate) {
          steps.push({
            step,
            action: `${chosen} -> ${alternate}`,
            detail: `repeat no-op; gate switched to next-best action`,
            outcome: "recovery",
            confidence: actionAnswer.confidence ?? null,
            goal_done: answers.goal_done.noul,
            stuck: answers.stuck.noul,
          });
          chosen = alternate;
        }
      }

      if (chosen === "done") {
        status = "done";
        steps.push({ step, action: "done", detail: "agent declared done", outcome: "stopped", confidence: actionAnswer.confidence ?? null, goal_done: answers.goal_done.noul, stuck: answers.stuck.noul });
        break;
      }

      const element = elements.find(
        (e) => chosen === `click_${e.id}` || chosen === `type_${e.id}` || chosen === `select_${e.id}`,
      );

      let detail = chosen;
      try {
        if (chosen === "back") {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
          detail = "went back";
        } else if (chosen === "scroll_down" || chosen === "scroll_up") {
          await page.evaluate((dir) => window.scrollBy(0, dir * window.innerHeight * 0.8), chosen === "scroll_down" ? 1 : -1);
          detail = chosen;
        } else if (!element) {
          detail = `unknown action ${chosen}`;
        } else if (chosen.startsWith("type_")) {
          if (!allowTyping) {
            detail = "typing disabled by caller";
          } else {
            const generated = await generateTextToType(task, element.description, page.url());
            await page.fill(selectorFor(element), generated.text, { timeout: 8_000 });
            await page.press(selectorFor(element), "Enter", { timeout: 8_000 });
            detail = `typed "${generated.text}" via ${generated.via}`;
          }
        } else if (chosen.startsWith("select_")) {
          const opts = element.options ?? [];
          if (opts.length === 0) {
            detail = "select had no options";
          } else {
            const optionAnswer = await askJev(
              { task, page: { url: observables.url, title: observables.title }, dropdown: element.description, options: opts },
              { option: selectOptionQuestion(element.description, opts) },
            );
            const pickedIndex = Number((optionAnswer.option.choice as string).slice(1));
            const label = opts[pickedIndex] ?? opts[0];
            await page.selectOption(selectorFor(element), { label });
            detail = `selected "${label}"`;
          }
        } else {
          await page.click(selectorFor(element), { timeout: 8_000 });
          detail = element.description;
        }
      } catch (actionError) {
        detail = `action failed: ${(actionError as Error).message.slice(0, 120)}`;
      }

      await settle(page);
      if (pendingPage) {
        page = pendingPage;
        pendingPage = null;
        await settle(page);
        detail += " (followed new tab)";
      }

      const after = await pageObservables(page);
      const outcome =
        after.url !== observables.url
          ? `navigated to ${after.url}`
          : after.title !== observables.title
            ? `page changed: "${after.title}"`
            : Math.abs(after.textLength - observables.textLength) > 50
              ? "page content changed"
              : "no visible change";

      lastAction = chosen;
      lastOutcome = outcome;
      history.push({ step, action: chosen, outcome });
      steps.push({
        step,
        action: chosen,
        detail,
        outcome,
        confidence: actionAnswer.confidence ?? null,
        goal_done: answers.goal_done.noul,
        stuck: answers.stuck.noul,
      });

      if (answers.goal_done.noul > 0.85) {
        status = "goal_achieved";
        break;
      }
      if (answers.stuck.noul > 0.85 && step > 2) {
        status = "stuck";
        break;
      }
      if (step === maxSteps) status = "max_steps";
    }

    const finalObservables = await pageObservables(page);
    const payload = await extractPayload(page, format, maxChars);
    let screenshotBase64: string | null = null;
    if (screenshot === "final") {
      const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
      screenshotBase64 = buffer.toString("base64");
    }

    return {
      status,
      error,
      final_url: finalObservables.url,
      final_title: finalObservables.title,
      format,
      max_chars: maxChars,
      page: payload,
      steps,
      console_events: consoleEvents,
      console_events_dropped: consoleDropped,
      usage: { ...usage },
      elapsed_ms: Math.round(performance.now() - started),
      model: MODEL,
      screenshot_base64_jpeg: screenshotBase64,
    };
  } catch (runError) {
    error = (runError as Error).message;
    return {
      status: "error",
      error,
      steps,
      console_events: consoleEvents,
      console_events_dropped: consoleDropped,
      usage: { ...usage },
      elapsed_ms: Math.round(performance.now() - started),
      model: MODEL,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function extractPayload(
  page: Page,
  format: string,
  maxChars: number,
): Promise<{ truncated: boolean; true_length: number; content: string }> {
  let content = "";
  if (format === "html") {
    content = await page.evaluate(() => document.documentElement.outerHTML);
  } else if (format === "aria") {
    content = await page.locator("body").ariaSnapshot();
  } else if (format === "markdown") {
    const html = await page.evaluate(() => document.body?.innerHTML ?? "");
    content = turndown.turndown(html);
  } else {
    content = await page.evaluate(() => document.body?.innerText ?? "");
  }
  return {
    truncated: content.length > maxChars,
    true_length: content.length,
    content: content.slice(0, maxChars),
  };
}
