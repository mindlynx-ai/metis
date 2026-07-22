/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Account & Cloud: one capability grid (from the offers manifest, so it
 * renders offline too) under a hero with four states - disconnected,
 * connecting, connected, offline. Connecting hands the browser to the
 * Helix sign-in and the OIDC callback lands back here (?connected=1 /
 * ?connect=failed|badstate). The local admin sign-in is a different
 * thing entirely and is never mentioned on this page.
 */
import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { toast } from './toast-store.js';
import { upliftApi, type OfferEntry } from './uplift-api.js';
import { ensureUplift, useUplift } from './uplift-store.js';
import { Icon, type IconName } from './ui/Icon.js';

/** Presentation copy per capability: the disc glyph + the three "adds" lines.
 *  Titles, states and links stay offers-driven; unknown ids fall back to the
 *  offer's description. */
const CAP_DETAILS: Record<string, { icon: IconName; adds: string[] }> = {
  'cap.data': {
    icon: 'database',
    adds: [
      'Millions of rows, not thousands',
      'Heavy transforms run off your machine',
      'Results come straight back to the run',
    ],
  },
  'cap.memory': {
    icon: 'memory',
    adds: [
      'Workflows that remember across runs',
      'Shared recall between workflows',
      'Organised knowledge, not just notes',
    ],
  },
  'cap.agent': {
    icon: 'bot',
    adds: [
      'Delegate whole steps to an assistant',
      'Teams of agents on bigger jobs',
      'Guard-rails and review built in',
    ],
  },
  'cap.approvals': {
    icon: 'stamp',
    adds: [
      'Sign-off requests in one inbox',
      'Escalation when nobody answers',
      'A full record of every decision',
    ],
  },
  'cap.model': {
    icon: 'spark',
    adds: [
      'Managed AI models, no keys to mind',
      'The right model picked per task',
      'Spending caps you control',
    ],
  },
};

const STATE_CHIPS: Record<OfferEntry['state'], { className: string; label: string }> = {
  available: { className: 'chip-available', label: 'Available' },
  beta: { className: 'chip-beta', label: 'Beta' },
  'coming-soon': { className: 'chip-soon', label: 'Coming soon' },
};

type HeroState = 'disconnected' | 'connecting' | 'connected' | 'offline';

function CapabilityCard({
  offer,
  connected,
  entitled,
}: {
  offer: OfferEntry;
  connected: boolean;
  entitled: boolean;
}) {
  const details = CAP_DETAILS[offer.id];
  const purchasable = offer.state === 'available';
  // The chip states an account-relative truth once connected.
  let chip = STATE_CHIPS[offer.state];
  if (connected && entitled) chip = { className: 'chip-included', label: 'Included' };
  else if (connected && purchasable) chip = { className: 'chip-soon', label: 'Not in your plan' };
  return (
    <article className="capcard" id={offer.id}>
      <span className={`chip ${chip.className}`}>{chip.label}</span>
      <div className="cap-head">
        <span className="cap-disc" aria-hidden="true">
          <Icon name={details?.icon ?? 'cloud'} size={17} />
        </span>
        <span className="cap-name">{offer.title}</span>
      </div>
      <ul className="cap-adds">
        {(details?.adds ?? [offer.description]).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {purchasable && !entitled && (
        <a className="upgrade-link" href={offer.ctaUrl} target="_blank" rel="noreferrer">
          {connected ? 'Upgrade' : 'See plans'} {'→'}
        </a>
      )}
    </article>
  );
}

export function AccountPage() {
  const uplift = useUplift();
  useEffect(ensureUplift, []);
  const [connected, setConnected] = useState<boolean>();
  const [email, setEmail] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  const refresh = () =>
    upliftApi
      .account()
      .then((result) => {
        setConnected(result.connected);
        setEmail(result.account?.email);
      })
      .catch(() => setConnected(false));

  useEffect(() => {
    void refresh();
  }, []);

  // The OIDC callback lands back here with a verdict in the query string.
  useEffect(() => {
    const done = searchParams.get('connected');
    const failed = searchParams.get('connect');
    if (!done && !failed) return;
    if (done) {
      toast.success('Helix account connected');
      refresh().catch(() => undefined);
      useUplift
        .getState()
        .refresh()
        .catch(() => undefined);
    } else {
      toast.error("That didn't work. Try connecting again.");
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  // Palette "See what full adds" links land on /account#<capability>.
  useEffect(() => {
    if (!location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [location.hash, uplift.offers]);

  const connect = async () => {
    setConnecting(true);
    try {
      const { authorizeUrl } = await upliftApi.connectAccount();
      window.location.href = authorizeUrl;
    } catch {
      setConnecting(false);
      toast.error("That didn't work. Try connecting again.");
    }
  };

  const disconnect = async () => {
    try {
      await upliftApi.disconnectAccount();
      setConnected(false);
      setEmail(undefined);
      useUplift
        .getState()
        .refresh()
        .catch(() => undefined);
      toast.info('Helix account disconnected');
    } catch {
      toast.error('Could not disconnect. Try again.');
    }
  };

  let hero: HeroState = 'disconnected';
  if (connecting) hero = 'connecting';
  else if (connected) hero = 'connected';
  else if (uplift.loaded && uplift.cloud === 'offline') hero = 'offline';

  return (
    <main className="shell-main account-page" aria-label="Account">
      <h1 className="page-title">Account</h1>

      <section className="acct-hero" data-state={hero}>
        {hero === 'disconnected' && (
          <div>
            <h2>Do more with Helix Cloud</h2>
            <p>
              Your workflows keep working here, free. Connecting adds heavier lifting when you
              need it.
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  connect().catch(() => undefined);
                }}
              >
                Connect your Helix account
              </button>
              <button
                type="button"
                className="signup"
                onClick={() => {
                  connect().catch(() => undefined);
                }}
              >
                New here? Create an account
              </button>
            </div>
          </div>
        )}
        {hero === 'connecting' && (
          <div>
            <div className="acct-row">
              <span className="spin" aria-hidden="true" /> <span>Taking you to Helix to sign in{'…'}</span>
            </div>
            <p className="retry-row">
              <button type="button" className="retry" onClick={() => setConnecting(false)}>
                That didn&apos;t work? Try again
              </button>
            </p>
          </div>
        )}
        {hero === 'connected' && (
          <div className="acct-row">
            <span className="plan-pill">
              <Icon name="cloud" size={13} /> Helix Cloud
            </span>
            <span className="acct-email">{email}</span>
            <span className="acct-spacer" />
            <button
              type="button"
              className="btn btn-danger-ghost"
              onClick={() => {
                disconnect().catch(() => undefined);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
        {hero === 'offline' && (
          <p className="offline-note">
            You&apos;re offline. Cloud features need an internet connection {'\u2014'} everything
            else works as normal.
          </p>
        )}
      </section>

      <section className="cap-grid" aria-label="Cloud capabilities">
        {uplift.offers.map((offer) => (
          <CapabilityCard
            key={offer.id}
            offer={offer}
            connected={Boolean(connected)}
            entitled={uplift.capabilities.includes(offer.id)}
          />
        ))}
      </section>
    </main>
  );
}
