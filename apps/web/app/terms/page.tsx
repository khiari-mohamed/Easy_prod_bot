export const metadata = { title: 'Terms of Service — EasyDistribution Social Manager' };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-sm text-neutral-800 space-y-4">
      <h1 className="text-2xl font-bold">Terms of Service</h1>
      <p className="text-neutral-500">Last updated: July 2025</p>

      <p>
        EasyDistribution Social Manager (&quot;the App&quot;) is an internal social media management
        tool operated by EasyDistribution. By using the App you agree to these terms.
      </p>

      <h2 className="font-semibold text-base">1. Use of the App</h2>
      <p>
        The App is provided exclusively to authorised staff and contractors of EasyDistribution.
        You may not share your credentials or use the App for any purpose outside your assigned role.
      </p>

      <h2 className="font-semibold text-base">2. Third-party platforms</h2>
      <p>
        The App connects to Facebook, Instagram, and TikTok on your behalf using OAuth tokens you
        explicitly grant. You remain responsible for compliance with each platform&apos;s own terms of
        service.
      </p>

      <h2 className="font-semibold text-base">3. Content</h2>
      <p>
        You are solely responsible for the content you schedule or publish through the App.
        EasyDistribution reserves the right to remove content that violates applicable law or
        platform policies.
      </p>

      <h2 className="font-semibold text-base">4. Limitation of liability</h2>
      <p>
        The App is provided &quot;as is&quot;. EasyDistribution is not liable for any loss arising from
        platform outages, scheduling errors, or unauthorised access to your account.
      </p>

      <h2 className="font-semibold text-base">5. Changes</h2>
      <p>
        These terms may be updated at any time. Continued use of the App after changes constitutes
        acceptance of the new terms.
      </p>

      <h2 className="font-semibold text-base">6. Contact</h2>
      <p>
        For questions contact:{' '}
        <a href="mailto:admin@easydistribution.tn" className="underline">admin@easydistribution.tn</a>
      </p>
    </main>
  );
}
