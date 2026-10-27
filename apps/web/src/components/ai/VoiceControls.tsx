'use client';

import { useEffect, useId, useState } from 'react';
import { Loader2, Mic, Pause, Play, RotateCcw, Square, Volume2, X } from 'lucide-react';
import { AI_LANGUAGES, aiLanguage, type AiLanguageChoice } from '@automation-restaurant/shared';
import {
  pauseSpeech,
  resumeSpeech,
  speakAnswer,
  stopSpeech,
  ttsSupported,
  useSpeechState,
  useVoices,
  voicesFor,
  type useSpeechInput,
} from '@/lib/ai/speech';
import type { AiVoice } from '@/lib/ai/useAiVoice';

type Mic = ReturnType<typeof useSpeechInput>;

const iconBtn =
  'grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border text-body hover:bg-main disabled:opacity-40 transition-colors';

/** The microphone: tap to talk, tap again to finish. The words go into the box to check before sending. */
const langName = (code: string) => (code === 'auto' ? 'any language' : (aiLanguage(code)?.name ?? code));

export function MicButton({ mic, language, disabled }: { mic: Mic; language: string; disabled?: boolean }) {
  const name = langName(language);
  if (mic.state === 'listening') {
    return (
      <button
        type="button"
        onClick={mic.stop}
        aria-pressed="true"
        aria-label="Finish speaking and put the words in the message box"
        title="Finish speaking"
        className={`${iconBtn} border-danger/60 bg-danger/10 text-danger motion-safe:animate-pulse`}
      >
        <Square size={13} aria-hidden />
      </button>
    );
  }
  if (mic.state === 'processing') {
    return (
      <button type="button" disabled aria-label="Turning your recording into text" className={iconBtn}>
        <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={mic.start}
      disabled={disabled}
      aria-pressed="false"
      aria-label={`Speak your question (${name})`}
      title={`Speak (${name})`}
      className={iconBtn}
    >
      <Mic size={14} aria-hidden />
    </button>
  );
}

/** What the microphone is doing, announced to screen readers; Cancel and Retry live here. */
export function VoiceStatus({ mic, language }: { mic: Mic; language: string }) {
  const name = langName(language);
  if (mic.state === 'idle') return <div role="status" aria-live="polite" className="sr-only" />;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-2 flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[0.75rem] ${
        mic.state === 'error' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-border bg-main text-body'
      }`}
    >
      {mic.state === 'listening' && (
        <>
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden />
          <span className="min-w-0 flex-1" dir="auto">
            <strong>Listening ({name}{mic.via === 'server' ? ', recording' : ''})…</strong>{' '}
            {mic.interim ? <span className="text-muted">{mic.interim}</span> : <span className="text-muted">speak now, then tap ■ to finish.</span>}
          </span>
          <button type="button" onClick={mic.cancel} className="shrink-0 rounded px-1.5 py-0.5 font-semibold underline underline-offset-2 hover:bg-surface">
            Cancel
          </button>
        </>
      )}
      {mic.state === 'processing' && (
        <>
          <Loader2 size={13} className="mt-0.5 shrink-0 motion-safe:animate-spin" aria-hidden />
          <span className="min-w-0 flex-1">Turning your recording into text…</span>
          <button type="button" onClick={mic.cancel} className="shrink-0 rounded px-1.5 py-0.5 font-semibold underline underline-offset-2 hover:bg-surface">
            Cancel
          </button>
        </>
      )}
      {mic.state === 'error' && (
        <>
          <span className="min-w-0 flex-1">
            <strong>Voice input: </strong>
            {mic.error}
          </span>
          <button type="button" onClick={mic.start} className="shrink-0 rounded px-1.5 py-0.5 font-semibold underline underline-offset-2 hover:bg-surface">
            Retry
          </button>
          <button type="button" onClick={mic.dismissError} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-surface">
            <X size={13} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}

/** Read-aloud controls for one answer: Listen / Pause / Resume / Stop / Replay. The text stays on screen. */
export function SpeakControls({ id, text, language, voice }: { id: string; text: string; language: string; voice: Pick<AiVoice, 'voiceName' | 'rate' | 'speaker' | 'prefs'> }) {
  const snap = useSpeechState();
  const [note, setNote] = useState<string | null>(null);
  const [played, setPlayed] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  useEffect(() => setCanSpeak(ttsSupported() || !!voice.speaker), [voice.speaker]);
  if (!canSpeak) return null;
  const mine = snap.id === id;
  const name = aiLanguage(language)?.name ?? language;
  const play = async () => {
    setPlayed(true);
    setNote(null);
    const r = await speakAnswer(id, text, language, { voiceName: voice.voiceName, rate: voice.rate, speaker: voice.speaker, preferAiVoice: voice.prefs.aiVoice });
    setNote(
      r === 'no_voice' || r === 'unsupported'
        ? `This device has no ${name} voice, so the answer can't be read aloud here — it's all in the text above.`
        : r === 'error'
          ? 'The answer could not be read aloud right now — it is all in the text above.'
          : null,
    );
  };
  const btn = 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.6875rem] font-semibold text-muted hover:bg-surface hover:text-body';
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5">
      {!mine ? (
        <button type="button" onClick={play} className={btn} aria-label={played ? 'Read this answer aloud again' : `Read this answer aloud (${name})`}>
          {played ? <RotateCcw size={12} aria-hidden /> : <Volume2 size={12} aria-hidden />}
          {played ? 'Replay' : 'Listen'}
        </button>
      ) : (
        <>
          {snap.loading ? (
            <span className={`${btn} cursor-default`} role="status">
              <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden /> Preparing voice…
            </span>
          ) : snap.paused ? (
            <button type="button" onClick={resumeSpeech} className={btn} aria-label="Resume reading">
              <Play size={12} aria-hidden /> Resume
            </button>
          ) : (
            <button type="button" onClick={pauseSpeech} className={btn} aria-label="Pause reading">
              <Pause size={12} aria-hidden /> Pause
            </button>
          )}
          <button type="button" onClick={stopSpeech} className={btn} aria-label="Stop reading">
            <Square size={11} aria-hidden /> Stop
          </button>
          <span className="sr-only" role="status">
            {snap.paused ? 'Paused' : 'Reading the answer aloud'}
          </span>
        </>
      )}
      {note && (
        <span role="status" className="basis-full text-[0.6875rem] text-muted">
          {note}
        </span>
      )}
    </span>
  );
}

export function LanguageSelect({
  value,
  onChange,
  autoLabel,
  label,
  id,
  className = '',
}: {
  value: AiLanguageChoice;
  onChange: (v: AiLanguageChoice) => void;
  autoLabel: string;
  label: string;
  id?: string;
  className?: string;
}) {
  const fallbackId = useId();
  const sid = id ?? fallbackId;
  return (
    <div className={className}>
      <label htmlFor={sid} className="block text-[0.6875rem] font-semibold text-muted">
        {label}
      </label>
      <select
        id={sid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[0.75rem] text-body outline-none focus:border-primary"
      >
        <option value="auto">{autoLabel}</option>
        {AI_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.native === l.name ? l.name : `${l.name} — ${l.native}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--primary))]"
      />
      <label htmlFor={id} className={`text-[0.75rem] leading-snug ${disabled ? 'text-muted' : 'text-body'}`}>
        <span className="font-semibold">{label}</span>
        {hint && (
          <span id={`${id}-hint`} className="block text-[0.6875rem] text-muted">
            {hint}
          </span>
        )}
      </label>
    </div>
  );
}

