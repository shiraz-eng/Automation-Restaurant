import express, { type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { stripe, tierFromPriceId } from '../stripe';
import { supabaseAdmin } from '../supabase';
import { env } from '../env';
import { slugify } from '../lib/slug';
import { provisionTenant } from '../provisioning';
import { syncEntitlementsForTenant } from '../lib/entitlementSync';
import {
  isBillingInterval,
  isPlanTier,
  type BillingInterval,
  type PlanTier,
  type SubscriptionStatus,
} from '@automation-restaurant/shared';

export const stripeWebhook = express.Router();

// Stripe signature verification needs the untouched request body, so this router
// uses express.raw() and MUST be mounted before any global express.json().
stripeWebhook.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      return res.status(400).send('missing stripe-signature header');
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.warn('[stripe] signature verification failed:', (err as Error).message);
      return res.status(400).send('invalid signature');
    }

    // Idempotency: claim the event id first. ignoreDuplicates => ON CONFLICT DO
    // NOTHING; an empty result means we have already processed this event.
    const { data: claimedEvent, error: dedupeErr } = await supabaseAdmin
      .from('webhook_events')
      .upsert({ id: event.id, type: event.type }, { onConflict: 'id', ignoreDuplicates: true })
      .select('id');

    if (dedupeErr) {
      console.error('[stripe] idempotency write failed:', dedupeErr.message);
      return res.status(500).send('idempotency write failed'); // let Stripe retry
    }
    if (!claimedEvent || claimedEvent.length === 0) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await handleSubscriptionChange(event.data.object as Stripe.Subscription);
          break;
        default:
          break; // acknowledged, nothing to do
      }
      return res.status(200).json({ received: true });
    } catch (err) {
      console.error(`[stripe] handler error for ${event.type} (${event.id}):`, err);
      // Release the idempotency marker so Stripe's retry is processed afresh.
      await supabaseAdmin.from('webhook_events').delete().eq('id', event.id);
      return res.status(500).send('handler error');
    }
  },
);

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode !== 'subscription') return;

  const email = session.customer_details?.email ?? session.customer_email ?? undefined;
  const restaurantName = session.metadata?.restaurant_name?.trim();
  if (!email || !restaurantName) {
    throw new Error(
      'checkout.session.completed missing customer email or metadata.restaurant_name',
    );
  }

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
  if (!subscriptionId) {
    throw new Error(`checkout session ${session.id} has no subscription`);
  }

  // Derive tier/interval/status from the subscription + its price, not from
  // client-supplied metadata alone (metadata is only a fallback).
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price.id;
  const mapped = await tierFromPriceId(priceId);

  const metaTier = session.metadata?.plan;
  const tier: PlanTier | undefined = mapped?.tier ?? (isPlanTier(metaTier) ? metaTier : undefined);
  if (!tier) {
    throw new Error(`cannot resolve plan tier (price=${priceId ?? 'n/a'}, meta=${metaTier ?? 'n/a'})`);
  }

  const metaInterval = session.metadata?.billing_interval;
  const interval: BillingInterval =
    mapped?.interval ??
    (isBillingInterval(metaInterval)
      ? metaInterval
      : subscription.items.data[0]?.price.recurring?.interval === 'year'
        ? 'annual'
        : 'monthly');

  const status = mapStripeStatus(subscription.status);
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  const customerId =
    typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;

  // 1. Register the tenant in the control plane (fast, transactional).
  const { data, error } = await supabaseAdmin.rpc('register_tenant', {
    p_restaurant_name: restaurantName,
    p_slug: slugify(restaurantName),
    p_tier: tier,
    p_billing_interval: interval,
    p_status: status,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: subscriptionId,
    p_current_period_end: currentPeriodEnd,
    p_owner_email: email,
    p_region: env.SUPABASE_REGION,
  });
  if (error) throw new Error(`register_tenant failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  const tenantId: string = row.tenant_id;
  const slug: string = row.slug;

  // 1b. Persist the business details captured at checkout (metadata only —
  //     never operational restaurant data).
  const m = session.metadata ?? {};
  const ownerName = m.owner_name?.trim() || null;
  await supabaseAdmin
    .from('tenants')
    .update({
      owner_name: ownerName,
      phone: m.phone?.trim() || null,
      country: m.country?.trim() || null,
      address: m.address?.trim() || null,
      branch_name: m.branch_name?.trim() || null,
      table_count: m.table_count ? Number(m.table_count) || null : null,
    })
    .eq('id', tenantId);

  // 2. Kick off project provisioning (minutes long) detached, so Stripe gets a
  //    fast 200. Progress/failure is tracked on the tenants row; the welcome
  //    email is sent by provisionTenant only after the workspace is ready.
  void provisionTenant({
    tenantId,
    restaurantName,
    slug,
    ownerEmail: email,
    ownerName: ownerName ?? undefined,
  });

  console.log(`[stripe] registered tenant ${tenantId} (${slug}); provisioning project…`);
}

async function handleSubscriptionChange(subscription: Stripe.Subscription): Promise<void> {
  const mapped = await tierFromPriceId(subscription.items.data[0]?.price.id);
  const { error } = await supabaseAdmin.rpc('sync_subscription', {
    p_stripe_subscription_id: subscription.id,
    p_tier: mapped?.tier ?? null,
    p_status: mapStripeStatus(subscription.status),
    p_current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
  });
  if (error) {
    throw new Error(`sync_subscription failed: ${error.message}`);
  }

  // Push the (possibly new) tier's entitlements down to the tenant's own
  // project — best-effort, never fails the webhook itself (Stripe would
  // just retry an already-applied subscription change).
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('tenant_id')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle();
  if (sub?.tenant_id) {
    try {
      await syncEntitlementsForTenant(sub.tenant_id);
    } catch (err) {
      console.error(`[stripe] entitlement sync failed for tenant ${sub.tenant_id}:`, err);
    }
  }
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'incomplete';
  }
}
