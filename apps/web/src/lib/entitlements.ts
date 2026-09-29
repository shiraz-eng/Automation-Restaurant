import type { SupabaseClient } from '@supabase/supabase-js';
import { isTierEntitledToFeature, FEATURE_METADATA, type FeatureKey } from '@automation-restaurant/shared';

export interface TenantEntitlement {
  tier: string | null;
  features: FeatureKey[];
  isEntitled: (feature: FeatureKey) => boolean;
  requiredPlanName: (feature: FeatureKey) => string;
}

/**
 * Resolves current plan tier and custom explicit features for the tenant.
 * Uses t.config.tier (from tenant_directory) with fallback to business_settings.plan_tier.
 */
export async function getTenantEntitlement(
  client: SupabaseClient,
  configTier?: string | null,
): Promise<TenantEntitlement> {
  const { data } = await client
    .from('business_settings')
    .select('plan_tier, plan_features')
    .eq('id', true)
    .maybeSingle();

  const tier = configTier || data?.plan_tier || null;
  const features = (data?.plan_features ?? []) as FeatureKey[];

  return {
    tier,
    features,
    isEntitled: (feature: FeatureKey) => isTierEntitledToFeature(tier, feature, features),
    requiredPlanName: (feature: FeatureKey) => FEATURE_METADATA[feature]?.minTierName || 'Professional',
  };
}