/**
 * This device's language and voice choices for the AI (AI Guide, Assistant).
 * What the restaurant switched off for this module is shown, not hidden,
 * so nobody hunts for a microphone that isn't allowed here.
 */
export function AiVoiceSettings({ voice, answerLanguage, onClose }: { voice: AiVoice; answerLanguage: string; onClose?: () => void }) {
  const { prefs, setPrefs, settings } = voice;
  const voices = useVoices();
  const forLang = voicesFor(voices, answerLanguage);
  const langName = aiLanguage(answerLanguage)?.name ?? answerLanguage;
  const moduleAnswer = settings.responseLanguage !== 'auto' ? aiLanguage(settings.responseLanguage)?.name : null;
  const moduleInput = settings.inputLanguage !== 'auto' ? aiLanguage(settings.inputLanguage)?.name : null;
  return (
    <section aria-labelledby="ai-voice-settings-title" className="space-y-3 rounded-xl border border-border bg-surface p-3 text-body">
      <div className="flex items-center justify-between gap-2">
        <h2 id="ai-voice-settings-title" className="text-[0.8125rem] font-bold">
          Language &amp; voice
        </h2>
        {onClose && (
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-[0.75rem] font-semibold hover:bg-main">
            Done
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <LanguageSelect
          label="Answer in"
          value={prefs.responseLanguage}
          onChange={(v) => setPrefs({ responseLanguage: v })}
          autoLabel={moduleAnswer ? `Restaurant default (${moduleAnswer})` : settings.autoDetect ? 'Automatic — the language I use' : 'Automatic'}
        />
        <LanguageSelect
          label="I speak in"
          value={prefs.inputLanguage}
          onChange={(v) => setPrefs({ inputLanguage: v })}
          autoLabel={
            moduleInput
              ? `Restaurant default (${moduleInput})`
              : voice.micAuto
                ? 'Automatic — any language'
                : `Automatic (${aiLanguage(voice.micLanguage)?.name ?? 'browser language'})`
          }
        />
      </div>
      <div className="space-y-2">
        <Toggle
          label="Voice input"
          hint={voice.micBlockedByAdmin ? 'Switched off for this module in the restaurant’s AI settings.' : 'Show the microphone button.'}
          checked={prefs.voiceInput && !voice.micBlockedByAdmin}
          disabled={voice.micBlockedByAdmin}
          onChange={(v) => setPrefs({ voiceInput: v })}
        />
        <Toggle
          label="Spoken answers"
          hint={voice.speakBlockedByAdmin ? 'Switched off for this module in the restaurant’s AI settings.' : 'Show Listen / Pause / Stop on each answer.'}
          checked={prefs.voiceOutput && !voice.speakBlockedByAdmin}
          disabled={voice.speakBlockedByAdmin}
          onChange={(v) => setPrefs({ voiceOutput: v })}
        />
        <Toggle
          label="Read new answers aloud automatically"
          checked={prefs.autoSpeak}
          disabled={!voice.speakEnabled}
          onChange={(v) => setPrefs({ autoSpeak: v })}
        />
        {voice.speaker && (
          <Toggle
            label="AI voice for every language"
            hint="Read answers with the AI voice even when this device has its own voice. Without a device voice (for example Urdu), the AI voice is used anyway."
            checked={prefs.aiVoice}
            disabled={!voice.speakEnabled}
            onChange={(v) => setPrefs({ aiVoice: v })}
          />
        )}
        {voice.server && !voice.micAuto && (
          <Toggle
            label="Use the server for speech recognition"
            hint="Try this if the microphone doesn't understand you or your browser has no speech recognition."
            checked={prefs.serverSpeech}
            onChange={(v) => setPrefs({ serverSpeech: v })}
          />
        )}
      </div>
      {voice.speakEnabled && ttsSupported() && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="ai-voice-name" className="block text-[0.6875rem] font-semibold text-muted">
              Voice for {langName}
            </label>
            <select
              id="ai-voice-name"
              value={forLang.some((v) => v.name === prefs.voiceName) ? (prefs.voiceName as string) : ''}
              onChange={(e) => setPrefs({ voiceName: e.target.value || null })}
              disabled={forLang.length === 0}
              className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[0.75rem] outline-none focus:border-primary disabled:opacity-60"
            >
              <option value="">{forLang.length ? 'Best available' : `No ${langName} voice on this device`}</option>
              {forLang.map((v) => (
                <option key={v.voiceURI} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ai-voice-rate" className="block text-[0.6875rem] font-semibold text-muted">
              Speaking speed: {prefs.rate.toFixed(1)}×
            </label>
            <input
              id="ai-voice-rate"
              type="range"
              min={0.7}
              max={1.4}
              step={0.1}
              value={prefs.rate}
              onChange={(e) => setPrefs({ rate: Number(e.target.value) })}
              className="mt-2 w-full accent-[rgb(var(--primary))]"
            />
          </div>
        </div>
      )}
      <p className="text-[0.6875rem] text-muted">Saved on this device. Answers are always shown as text too.</p>
    </section>
  );
}
