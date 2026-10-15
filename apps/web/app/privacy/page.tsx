export const metadata = { title: 'Privacy Policy — EasyDistribution Social Manager' };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-sm text-neutral-800 space-y-4">
      <h1 className="text-2xl font-bold">Privacy Policy</h1>
      <p className="text-neutral-500">Last updated: July 2025</p>

      <p>
        This policy explains how EasyDistribution Social Manager collects, uses, and protects data
        when you connect your social media accounts.
      </p>

      <h2 className="font-semibold text-base">1. Data we collect</h2>
      <ul className="list-disc pl-5 space-y-1">
        <li>Your TikTok open ID and display name (via TikTok Login Kit).</li>
        <li>OAuth access tokens, stored encrypted in our database.</li>
        <li>Post content, captions, and media you create inside the App.</li>
        <li>Basic usage logs for security and debugging.</li>
      </ul>

      <h2 className="font-semibold text-base">2. How we use it</h2>
      <ul className="list-disc pl-5 space-y-1">
        <li>To publish or schedule content to your connected accounts on your behalf.</li>
        <li>To display account status and publishing history inside the App.</li>
        <li>We do not sell or share your data with third parties.</li>
      </ul>

      <h2 className="font-semibold text-base">3. TikTok data</h2>
      <p>
        Data obtained through TikTok APIs is used solely to operate the App features you authorise.
        We comply with TikTok&apos;s Platform Policy and do not use TikTok data for advertising or
        profiling.
      </p>

      <h2 className="font-semibold text-base">4. Data retention</h2>
      <p>
        Tokens are deleted when you disconnect your account. Post records are retained for audit
        purposes and can be deleted on request.
      </p>

      <h2 className="font-semibold text-base">5. Security</h2>
      <p>
        All tokens are encrypted at rest using AES-256-GCM. Access to the App requires
        authentication and is restricted to authorised personnel.
      </p>

      <h2 className="font-semibold text-base">6. Contact</h2>
      <p>
        To request data deletion or ask questions:{' '}
        <a href="mailto:admin@easydistribution.tn" className="underline">admin@easydistribution.tn</a>
      </p>
    </main>
  );
}
