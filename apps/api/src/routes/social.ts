import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { isAllowedOrigin, env, socialEnabled } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';
import { tenantServiceClientBySlug } from '../lib/tenantAdmin';
import {
  buildAuthorizeUrl,
  exchangeCodeForUserToken,
  exchangeForLongLivedToken,
  findInstagramAccount,
  publishInstagramPost,
  signSocialState,
  verifySocialState,
} from '../lib/socialAuth';

/**
 * Instagram connect + draft/approval/publish routes ("trained to manage
 * social handles like instagram" from the governing request). Connecting
 * an account and publishing a post are each their own explicit,
 * permission-gated action — draft_social_post (aiTools.ts) only ever
 * creates a 'draft' row here, never calls the Graph API itself.
 */
export const socialRouter = express.Router();

socialRouter.use((req: Request, res: Response, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

type AccountRow = {
  id: string;
  platform: string;
  account_name: string | null;
  account_id: string;
  status: string;
  connected_at: string;
};
type PostRow = {
  id: string;
  platform: string;
  caption: string;
  media_url: string | null;
  related_type: string | null;
  related_id: string | null;
  status: string;
  proposed_by_role: string | null;
  published_at: string | null;
  external_post_id: string | null;
  error: string | null;
  created_at: string;
};

socialRouter.get('/status', requirePortalPerm('social.view'), async (req: Request, res: Response) => {
  const { admin } = req.tenant!;
  const { data, error } = await admin
    .from('social_accounts')
    .select('id, platform, account_name, account_id, status, connected_at')
    .order('connected_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'query_failed', message: error.message });
  return res.json({ enabled: socialEnabled, accounts: (data ?? []) as AccountRow[] });
});

/** Returns the Facebook OAuth authorize URL for the frontend to navigate
 *  to — kept as a GET the client fetches with its Bearer token (rather
 *  than a plain link) so the signed state can carry exactly which tenant
 *  and which staff member is connecting. */
socialRouter.get('/connect/start', requirePortalPerm('social.manage'), async (req: Request, res: Response) => {
  if (!socialEnabled) {
    return res.status(503).json({
      error: 'social_not_configured',
      message: 'Instagram isn\'t configured on this server yet — add META_APP_ID and META_APP_SECRET.',
    });
  }
  const { slug, userId } = req.tenant!;
  const state = signSocialState({ slug, userId });
  return res.json({ url: buildAuthorizeUrl(state) });
});

/**
 * The OAuth redirect target itself — hit directly by Facebook's browser
 * redirect, so it carries no Authorization header and can't go through
 * requirePortalPerm. Trusts only the signed `state` (see socialAuth.ts)
 * to recover which tenant/user started the flow, then uses the tenant's
 * own service-role client (RLS bypass is appropriate here: there is no
 * user JWT on this request at all, only a verified signed claim).
 */
socialRouter.get('/connect/callback', async (req: Request, res: Response) => {
  const redirectTo = (slug: string, status: 'connected' | 'error', message?: string) => {
    const qs = new URLSearchParams({ social: status, ...(message ? { message } : {}) });
    res.redirect(`${env.APP_URL}/r/${slug}/social?${qs.toString()}`);
  };

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const stateToken = typeof req.query.state === 'string' ? req.query.state : '';
  const state = verifySocialState(stateToken);
  if (!state) return res.status(400).send('This connection link has expired or is invalid — start over from Settings.');
  if (!code) return redirectTo(state.slug, 'error', 'Instagram did not return an authorization code.');

  try {
    const svc = await tenantServiceClientBySlug(state.slug);
    if (!svc) return redirectTo(state.slug, 'error', 'Restaurant not found.');

    const shortLived = await exchangeCodeForUserToken(code);
    const longLived = await exchangeForLongLivedToken(shortLived.access_token);
    const found = await findInstagramAccount(longLived.access_token);
    if (!found) {
      return redirectTo(
        state.slug,
        'error',
        'No Instagram Business account is connected to any Facebook Page you manage — connect one in Meta Business Suite first.',
      );
    }

    const expiresInMs = (longLived.expires_in ?? 60 * 24 * 60 * 60) * 1000;
    const { error } = await svc.admin.from('social_accounts').upsert(
      {
        platform: 'instagram',
        account_id: found.instagramAccountId,
        account_name: found.instagramUsername,
        access_token: found.pageAccessToken,
        token_expires_at: new Date(Date.now() + expiresInMs).toISOString(),
        status: 'connected',
        connected_by: state.userId,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'platform,account_id' },
    );
    if (error) return redirectTo(state.slug, 'error', error.message);
    return redirectTo(state.slug, 'connected');
  } catch (err) {
    console.error('[social] connect callback failed:', err);
    return redirectTo(state.slug, 'error', 'Could not complete the Instagram connection.');
  }
});

socialRouter.post('/disconnect/:id', requirePortalPerm('social.manage'), async (req: Request, res: Response) => {
  const { admin } = req.tenant!;
  const { error } = await admin
    .from('social_accounts')
    .update({ status: 'disconnected', updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'update_failed', message: error.message });
  return res.json({ ok: true });
});

socialRouter.get('/posts', requirePortalPerm('social.view'), async (req: Request, res: Response) => {
  const { admin } = req.tenant!;
  const { data, error } = await admin
    .from('social_posts')
    .select('id, platform, caption, media_url, related_type, related_id, status, proposed_by_role, published_at, external_post_id, error, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: 'query_failed', message: error.message });
  return res.json({ posts: (data ?? []) as PostRow[] });
});

const editSchema = z.object({
  slug: z.string().min(1),
  caption: z.string().min(1).max(2200).optional(), // Instagram's own caption limit
  media_url: z.string().url().max(2000).nullable().optional(),
});

/** Editing a draft's caption/media before publish needs the SAME permission
 *  as drafting one (social.propose_post) — approve_post is for the
 *  publish/reject decision itself, not for touching the draft's content. */
socialRouter.patch('/posts/:id', express.json(), requirePortalPerm('social.propose_post'), async (req: Request, res: Response) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin } = req.tenant!;
  const { data: existing } = await admin.from('social_posts').select('status').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (existing.status !== 'draft') {
    return res.status(409).json({ error: 'not_editable', message: 'Only a draft post can be edited.' });
  }
  const patch: Record<string, unknown> = {};
  if (parsed.data.caption !== undefined) patch.caption = parsed.data.caption;
  if (parsed.data.media_url !== undefined) patch.media_url = parsed.data.media_url;
  const { error } = await admin.from('social_posts').update(patch).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'update_failed', message: error.message });
  return res.json({ ok: true });
});

