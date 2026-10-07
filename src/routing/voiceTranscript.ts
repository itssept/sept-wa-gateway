/**
 * Gateway-side voice-note grounding.
 *
 * Live 2026-10-07 ~11:31 Rome: a WhatsApp voice note was uploaded as audio.
 * PromptQL then called an external speech API ("Transcribe voice note"),
 * which waits on a PromptQL approval the operator cannot grant by typing
 * in WhatsApp. The approval expired and nothing was transcribed.
 *
 * The audio file is what causes that tool call. This module turns the bytes
 * into text before ask_promptql and does not upload them. An optional
 * OpenAI-compatible endpoint (GATEWAY_VOICE_STT_URL) supplies the words.
 * When it is unset or fails, the turn is still text — the agent is not
 * handed audio to transcribe, and a voice-only shopper/PA turn is answered
 * by the gateway instead of a blocked approval.
 */

import type { Logger } from "../logger.ts";
import type { PromptQlFileInput } from "../promptql/promptqlAdapter.ts";
import { z } from "zod";

/** Spoken words are already in the message. Do not name a tool to call. */
export const VOICE_TURN_CONTRACT =
  "THIS TURN INCLUDES A WHATSAPP VOICE NOTE. Any spoken words are already written in the message; the audio was not uploaded. Do not call speech-to-text, an external HTTP API, or a platform approval flow. Do not ask anyone to react, click an approval link, or type an approval. Do not claim that background approvals, platform permissions, or PromptQL settings were changed. If the message says the voice note could not be transcribed, say that and nothing else about transcription.";

/** Context posted when the gateway has no transcript. Not a request to transcribe. */
export const VOICE_UNAVAILABLE_QUERY =
  "A voice note was received. It could not be transcribed in this chat.";

/** WhatsApp line for a voice-only turn the gateway could not transcribe. */
export const VOICE_UNAVAILABLE_NOTICE =
  "I couldn't transcribe that voice note in this chat. Please type it and I'll take it from there.";

const TRANSCRIPT_MAX_CHARS = 8_000;

const SpeechResponseSchema = z.object({
  text: z.string().optional(),
  transcript: z.string().optional(),
}).passthrough();

