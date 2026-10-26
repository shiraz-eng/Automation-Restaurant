'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { aiLanguage } from '@automation-restaurant/shared';

/**
 * Voice for the AI features, using what the browser offers:
 *   • speech to text — the browser's own recogniser (Chrome, Edge, Safari)
 *     or, where there isn't one or it fails, a short recording sent to the
 *     API's transcriber (POST /api/ai/transcribe, portal only);
 *   • text to speech — the device's installed voices (speechSynthesis).
 * Nothing here is loaded until a chat panel uses it.
 */

// ── Speech to text ───────────────────────────────────────────────────────────

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function canRecord(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

const RECORD_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
const MAX_RECORDING_MS = 60_000;

export type ServerTranscriber = (audio: Blob, mimeType: string, language: string) => Promise<{ text: string; language?: string | null }>;

export type SpeechInputState = 'idle' | 'listening' | 'processing' | 'error';

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** POSTs a recording to the API transcriber with the portal session token. */
export function apiTranscriber(api: string, slug: string, module: string, getToken: () => Promise<string | null>): ServerTranscriber {
  return async (audio, mimeType, language) => {
    const token = await getToken();
    if (!token) throw new Error('Sign in again to use voice input.');
    const res = await fetch(`${api}/api/ai/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ slug, module, mimeType, language, audioBase64: await blobToBase64(audio) }),
    });
    const j = (await res.json().catch(() => ({}))) as { text?: string; language?: string | null; message?: string };
    if (!res.ok || !j.text) throw new Error(j.message ?? 'The recording could not be transcribed.');
    return { text: j.text, language: j.language ?? null };
  };
}

const RECOGNITION_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.',
  'service-not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.',
  'no-speech': "I didn't hear anything — tap the microphone and speak again.",
  'audio-capture': 'No microphone was found. Connect one, or type your question.',
  network: 'Speech recognition needs a connection that is not available right now.',
  'language-not-supported': "This browser can't recognise that language.",
};

/**
 * One microphone button's worth of state. `language` is the language code
 * (packages/shared AI_LANGUAGES) being spoken; `onText` receives the final
 * transcript, which the caller puts in the input box for the person to check
 * before sending — speech is never sent, let alone acted on, by itself.
 */
export function useSpeechInput(opts: {
  language: string;
  onText: (text: string, language?: string | null) => void;
  server?: ServerTranscriber | null;
  preferServer?: boolean;
}) {
  const { language, onText, server, preferServer } = opts;
  const [state, setState] = useState<SpeechInputState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState('');
  const [via, setVia] = useState<'browser' | 'server' | null>(null);
  const recRef = useRef<RecognitionLike | null>(null);
  const mediaRef = useRef<{ rec: MediaRecorder; stream: MediaStream; cancelled: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  // After the browser recogniser fails for lack of a service or language, use the server.
  const browserFailed = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const [hasRecognition, setHasRecognition] = useState(false);
  const [hasRecorder, setHasRecorder] = useState(false);
  useEffect(() => {
    setHasRecognition(!!recognitionCtor());
    setHasRecorder(canRecord());
  }, []);
  const supported = hasRecognition || (hasRecorder && !!server);

  const cleanupMedia = () => {
    const m = mediaRef.current;
    if (!m) return;
    clearTimeout(m.timer);
    m.stream.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
  };

  const startServer = useCallback(async () => {
    if (!server) return;
    setVia('server');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as DOMException).name;
      setState('error');
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Connect one, or type your question.'
            : 'The microphone could not be started.',
      );
      return;
    }
    const mimeType = RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const entry = { rec, stream, cancelled: false, timer: setTimeout(() => rec.state !== 'inactive' && rec.stop(), MAX_RECORDING_MS) };
    mediaRef.current = entry;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      const cancelled = entry.cancelled;
      cleanupMedia();
      if (cancelled) return setState('idle');
      const type = (rec.mimeType || mimeType || 'audio/webm').split(';')[0]!;
      const blob = new Blob(chunks, { type });
      if (blob.size < 800) {
        setState('error');
        setError("That was too short to hear — hold the microphone a little longer.");
        return;
      }
      setState('processing');
      try {
        const out = await server(blob, type, language);
        setState('idle');
        onTextRef.current(out.text, out.language);
      } catch (err) {
        setState('error');
        setError((err as Error).message || 'The recording could not be transcribed.');
      }
    };
    rec.start();
    setState('listening');
  }, [server, language]);

  const startBrowser = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return false;
    const rec = new Ctor();
    recRef.current = rec;
    setVia('browser');
    rec.lang = aiLanguage(language)?.stt ?? language;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = '';
    let failed: string | null = null;
    rec.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) finalText += r[0].transcript;
        else live += r[0].transcript;
      }
      setInterim((finalText + live).trim());
    };
    rec.onerror = (e) => {
      failed = e.error;
    };
    rec.onend = () => {
      recRef.current = null;
      setInterim('');
      if (failed === 'aborted') return setState('idle');
      if (failed) {
        // A recogniser with no service or no support for this language: the
        // server can still do it, so switch over and tell the person to retry.
        if ((failed === 'network' || failed === 'language-not-supported' || failed === 'service-not-allowed') && server && canRecord()) {
          browserFailed.current = true;
        }
        setState('error');
        setError(
          RECOGNITION_ERRORS[failed] && browserFailed.current
            ? `${RECOGNITION_ERRORS[failed]} Tap the microphone again to use the server instead.`
            : (RECOGNITION_ERRORS[failed] ?? 'Speech recognition stopped unexpectedly — try again.'),
        );
        return;
      }
      const text = finalText.trim();
      if (!text) {
        setState('error');
        setError(RECOGNITION_ERRORS['no-speech']!);
        return;
      }
      setState('idle');
      onTextRef.current(text, null);
    };
    try {
      rec.start();
      setState('listening');
      return true;
    } catch {
      recRef.current = null;
      return false;
    }
  }, [language, server]);

  const start = useCallback(() => {
    setError(null);
    setInterim('');
    const useServer = !!server && hasRecorder && (preferServer || browserFailed.current || !hasRecognition);
    if (useServer) return void startServer();
    if (!startBrowser()) {
      if (server && hasRecorder) void startServer();
      else {
        setState('error');
        setError("Voice input isn't available in this browser — type your question instead.");
      }
    }
  }, [server, hasRecorder, hasRecognition, preferServer, startServer, startBrowser]);

  /** Finish listening and use what was said. */
  const stop = useCallback(() => {
    if (recRef.current) recRef.current.stop();
    else if (mediaRef.current && mediaRef.current.rec.state !== 'inactive') mediaRef.current.rec.stop();
  }, []);

  /** Throw away what was said. */
  const cancel = useCallback(() => {
    if (recRef.current) recRef.current.abort();
    if (mediaRef.current) {
      mediaRef.current.cancelled = true;
      if (mediaRef.current.rec.state !== 'inactive') mediaRef.current.rec.stop();
      else cleanupMedia();
    }
    setInterim('');
    setError(null);
    setState('idle');
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
    setState('idle');
  }, []);

  useEffect(
    () => () => {
      recRef.current?.abort();
      if (mediaRef.current) {
        mediaRef.current.cancelled = true;
        cleanupMedia();
      }
    },
    [],
  );

  return { supported, state, error, interim, via, start, stop, cancel, dismissError };
}

// ── Text to speech ───────────────────────────────────────────────────────────

/** Markdown and chat markers removed, so the voice reads words, not symbols. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/\[\[SUGGEST\]\][^\n]*/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentences grouped into chunks the engines read reliably (Chrome stops long utterances). */
function chunks(text: string, max = 220): string[] {
  const parts = text.match(/[^.!?؟।\n]+[.!?؟।]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur.trim());
      cur = '';
    }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max).trim());
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

type SpeechSnapshot = { id: string | null; paused: boolean };
let snapshot: SpeechSnapshot = { id: null, paused: false };
const speechListeners = new Set<() => void>();
function setSnapshot(s: SpeechSnapshot) {
  snapshot = s;
  speechListeners.forEach((l) => l());
}
let generation = 0;

function voicesStore() {
  let voices: SpeechSynthesisVoice[] = [];
  const subs = new Set<() => void>();
  const load = () => {
    voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
    subs.forEach((l) => l());
  };
  let watching = false;
  return {
    subscribe(l: () => void) {
      subs.add(l);
      if (typeof speechSynthesis !== 'undefined' && !watching) {
        watching = true;
        // Voices load asynchronously (and change when one is installed); listen once for the page.
        speechSynthesis.addEventListener?.('voiceschanged', load);
        load();
      }
      return () => {
        subs.delete(l);
      };
    },
    get: () => voices,
  };
}
const voiceStore = voicesStore();
const NO_VOICES: SpeechSynthesisVoice[] = [];

export function useVoices(): SpeechSynthesisVoice[] {
  return useSyncExternalStore(voiceStore.subscribe, voiceStore.get, () => NO_VOICES);
}

/** Voices for a language code; best (local, exact region) first. */
export function voicesFor(voices: SpeechSynthesisVoice[], code: string): SpeechSynthesisVoice[] {
  const tag = (aiLanguage(code)?.tts ?? code).toLowerCase();
  const base = tag.split('-')[0]!;
  return voices
    .filter((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === base)
    .sort((a, b) => Number(b.lang.toLowerCase().replace('_', '-') === tag) - Number(a.lang.toLowerCase().replace('_', '-') === tag) || Number(b.localService) - Number(a.localService));
}

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/**
 * Reads `text` aloud as `id` (a message id), stopping anything already
 * playing. Resolves false (without speaking) when the device has no voice
 * for the language, so the caller can say so — the text stays on screen.
 */
export function speak(id: string, text: string, code: string, opts: { voiceName?: string | null; rate?: number } = {}): 'ok' | 'no_voice' | 'unsupported' {
  if (!ttsSupported()) return 'unsupported';
  const all = speechSynthesis.getVoices();
  const matching = voicesFor(all, code);
  const voice = matching.find((v) => v.name === opts.voiceName) ?? matching[0];
  // Some browsers report no voices until first use; let them try with the language tag alone.
  if (!voice && all.length > 0) return 'no_voice';
  speechSynthesis.cancel();
  const gen = ++generation;
  const parts = chunks(stripForSpeech(text));
  if (!parts.length) return 'ok';
  setSnapshot({ id, paused: false });
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? aiLanguage(code)?.tts ?? code;
    u.rate = opts.rate ?? 1;
    if (i === parts.length - 1) {
      u.onend = () => gen === generation && setSnapshot({ id: null, paused: false });
    }
    u.onerror = (e) => {
      if (gen === generation && e.error !== 'interrupted' && e.error !== 'canceled') setSnapshot({ id: null, paused: false });
    };
    speechSynthesis.speak(u);
  });
  return 'ok';
}

export function pauseSpeech() {
  if (!ttsSupported() || !snapshot.id) return;
  speechSynthesis.pause();
  setSnapshot({ ...snapshot, paused: true });
}
export function resumeSpeech() {
  if (!ttsSupported() || !snapshot.id) return;
  speechSynthesis.resume();
  setSnapshot({ ...snapshot, paused: false });
}
export function stopSpeech() {
  if (!ttsSupported()) return;
  generation++;
  speechSynthesis.cancel();
  setSnapshot({ id: null, paused: false });
}

/** What is playing now (one answer at a time across the whole page). */
export function useSpeechState(): SpeechSnapshot {
  return useSyncExternalStore(
    (l) => {
      speechListeners.add(l);
      return () => speechListeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}
