import { Hero } from './_sections/Hero';
import { VisualShowcase } from './_sections/VisualShowcase';
import { TrustStrip } from './_sections/TrustStrip';
import { PlatformOverview } from './_sections/PlatformOverview';
import { HowItConnects } from './_sections/HowItConnects';
import { OwnerCommandCenter } from './_sections/OwnerCommandCenter';
import {
  OperationsKitchenSection,
  InventoryRecipesSection,
  SuppliersPurchasingSection,
  FinanceSection,
  MarketingSection,
} from './_sections/WorkflowSections';
import { PortalBuilder } from './_sections/PortalBuilder';
import { BrandablePortals } from './_sections/BrandablePortals';
import { AiIntelligence } from './_sections/AiIntelligence';
import { CustomerExperience } from './_sections/CustomerExperience';
import { UseCases } from './_sections/UseCases';
import { HowItWorks } from './_sections/HowItWorks';
import { PricingTeaser } from './_sections/PricingTeaser';
import { FaqSection } from './_sections/FaqSection';
import { FinalCta } from './_sections/FinalCta';

export default function Landing() {
  return (
    <>
      <Hero />
      <VisualShowcase />
      <TrustStrip />
      <PlatformOverview />
      <HowItConnects />
      <OwnerCommandCenter />
      <OperationsKitchenSection />
      <InventoryRecipesSection />
      <SuppliersPurchasingSection />
      <FinanceSection />
      <MarketingSection />
      <PortalBuilder />
      <BrandablePortals />
      <AiIntelligence />
      <CustomerExperience />
      <UseCases />
      <HowItWorks />
      <PricingTeaser />
      <FaqSection />
      <FinalCta />
    </>
  );
}
