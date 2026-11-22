import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { validateCodeAppFiles } from '../services/store/source.ts';
import type { LlmClient, LlmMessage } from './llm.ts';

/**
 * AI dapp generation (docs/HEADLESS.md, "AI dapp creation"): one model call
 * that returns a complete Code App file map, validated exactly like an
 * imported `.dapp` file before anything is written, with one repair round
 * when validation fails. Edits are stateless — the current source *is* the
 * context — so "make the header blue" after "add a search box" needs no chat
 * memory.
 */

export interface GeneratedDapp {
  name: string;
  icon: string;
  color: string;
  files: Record<string, string>;
}

export interface GenerateRequest {
  prompt: string;
  /** Present for edits: the dapp's current source and identity. */
  current?: { name: string; icon: string; color: string; files: Record<string, string> };
  /** Preferred identity for a new dapp (the model may still refine the name). */
  suggested?: { name?: string; icon?: string; color?: string };
}

export interface GeneratorOptions {
  llm: Pick<LlmClient, 'chat'>;
  /** The Code App SDK docs that become the system prompt (loaded lazily when given as a function). */
  docs: string | (() => Promise<string>);
  /** Repair rounds after a failed validation (default 1). */
  repairRounds?: number;
  log?: (line: string) => void;
}

const MAX_NAME = 60;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Loads `docs/code-apps/*.md` (shipped in the keeper image) as the system-prompt corpus. */
export async function loadCodeAppDocs(): Promise<string> {
  const dir = fileURLToPath(new URL('../../docs/code-apps/', import.meta.url));
  const parts: string[] = [];
  for (const name of ['README.md', 'AGENT-INSTRUCTIONS.md']) {
    parts.push(`# ${name}\n\n${await fs.readFile(`${dir}${name}`, 'utf8')}`);
  }
  return parts.join('\n\n---\n\n');
}

function systemPrompt(docs: string): string {
  return [
    'You build and edit "Code Apps" for the Dapp Builder platform: small local-first apps that run in a',
    'sandboxed iframe and store data through the injected `$store` API. The platform documentation follows;',
    'obey it exactly (no ES modules, no external scripts, no network unless the manifest grants it, `manifest.yaml`',
    'is YAML with `name`, `icon`, `color`, `routes`, `entities`).',
    '',
    'Answer with ONE JSON object and nothing else — no prose, no markdown fences:',
    '{ "name": string, "icon": string (one emoji), "color": "#rrggbb", "files": { "<path>": "<content>", ... } }',
    '`files` must be the COMPLETE file map of the app (every file, including unchanged ones) and must contain',
    '`index.html` and `manifest.yaml`. Keep apps framework-free, vanilla HTML/CSS/JS, accessible, and responsive.',
    'When editing an existing app keep entity ids and collection names stable unless the request demands a change,',
    'because existing records depend on them. Preserve all existing manifest permissions unless the user explicitly',
    'asks to remove one; in particular, never drop `permissions.device.camera: true` during an unrelated edit.',
    '',
    '=== PLATFORM DOCUMENTATION ===',
    docs,
  ].join('\n');
}

function userPrompt(request: GenerateRequest): string {
  if (request.current) {
    return [
      `Edit the existing app "${request.current.name}" (icon ${request.current.icon}, color ${request.current.color}).`,
      'Current source files as JSON:',
      JSON.stringify(request.current.files),
      '',
      'Requested change:',
      request.prompt,
    ].join('\n');
  }
  const hints = request.suggested
    ? Object.entries(request.suggested).filter(([, value]) => value).map(([key, value]) => `${key}: ${String(value)}`).join(', ')
    : '';
  return [
    'Create a new app.',
    hints ? `Preferred identity — ${hints}.` : '',
    '',
    'Description:',
    request.prompt,
  ].filter((line, index) => index !== 1 || line).join('\n');
}

/** Pulls the first top-level JSON object out of a model answer (tolerates fences and chatter). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('answer contains no JSON object');
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
}

/** Validates the model's answer into a GeneratedDapp or throws a message the model can act on. */
export function parseGeneratedDapp(raw: unknown, fallback: { name: string; icon: string; color: string }): GeneratedDapp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('answer is not a JSON object');
  const candidate = raw as Record<string, unknown>;
  const files = candidate.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('"files" must be an object mapping paths to contents');
  for (const [file, content] of Object.entries(files as Record<string, unknown>)) {
    if (typeof content !== 'string') throw new Error(`file "${file}" content must be a string`);
  }
  const normalized = validateCodeAppFiles(files as Record<string, string>);
  const manifest = parseCodeAppManifest(normalized['manifest.yaml'] ?? '');
  if (manifest.error) throw new Error(`manifest.yaml is invalid: ${manifest.error}`);

  const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim().slice(0, MAX_NAME) : manifest.manifest.name ?? fallback.name;
  const icon = typeof candidate.icon === 'string' && candidate.icon.trim() ? candidate.icon.trim().slice(0, 8) : manifest.manifest.icon ?? fallback.icon;
  const colorRaw = typeof candidate.color === 'string' ? candidate.color.trim() : manifest.manifest.color ?? fallback.color;
  const color = COLOR_PATTERN.test(colorRaw) ? colorRaw.toLowerCase() : fallback.color;
  return { name, icon, color, files: normalized };
}

function assertEditCapabilitiesPreserved(currentFiles: Record<string, string>, generated: GeneratedDapp): void {
  const current = parseCodeAppManifest(currentFiles['manifest.yaml'] ?? '');
  if (current.error) return;
  const next = parseCodeAppManifest(generated.files['manifest.yaml'] ?? '');
  if (current.manifest.permissions?.device?.camera && !next.manifest.permissions?.device?.camera) {
    throw new Error('manifest.yaml removed the existing permissions.device.camera: true capability; preserve it during edits');
  }
}

export class DappGenerator {
  private readonly options: GeneratorOptions;
  private docs: Promise<string> | null = null;

  constructor(options: GeneratorOptions) {
    this.options = options;
  }

  private loadDocs(): Promise<string> {
    const { docs } = this.options;
    this.docs ??= typeof docs === 'string' ? Promise.resolve(docs) : docs().catch((error: unknown) => {
      this.docs = null; // retry next time
      throw new Error(`Code App docs unavailable for the system prompt: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.docs;
  }

  async generate(request: GenerateRequest): Promise<GeneratedDapp> {
    const docs = await this.loadDocs();
    const fallback = {
      name: request.current?.name ?? request.suggested?.name ?? 'New app',
      icon: request.current?.icon ?? request.suggested?.icon ?? '🧩',
      color: request.current?.color ?? request.suggested?.color ?? '#0ea5e9',
    };
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(docs) },
      { role: 'user', content: userPrompt(request) },
    ];
    const rounds = 1 + (this.options.repairRounds ?? 1);
    let lastError = 'no answer';
    for (let round = 0; round < rounds; round += 1) {
      const answer = await this.options.llm.chat(messages, { json: true });
      this.options.log?.(`generator: round ${round + 1}, ${answer.content.length} chars from ${answer.model}`);
      try {
        const generated = parseGeneratedDapp(extractJsonObject(answer.content), fallback);
        if (request.current) assertEditCapabilitiesPreserved(request.current.files, generated);
        return generated;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.options.log?.(`generator: validation failed — ${lastError}`);
        messages.push(
          { role: 'assistant', content: answer.content },
          { role: 'user', content: `That answer failed validation: ${lastError}\nReturn the corrected COMPLETE JSON object (all files), nothing else.` },
        );
      }
    }
    throw new Error(`generated app failed validation: ${lastError}`);
  }
}
