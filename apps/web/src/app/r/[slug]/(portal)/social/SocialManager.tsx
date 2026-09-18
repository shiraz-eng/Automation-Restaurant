'use client';

import { useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Account = { id: string; platform: string; account_name: string | null; account_id: string; status: string; connected_at: string };
type Post = {
  id: string;
  platform: string;
  caption: string;
  media_url: string | null;
  related_type: string | null;
  related_id: string | null;
  status: 'draft' | 'approved' | 'rejected' | 'published' | 'failed';
  proposed_by_role: string | null;
  published_at: string | null;
  external_post_id: string | null;
  error: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<Post['status'], string> = {
  draft: 'Draft',
  approved: 'Approved',
  rejected: 'Rejected',
  published: 'Published',
  failed: 'Failed',
};
const STATUS_TONE: Record<Post['status'], string> = {
  draft: 'text-muted',
  approved: 'text-ok',
  rejected: 'text-muted',
  published: 'text-ok',
  failed: 'text-danger',
};

export function SocialManager({
  slug,
  canManage,
  canPropose,
  canApprove,
}: {
  slug: string;
  canManage: boolean;
  canPropose: boolean;
  canApprove: boolean;
}) {
  const supabase = usePortalSupabase();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; caption: string; media_url: string } | null>(null);
  // Read directly from the URL rather than next/navigation's
  // useSearchParams(), which needs a <Suspense> boundary around any page
  // that uses it — this is the one-time redirect banner from the OAuth
  // callback (routes/social.ts), not something that needs to react to
  // later client-side navigation.
  const [banner, setBanner] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    setBanner(qs.get('social'));
    setBannerMessage(qs.get('message'));
  }, []);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const headers = await authHeader();
      const [statusRes, postsRes] = await Promise.all([
        fetch(`${API}/api/social/status?slug=${encodeURIComponent(slug)}`, { headers }),
        fetch(`${API}/api/social/posts?slug=${encodeURIComponent(slug)}`, { headers }),
      ]);
      const statusBody = await statusRes.json().catch(() => ({}));
      const postsBody = await postsRes.json().catch(() => ({}));
      if (!statusRes.ok) throw new Error(statusBody.message ?? statusBody.error ?? 'Could not load Social status.');
      if (!postsRes.ok) throw new Error(postsBody.message ?? postsBody.error ?? 'Could not load posts.');
      setEnabled(statusBody.enabled);
      setAccounts(statusBody.accounts ?? []);
      setPosts(postsBody.posts ?? []);
    } catch (err) {
      setError((err as Error).message ?? 'Network error.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function handleConnect() {
    setError(null);
    try {
      const headers = await authHeader();
      const res = await fetch(`${API}/api/social/connect/start?slug=${encodeURIComponent(slug)}`, { headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) {
        setError(body.message ?? 'Could not start the Instagram connection.');
        return;
      }
      window.location.href = body.url;
    } catch {
      setError('Network error.');
    }
  }

  async function handleDisconnect(id: string) {
    if (!window.confirm('Disconnect this Instagram account?')) return;
    setBusyId(id);
    try {
      const headers = await authHeader();
      const res = await fetch(`${API}/api/social/disconnect/${id}`, { method: 'POST', headers, body: JSON.stringify({ slug }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? 'Could not disconnect.');
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handlePublish(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const headers = await authHeader();
      const res = await fetch(`${API}/api/social/posts/${id}/publish`, { method: 'POST', headers, body: JSON.stringify({ slug }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? 'Could not publish this post.');
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string) {
    setBusyId(id);
    try {
      const headers = await authHeader();
      await fetch(`${API}/api/social/posts/${id}/reject`, { method: 'POST', headers, body: JSON.stringify({ slug }) });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      const headers = await authHeader();
      const res = await fetch(`${API}/api/social/posts/${editing.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ slug, caption: editing.caption, media_url: editing.media_url.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? 'Could not save changes.');
        return;
      }
      setEditing(null);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg border border-border bg-surface animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {banner === 'connected' && (
        <div className="rounded border border-ok/40 bg-ok/10 text-ok p-3 text-xs">Instagram account connected.</div>
      )}
      {banner === 'error' && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {bannerMessage ?? 'Could not connect Instagram.'}
        </div>
      )}
      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}

      {enabled === false && (
        <div className="rounded-lg border border-border bg-surface p-5 text-xs text-muted">
          Instagram integration isn&apos;t configured on this server yet — add META_APP_ID and META_APP_SECRET (a
          Meta App with Instagram Graph API access) to the API server. Drafts can still be created below; connecting
          and publishing will work once that&apos;s set up.
        </div>
      )}

      <Card>
        <h2 className="font-bold text-sm mb-3">Connected accounts</h2>
        {accounts.filter((a) => a.status === 'connected').length === 0 ? (
          <div className="flex items-center justify-between">
            <p className="text-muted text-xs">No Instagram account connected yet.</p>
            {canManage && (
              <Button onClick={handleConnect} disabled={enabled === false}>
                Connect Instagram
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {accounts
              .filter((a) => a.status === 'connected')
              .map((a) => (
                <div key={a.id} className="flex items-center justify-between text-xs border border-border rounded-lg p-3">
                  <div>
                    <div className="font-semibold">@{a.account_name ?? a.account_id}</div>
                    <div className="text-muted">Connected {new Date(a.connected_at).toLocaleDateString()}</div>
                  </div>
                  {canManage && (
                    <Button variant="danger" disabled={busyId === a.id} onClick={() => handleDisconnect(a.id)}>
                      Disconnect
                    </Button>
                  )}
                </div>
              ))}
          </div>
        )}
      </Card>

      <section>
        <h2 className="font-bold text-sm mb-3">Posts</h2>
        {!canPropose && !canApprove ? (
          <p className="text-muted text-xs">You don&apos;t have permission to view drafted posts.</p>
        ) : posts.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-5 text-xs text-muted">
            No posts yet. Ask the AI Assistant to draft one — e.g. &quot;write an Instagram post for our BBQ Combo
            deal&quot; — and it will show up here for review.
          </div>
        ) : (
          <div className="space-y-3">
            {posts.map((p) => (
              <Card key={p.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] mb-1">
                      <span className={`font-bold uppercase ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                      {p.proposed_by_role === 'ai' && <span className="text-muted">· AI-drafted</span>}
                      {p.related_type && <span className="text-muted">· {p.related_type.replace('_', ' ')}</span>}
                    </div>
                    {editing?.id === p.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={editing.caption}
                          onChange={(e) => setEditing({ ...editing, caption: e.target.value })}
                          rows={3}
                          maxLength={2200}
                          className="w-full rounded border border-border bg-main px-2.5 py-2 text-sm outline-none focus:border-primary"
                        />
                        <Field label="Image URL">
                          <Input
                            value={editing.media_url}
                            onChange={(e) => setEditing({ ...editing, media_url: e.target.value })}
                            placeholder="https://…"
                          />
                        </Field>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm whitespace-pre-wrap">{p.caption}</p>
                        {p.media_url ? (
                          <div className="text-[11px] text-muted mt-1 truncate">🖼 {p.media_url}</div>
                        ) : (
                          <div className="text-[11px] text-warn mt-1">No image attached yet.</div>
                        )}
                        {p.status === 'failed' && p.error && <div className="text-[11px] text-danger mt-1">{p.error}</div>}
                        {p.status === 'published' && p.published_at && (
                          <div className="text-[11px] text-muted mt-1">Published {new Date(p.published_at).toLocaleString()}</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {p.status === 'draft' && (canPropose || canApprove) && (
                  <div className="flex gap-2 mt-3">
                    {editing?.id === p.id ? (
                      <>
                        <Button disabled={busyId === p.id} onClick={saveEdit}>
                          Save
                        </Button>
                        <Button variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        {canPropose && (
                          <Button
                            variant="ghost"
                            onClick={() => setEditing({ id: p.id, caption: p.caption, media_url: p.media_url ?? '' })}
                          >
                            Edit
                          </Button>
                        )}
                        {canApprove && (
                          <>
                            <Button disabled={busyId === p.id || !p.media_url} onClick={() => handlePublish(p.id)}>
                              {busyId === p.id ? 'Publishing…' : 'Publish'}
                            </Button>
                            <Button variant="danger" disabled={busyId === p.id} onClick={() => handleReject(p.id)}>
                              Reject
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
