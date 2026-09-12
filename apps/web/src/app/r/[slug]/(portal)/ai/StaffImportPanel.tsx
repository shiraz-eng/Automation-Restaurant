'use client';

import { useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type DiffStaffRow = { full_name: string | null; email: string; role_raw: string; matched_role: string | null; status: 'ready' | 'exists' | 'blocked'; issues: string[] };
type StaffImportDiff = { summary: { staff: number; ready: number; exists: number; blocked: number }; staff: DiffStaffRow[] };
type CreatedStaff = { email: string; full_name: string | null; role: string; temp_password: string };
type ApplyResult = { created: CreatedStaff[]; skipped: string[] };

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-ok/15 text-ok',
  exists: 'bg-muted/15 text-muted',
  blocked: 'bg-danger/15 text-danger',
};

/**
 * The staff-domain twin of the other AI import panels — the one that
 * creates real login accounts, so the review step matters more than
 * anywhere else. Only "ready" rows (a recognized role you yourself have
 * permission to grant, and an email that doesn't already exist) can be
 * approved. Each new account's temporary password is shown here ONCE,
 * right after creation — copy it down now, it is never shown again.
 */
export function StaffImportPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const supabase = usePortalSupabase();
  const fileInputRef = useRef<HTMLInputElement>(null);
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
      // Nothing is pre-checked here — creating a login account is
      // deliberately never a default-on action, unlike every other domain.
      setApproved(new Set());
      setStage('review');
    } catch {
      setError('Network error.');
      setStage('idle');
    }
  }

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
            Upload a staff roster (CSV, text, or PDF): name, email, role. This creates a real login for each
            approved person — review carefully. You can only approve a role you yourself have permission to grant,
            and an email that already exists is left untouched.
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
                      <span className="font-semibold">{row.full_name ?? row.email}</span>
                      <span className="text-muted">{row.email}</span>
                      <span className="text-muted">{row.matched_role ?? row.role_raw}</span>
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
              {stage === 'applying' ? 'Creating…' : `Create ${approved.size} Account(s)`}
            </button>
            <button onClick={reject} disabled={stage === 'applying'} className="rounded border border-danger text-danger px-3 py-1.5 text-xs font-semibold">
              Reject All
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && applyResult && (
        <div className="space-y-2 text-xs">
          <p className="text-ok font-semibold">{applyResult.created.length} account(s) created.</p>
          {applyResult.created.length > 0 && (
            <div className="rounded border border-primary/40 bg-surface p-2 space-y-1">
              <p className="font-bold text-primary">Temporary passwords — shown once, copy these down now:</p>
              {applyResult.created.map((c, i) => (
                <div key={i} className="font-mono">
                  {c.email} ({c.role}): <span className="font-bold">{c.temp_password}</span>
                </div>
              ))}
            </div>
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
