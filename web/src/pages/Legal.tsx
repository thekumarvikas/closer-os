import type { ReactNode } from 'react'

/** Public pages (no login): privacy policy, terms, how to delete an account. Linked from the app and the Play Store. */
const CONTACT = 'teamcloseros@gmail.com'
const UPDATED = '12 November 2026'

export const LEGAL_PATHS = ['/privacy', '/terms', '/delete-account']

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <a href="/" className="text-sm font-semibold text-brand-700">Closer OS</a>
        <h1 className="mt-3 text-3xl font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">Last updated: {UPDATED}</p>
        <div className="legal mt-6 space-y-4 text-[15px] leading-relaxed text-slate-700">{children}</div>
        <nav className="mt-10 flex flex-wrap gap-4 border-t border-slate-200 pt-4 text-sm text-brand-700">
          <a href="/privacy">Privacy policy</a><a href="/terms">Terms of use</a><a href="/delete-account">Delete your account</a>
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
        </nav>
      </div>
    </div>
  )
}
const H = ({ children }: { children: ReactNode }) => <h2 className="pt-4 text-lg font-semibold text-slate-900">{children}</h2>
const L = ({ items }: { items: ReactNode[] }) => <ul className="list-disc space-y-1.5 pl-5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>

export default function Legal() {
  const p = window.location.pathname.replace(/\/+$/, '')
  if (p === '/terms') return <Terms />
  if (p === '/delete-account') return <DeleteAccount />
  return <Privacy />
}

function Privacy() {
  return (
    <Page title="Privacy policy">
      <p>Closer OS (“we”, “us”) is a calling and lead-management app for salespeople, with a web dashboard for sales teams. This policy explains what we collect, why, and the choices you have. Questions: <a className="text-brand-700" href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>

      <H>What we collect</H>
      <L items={[
        <><b>Your account:</b> name, email address and password (stored only in encrypted form by our login provider).</>,
        <><b>Leads you add or import:</b> names, phone numbers, emails, company, city, notes, follow-up times and outcomes you record. You decide what goes in.</>,
        <><b>Calls with your leads:</b> for phone numbers in your lead list, the number, date and time, duration, direction (dialled, received, missed) and which SIM was used. In the individual app, calls with numbers that are not in your lead list stay on your phone and are not sent to us, unless you add that number as a lead.</>,
        <><b>WhatsApp calls (only if you turn on notification access):</b> the app reads only WhatsApp call notifications to note the contact, time and duration of calls with your leads. It does not read messages or any other notifications.</>,
        <><b>Contacts:</b> read on your phone to show saved names next to numbers. Your contact list is not uploaded.</>,
        <><b>Call recordings:</b> in the individual app, recordings made by your phone stay on your phone. Closer OS only finds the matching file in the folder you choose so you can play it inside the app. Recordings are never uploaded. (Company accounts may choose to upload recordings to their private company storage.)</>,
        <><b>Device and app information:</b> phone model, Android version, app version, setup status and error reports, used to keep the app working.</>,
        <><b>Purchases:</b> if you buy Closer OS Pro, Google Play handles the payment. We only learn whether your subscription is active. We never see your card or bank details.</>,
      ]} />

      <H>Advertising</H>
      <p>The free individual app shows ads from Google AdMob. Google may use your device's advertising ID, IP address and app usage to show and measure ads. Where the law requires it (for example in the European Economic Area and the UK), you are asked for consent first. You can reset or delete your advertising ID in your phone's Google settings. Learn more in <a className="text-brand-700" href="https://policies.google.com/technologies/partner-sites">how Google uses information from apps that use its services</a>. Paid subscribers and company accounts see no ads.</p>

      <H>How we use it</H>
      <L items={['To run the app: save your leads, calls, outcomes and follow-ups, show your reports and send your reminders.',
        'To keep your data in sync between your phone and the web dashboard.',
        'To fix problems and keep the service secure.',
        'To show ads in the free individual app.']} />
      <p>We do not sell your data. We do not use your leads' details for our own marketing.</p>

      <H>Who processes it</H>
      <L items={[<><b>Supabase</b> — our database and login provider. Data is stored on servers in Mumbai, India, and sent over encrypted connections.</>,
        <><b>Google</b> — Google Play (app delivery, payments) and Google AdMob (ads in the free app).</>]} />

      <H>Company (team) accounts</H>
      <p>When you use Closer OS through your employer's account, your company decides what is tracked (for example, which calls are uploaded) and controls that data. Please ask your company about its policies. We process that data on the company's behalf.</p>

      <H>How long we keep it, and deleting it</H>
      <p>We keep your data while your account exists. You can delete your account at any time in the app (<b>Settings → Delete my account</b>) or by writing to us from your account's email address — see <a className="text-brand-700" href="/delete-account">Delete your account</a>. Deletion removes your account, leads, call history, notes and follow-ups from our live systems straight away. Backup copies are overwritten within 30 days.</p>

      <H>Your rights</H>
      <p>You can ask to see, correct, export or delete your personal data, and you can withdraw consent for personalised ads. Write to <a className="text-brand-700" href={`mailto:${CONTACT}`}>{CONTACT}</a>; we reply within 30 days. Depending on where you live, you may also complain to your data-protection authority.</p>

      <H>Children</H>
      <p>Closer OS is a work tool for adults. It is not meant for anyone under 18, and we do not knowingly collect children's data.</p>

      <H>Your leads' data</H>
      <p>The people in your lead list did not sign up to Closer OS. You are responsible for having a lawful reason to store and contact them, and for following calling and recording laws where you work (for example do-not-call registers and telling people when a call is recorded).</p>

      <H>Changes</H>
      <p>If we change this policy, we update the date above and, for important changes, tell you in the app.</p>
    </Page>
  )
}

