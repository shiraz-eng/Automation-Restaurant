/**
 * Placeholder mailer. Swap the body for Resend / Postmark / SES. Kept trivial so
 * the onboarding flow is runnable end-to-end without an email provider — the
 * claim link is printed to the server log.
 */
export async function sendOnboardingEmail(to: string, claimUrl: string): Promise<void> {
  console.log(`[mailer] onboarding claim link for ${to}\n  ${claimUrl}`);
}
