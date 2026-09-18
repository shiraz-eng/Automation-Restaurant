import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

/**
 * The Instagram connect flow (Facebook Login for Business -> Page ->
 * connected Instagram Business Account). Two things this file owns that
 * nothing else in the app needed before: signing the OAuth `state`
 * parameter (same HMAC-over-SUPABASE_SERVICE_ROLE_KEY pattern
 * lib/payments.ts already uses for signCheckoutIntent — not a new secret),
 * and the handful of Graph API calls the connect callback and the publish
 * route each need. Nothing here can be exercised without a real Meta App
 * (META_APP_ID/META_APP_SECRET) — see env.ts's socialEnabled.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — an OAuth redirect round trip is seconds, not minutes

export type SocialState = { slug: string; userId: string; iat: number };

function hmac(data: string): Buffer {
  return createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update(data).digest();
}

/** Encodes which tenant + which staff member started the connect flow into
 *  the OAuth `state` param, signed so the callback (a plain redirect from
 *  Facebook, carrying no session of its own) can trust it without a
 *  separate server-side session store. */
export function signSocialState(state: Omit<SocialState, 'iat'>): string {
  const body = Buffer.from(JSON.stringify({ ...state, iat: Date.now() })).toString('base64url');
  return `${body}.${hmac(body).toString('base64url')}`;
}

export function verifySocialState(token: string): SocialState | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(body, 'base64url').toString()) as SocialState;
    if (Date.now() - state.iat > STATE_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.META_APP_ID as string,
    redirect_uri: env.META_REDIRECT_URI,
    state,
    response_type: 'code',
    scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management',
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${GRAPH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `Graph API ${path} failed (${res.status})`);
  }
  return json;
}

export async function exchangeCodeForUserToken(code: string): Promise<{ access_token: string }> {
  return graphGet('/oauth/access_token', {
    client_id: env.META_APP_ID as string,
    client_secret: env.META_APP_SECRET as string,
    redirect_uri: env.META_REDIRECT_URI,
    code,
  });
}

/** Short-lived (~1-2h) -> long-lived (~60 days) user token, per Meta's
 *  documented token-exchange flow — never store the short-lived one. */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<{ access_token: string; expires_in?: number }> {
  return graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: env.META_APP_ID as string,
    client_secret: env.META_APP_SECRET as string,
    fb_exchange_token: shortLivedToken,
  });
}

type PageWithInstagram = { pageId: string; pageAccessToken: string; instagramAccountId: string; instagramUsername: string | null };

/** Walks every Facebook Page the connecting user manages and returns the
 *  first one with an Instagram Business Account attached — this app
 *  connects exactly one Instagram account per tenant, matching
 *  social_accounts' own (platform, account_id) uniqueness. A restaurant
 *  managing several Pages picks which one to connect by only granting
 *  that Page in Facebook's own permission picker during the OAuth consent
 *  screen (Meta's standard UX for this), not a selector this app builds. */
export async function findInstagramAccount(longLivedUserToken: string): Promise<PageWithInstagram | null> {
  const pages = await graphGet<{ data: { id: string; access_token: string }[] }>('/me/accounts', {
    access_token: longLivedUserToken,
  });
  for (const page of pages.data ?? []) {
    const details = await graphGet<{ instagram_business_account?: { id: string; username?: string } }>(`/${page.id}`, {
      fields: 'instagram_business_account{id,username}',
      access_token: page.access_token,
    });
    if (details.instagram_business_account) {
      return {
        pageId: page.id,
        pageAccessToken: page.access_token,
        instagramAccountId: details.instagram_business_account.id,
        instagramUsername: details.instagram_business_account.username ?? null,
      };
    }
  }
  return null;
}

/** The two-step Instagram content-publishing flow: create a media
 *  container, then publish it. image_url must be publicly reachable —
 *  Instagram's own servers fetch it, this app never uploads bytes directly. */
export async function publishInstagramPost(
  instagramAccountId: string,
  accessToken: string,
  imageUrl: string,
  caption: string,
): Promise<{ externalPostId: string }> {
  const container = await graphPost<{ id: string }>(`/${instagramAccountId}/media`, {
    image_url: imageUrl,
    caption,
    access_token: accessToken,
  });
  const published = await graphPost<{ id: string }>(`/${instagramAccountId}/media_publish`, {
    creation_id: container.id,
    access_token: accessToken,
  });
  return { externalPostId: published.id };
}

async function graphPost<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `Graph API ${path} failed (${res.status})`);
  }
  return json;
}