function Terms() {
  return (
    <Page title="Terms of use">
      <p>By creating an account or using Closer OS you agree to these terms. If you don't agree, please don't use the app.</p>
      <H>The service</H>
      <p>Closer OS helps you manage leads, make calls, record call outcomes, plan follow-ups and see reports. The individual app is free and shows ads; some extra features open after watching a short ad. Closer OS Pro, a paid subscription, removes the ads and opens the extra features (such as more WhatsApp sequences).</p>
      <H>Subscriptions</H>
      <L items={['Closer OS Pro is sold through Google Play as a monthly or yearly subscription, in your local currency, shown before you pay.',
        'It renews automatically until you cancel. Cancel any time in Google Play → Payments & subscriptions; it stays active until the end of the period already paid.',
        'Refunds follow Google Play\'s refund policy.',
        'Company plans are sold separately on our website under their own terms.']} />
      <H>Your responsibilities</H>
      <L items={['Keep your password safe; you are responsible for activity on your account.',
        'Only add people you have a lawful reason to contact, and follow the calling, messaging, recording and privacy laws of your country (for example do-not-call rules and consent for call recording).',
        'Do not use Closer OS for spam, harassment, fraud or anything illegal, and do not try to break, overload or copy the service.']} />
      <H>Your data</H>
      <p>Your leads, notes and call information belong to you. You give us permission to store and process them only to provide the service, as described in the <a className="text-brand-700" href="/privacy">privacy policy</a>. You can delete your account and data at any time.</p>
      <H>Availability and changes</H>
      <p>We work to keep Closer OS running and your data safe, but the service is provided “as is”, without guarantees that it will always be available or error-free. We may change or improve features. If we ever stop the service, we will give reasonable notice so you can export your data.</p>
      <H>Liability</H>
      <p>To the extent the law allows, we are not liable for lost sales, lost profits or indirect losses arising from use of the app. Our total liability is limited to the amount you paid us in the 12 months before the claim.</p>
      <H>Ending your account</H>
      <p>You can stop using Closer OS and delete your account at any time. We may suspend accounts that break these terms or the law.</p>
      <H>Law</H>
      <p>These terms are governed by the laws of India. Courts in India have jurisdiction, without taking away any rights you have under the consumer laws of your own country.</p>
      <H>Contact</H>
      <p><a className="text-brand-700" href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
    </Page>
  )
}

function DeleteAccount() {
  return (
    <Page title="Delete your Closer OS account">
      <p>You can delete your account and all its data at any time.</p>
      <H>In the app (fastest)</H>
      <L items={['Open Closer OS and go to Settings (the gear icon).', 'Under “Your account”, tap Delete my account.', 'Type DELETE and tap Delete forever.']} />
      <H>By email</H>
      <p>If you can't open the app, email <a className="text-brand-700" href={`mailto:${CONTACT}?subject=Delete%20my%20Closer%20OS%20account`}>{CONTACT}</a> from the email address of your account with the subject “Delete my Closer OS account”. We delete it within 7 days and confirm by email.</p>
      <H>What is deleted</H>
      <p>Your login, your leads, call history, outcomes, notes, follow-ups and settings. Nothing on your phone itself is touched (your phone's call history and recordings stay). Backup copies are overwritten within 30 days. If you have a Closer OS Pro subscription, also cancel it in Google Play → Payments & subscriptions.</p>
      <H>Company accounts</H>
      <p>If your login belongs to your employer's Closer OS account, ask your company admin to remove you; the company's data stays with the company.</p>
    </Page>
  )
}