socialRouter.post('/posts/:id/reject', requirePortalPerm('social.approve_post'), async (req: Request, res: Response) => {
  const { admin, userId } = req.tenant!;
  const { error } = await admin
    .from('social_posts')
    .update({ status: 'rejected', approved_by: userId, approved_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('status', 'draft');
  if (error) return res.status(500).json({ error: 'update_failed', message: error.message });
  return res.json({ ok: true });
});

/**
 * The one place this whole feature actually posts to Instagram — a human
 * clicking Publish on a draft they've reviewed. Never reachable from AI
 * chat: draft_social_post (aiTools.ts) has no path to this route.
 */
socialRouter.post('/posts/:id/publish', requirePortalPerm('social.approve_post'), async (req: Request, res: Response) => {
  if (!socialEnabled) {
    return res.status(503).json({ error: 'social_not_configured', message: 'Instagram isn\'t configured on this server.' });
  }
  const { admin, userId } = req.tenant!;
  const { data: post } = await admin
    .from('social_posts')
    .select('id, status, caption, media_url, account_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!post) return res.status(404).json({ error: 'not_found' });
  if (post.status !== 'draft') {
    return res.status(409).json({ error: 'not_publishable', message: 'This post has already been resolved.' });
  }
  if (!post.media_url) {
    return res.status(422).json({ error: 'missing_media', message: 'Add an image URL before publishing — Instagram requires one.' });
  }
  const { data: account } = await admin
    .from('social_accounts')
    .select('id, account_id, access_token, status')
    .eq('id', post.account_id)
    .maybeSingle();
  if (!account || account.status !== 'connected') {
    return res.status(409).json({ error: 'no_account', message: 'No connected Instagram account — connect one in Settings first.' });
  }

  try {
    const { externalPostId } = await publishInstagramPost(account.account_id, account.access_token, post.media_url, post.caption);
    await admin
      .from('social_posts')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
        external_post_id: externalPostId,
        approved_by: userId,
        approved_at: new Date().toISOString(),
      })
      .eq('id', post.id);
    return res.json({ ok: true, externalPostId });
  } catch (err) {
    const message = (err as Error).message ?? 'Instagram rejected this post.';
    await admin.from('social_posts').update({ status: 'failed', error: message }).eq('id', post.id);
    return res.status(502).json({ error: 'publish_failed', message });
  }
});
