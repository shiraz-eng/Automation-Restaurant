'use client';

import { useEffect, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type DiffStaffRow = { full_name: string; email: string | null; job_title: string; status: 'ready' | 'exists' | 'blocked'; issues: string[] };
type StaffImportDiff = { summary: { staff: number; ready: number; exists: number; blocked: number }; staff: DiffStaffRow[] };
type CreatedStaff = { full_name: string; job_title: string };
type ApplyResult = { created: CreatedStaff[]; skipped: string[] };

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-ok/15 text-ok',
  exists: 'bg-muted/15 text-muted',
  blocked: 'bg-danger/15 text-danger',
};

/**
 * The staff-domain twin of the other AI import panels. Each approved row
 * becomes a staff record (name + job as printed) — no login, no password,
 * no permissions; the same as the Staff page's Add staff form. People
 * already on the staff list are left alone.
 */
export function StaffImportPanel({
  slug,
  onClose,
  initialFile,
}: {
  slug: string;
  onClose: () => void;
  initialFile?: File;
}) {
  const supabase = usePortalSupabase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ranInitialFile = useRef(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'extracting' | 'review' | 'applying' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [diff, setDiff] = useState<StaffImportDiff | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function handleFile(file: File) {
    setError(null);
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.txt') && !lower.endsWith('.pdf')) {
      setError('Only CSV, plain text, or PDF files are supported right now.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 10 MB.');
      return;
    }
    setFilename(file.name);
    setStage('uploading');
    const path = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('ai-imports').upload(path, file, { contentType: file.type || 'text/plain' });
    if (upErr) {
      setError(upErr.message);
      setStage('idle');
      return;
    }
    setStage('extracting');
    try {
      const res = await fetch(`${API}/api/ai/staff-import`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, storagePath: path, filename: file.name }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not read this document.');
        setStage('idle');
        return;
      }
      setDraftId(body.draftId);
      setDiff(body.diff);
      setApproved(new Set((body.diff as StaffImportDiff).staff.flatMap((r, i) => (r.status === 'ready' ? [String(i)] : []))));
      setStage('review');
    } catch {
      setError('Network error.');
      setStage('idle');
    }
  }

  useEffect(() => {
    if (initialFile && !ranInitialFile.current) {
      ranInitialFile.current = true;
      handleFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(key: string) {
    setApproved((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function apply() {
    if (!draftId || approved.size === 0) return;
    setStage('applying');
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/staff-import/apply`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, draftId, approvedItemKeys: Array.from(approved) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Applying the import failed.');
        setStage('review');
        return;
      }
      setApplyResult(body.result);
      setStage('done');
    } catch {
      setError('Network error.');
      setStage('review');
    }
  }

  async function reject() {
    if (!draftId) return onClose();
    await fetch(`${API}/api/ai/staff-import/reject`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ slug, draftId }),
    }).catch(() => {});
    onClose();
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Import Staff from File</h2>
        <button onClick={onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {stage === 'idle' && (
        <div>
          <p className="text-xs text-muted mb-2">
            Upload a staff roster (CSV, text, or PDF) with each person&apos;s name and job. Everyone you approve is
            added to the staff list — no email or password needed. People already on the list are left untouched.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <button onClick={() => fileInputRef.current?.click()} className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs">
            Choose File…
          </button>
        </div>
      )}

      {(stage === 'uploading' || stage === 'extracting') && (
        <p className="text-xs text-muted">{stage === 'uploading' ? `Uploading ${filename}…` : 'Reading the document and extracting staff…'}</p>
      )}

      {(stage === 'review' || stage === 'applying') && diff && (
        <div className="space-y-3">
          <div className="text-xs">
            Found <strong>{diff.summary.staff}</strong> {diff.summary.staff === 1 ? 'person' : 'people'} —{' '}
            <span className="text-ok font-semibold">{diff.summary.ready} ready</span>,{' '}
            <span className="text-muted font-semibold">{diff.summary.exists} already exist</span>
            {diff.summary.blocked > 0 && <span className="text-danger font-semibold">, {diff.summary.blocked} blocked</span>}.
          </div>
          <div className="max-h-96 overflow-y-auto space-y-1 border border-border rounded p-2 bg-surface">
            {diff.staff.map((row, i) => {
              const key = String(i);
              return (
                <label key={i} className="flex items-start gap-2 text-xs py-1 border-b border-border/40 last:border-0">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={approved.has(key)}
                    disabled={row.status !== 'ready' || stage === 'applying'}
                    onChange={() => toggle(key)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold">{row.full_name}</span>
                      <span className="text-muted">{row.job_title || '—'}</span>
                      {row.email && <span className="text-muted">{row.email}</span>}
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                    </div>
                    {row.issues.length > 0 && <div className="text-[11px] text-danger">{row.issues.join(' · ')}</div>}
                  </div>
                </label>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button
              onClick={apply}
              disabled={approved.size === 0 || stage === 'applying'}
              className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {stage === 'applying' ? 'Adding…' : `Add ${approved.size} to staff`}
            </button>
            <button onClick={reject} disabled={stage === 'applying'} className="rounded border border-danger text-danger px-3 py-1.5 text-xs font-semibold">
              Reject All
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && applyResult && (
        <div className="space-y-2 text-xs">
          <p className="text-ok font-semibold">
            {applyResult.created.length} {applyResult.created.length === 1 ? 'person' : 'people'} added to staff.
          </p>
          {applyResult.created.length > 0 && (
            <div className="text-muted">{applyResult.created.map((c) => `${c.full_name} (${c.job_title})`).join(', ')}</div>
          )}
          {applyResult.skipped.length > 0 && <div className="text-muted">Skipped: {applyResult.skipped.join(', ')}</div>}
          <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-xs font-semibold mt-1">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