export interface VoiceTranscriptRequest {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

export interface VoiceTranscriber {
  transcribe(input: VoiceTranscriptRequest): Promise<string | null>;
}

export interface VoiceGroundingMessage {
  msgType: string;
  mediaStatus: string;
  media: { mime?: string } | null;
}

export interface VoiceGrounding {
  query: string;
  files: PromptQlFileInput[];
  /** The turn included at least one audio / voice-note message or audio file. */
  voice: boolean;
  /** At least one voice note produced text. */
  transcriptReady: boolean;
  /** Every message in the turn was audio. A failed transcript must not start a run. */
  voiceOnly: boolean;
}

export function withVoiceTurnContract(
  systemInstruction: string | undefined,
  voice: boolean,
): string | undefined {
  if (!voice) return systemInstruction;
  const base = systemInstruction?.trim() ?? "";
  if (base.includes("THIS TURN INCLUDES A WHATSAPP VOICE NOTE.")) return base;
  return base ? `${base}\n\n${VOICE_TURN_CONTRACT}` : VOICE_TURN_CONTRACT;
}

/**
 * Replace voice-note placeholders with the transcript block. Shopper text
 * that was actually typed stays. The audio bytes never enter the query.
 */
export function mergeVoiceQuery(query: string, block: string): string {
  let seen = false;
  const replaced = query.replace(/\(voice note\)|\(audio\)/g, () => {
    if (seen) return "";
    seen = true;
    return block;
  });
  const cleaned = replaced.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (seen) return cleaned;
  const base = query.trim();
  return base ? `${base}\n\n${block}` : block;
}

export function formatVoiceBlock(transcripts: Array<string | null>): string {
  if (transcripts.length === 0) return VOICE_UNAVAILABLE_QUERY;
  return transcripts.map((transcript, index) => {
    const body = transcript?.trim()
      ? transcript.trim().slice(0, TRANSCRIPT_MAX_CHARS)
      : VOICE_UNAVAILABLE_QUERY;
    return transcripts.length > 1 ? `(${index + 1}) ${body}` : body;
  }).join("\n\n");
}

function audioMime(mime: string | null | undefined): boolean {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase().startsWith("audio/");
}

export function isAudioFile(file: PromptQlFileInput): boolean {
  return audioMime(file.mime_type);
}

function isAudioMessage(msg: VoiceGroundingMessage): boolean {
  if (msg.msgType === "audio") return true;
  return audioMime(msg.media?.mime);
}

/**
 * Drop audio files and ground the ask in text. Transcription failures become
 * an unavailable line; they never reattach the bytes.
 */
export async function groundVoiceTurn(input: {
  messages: readonly VoiceGroundingMessage[];
  files: readonly PromptQlFileInput[];
  query: string;
  transcribe: (request: VoiceTranscriptRequest) => Promise<string | null>;
  log?: Logger;
}): Promise<VoiceGrounding> {
  const transcripts: Array<string | null> = [];
  const kept: PromptQlFileInput[] = [];
  let fileIdx = 0;
  let voice = false;

  const takeTranscript = async (file: PromptQlFileInput): Promise<void> => {
    voice = true;
    try {
      const bytes = Buffer.from(file.content_base64, "base64");
      const text = (await input.transcribe({
        bytes,
        mimeType: file.mime_type,
        fileName: file.file_name,
      }))?.replace(/\s+/g, " ").trim() || null;
      transcripts.push(text ? text.slice(0, TRANSCRIPT_MAX_CHARS) : null);
    } catch (err) {
      input.log?.warn("voice transcription failed", { err });
      transcripts.push(null);
    }
  };

  for (const msg of input.messages) {
    const ready = msg.mediaStatus === "ready" && msg.media;
    const file = ready ? input.files[fileIdx++] : undefined;
    const audio = isAudioMessage(msg) || (file ? isAudioFile(file) : false);
    if (!audio) {
      if (file) kept.push(file);
      continue;
    }
    voice = true;
    if (file && isAudioFile(file)) await takeTranscript(file);
    else transcripts.push(null);
  }
  while (fileIdx < input.files.length) {
    const file = input.files[fileIdx++]!;
    if (isAudioFile(file)) await takeTranscript(file);
    else kept.push(file);
  }

  const voiceOnly = input.messages.length > 0 && input.messages.every(isAudioMessage);
  if (!voice) {
    return {
      query: input.query,
      files: input.files.slice(),
      voice: false,
      transcriptReady: false,
      voiceOnly: false,
    };
  }

  const transcriptReady = transcripts.some((item) => Boolean(item?.trim()));
  input.log?.info("voice note grounded", {
    voiceNotes: transcripts.length,
    transcribed: transcripts.filter((item) => Boolean(item?.trim())).length,
    textLength: transcripts.reduce((sum, item) => sum + (item?.length ?? 0), 0),
    audioDropped: true,
  });
  return {
    query: mergeVoiceQuery(input.query, formatVoiceBlock(transcripts)),
    files: kept,
    voice: true,
    transcriptReady,
    voiceOnly,
  };
}

export interface VoiceSttOptions {
  url: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  /** Narrower than global fetch so tests can stub the POST without the rest of the runtime. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  log?: Logger;
}

/**
 * OpenAI-compatible `POST {url}` with multipart `file` + `model`.
 * An empty URL transcribes nothing (the caller still withholds the audio).
 * The response body and the API key are never logged.
 */
export function createVoiceTranscriber(opts: VoiceSttOptions): VoiceTranscriber {
  const url = opts.url.trim();
  if (!url) return { transcribe: async () => null };
  return {
    async transcribe(request) {
      try {
        return await postSpeech(opts, url, request);
      } catch (err) {
        opts.log?.warn("voice transcription failed", { err });
        return null;
      }
    },
  };
}

async function postSpeech(
  opts: VoiceSttOptions,
  url: string,
  request: VoiceTranscriptRequest,
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const form = new FormData();
  const mime = request.mimeType.split(";")[0]!.trim() || "application/octet-stream";
  form.append(
    "file",
    new Blob([new Uint8Array(request.bytes)], { type: mime }),
    request.fileName || "voice.ogg",
  );
  form.append("model", opts.model);
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!response.ok) {
    opts.log?.warn("voice transcription failed", { status: response.status });
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    opts.log?.warn("voice transcription failed", { err });
    return null;
  }
  const parsed = SpeechResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  const text = (parsed.data.text ?? parsed.data.transcript ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, TRANSCRIPT_MAX_CHARS) : null;
}
