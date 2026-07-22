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
 * The app shell for the list/overview surfaces: a fixed left sidebar (brand,
 * primary nav, theme toggle and sign-out) beside the scrolling page. The
 * builder and login render outside this frame - they own the whole viewport.
 * Collapses to an icon rail (<=1100px) then a bottom bar (<=780px).
 */
import { useEffect, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useTheme } from './theme.js';
import { clearToken } from './api.js';
import { ensureUplift, useUplift } from './uplift-store.js';
import { Icon, type IconName } from './ui/Icon.js';

/** The brand mark: two mirrored strokes forming an M, brand blue + cyan. */
function MetisMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="mRoyal" x1="10" y1="8" x2="88" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2f55c0" />
          <stop offset="1" stopColor="#4d76b8" />
        </linearGradient>
        <linearGradient id="mCyan" x1="90" y1="8" x2="12" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#57c8f2" />
          <stop offset="1" stopColor="#9cdded" />
        </linearGradient>
      </defs>
      <polyline points="17,92 15,13 85,89" stroke="url(#mRoyal)" strokeWidth="15" strokeLinejoin="miter" strokeMiterlimit="4" />
      <polyline points="83,92 85,13 15,89" stroke="url(#mCyan)" strokeWidth="15" strokeLinejoin="miter" strokeMiterlimit="4" />
      <line x1="36" y1="36" x2="64" y2="66" stroke="url(#mRoyal)" strokeWidth="15" />
    </svg>
  );
}

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'Overview', icon: 'grid' },
  { to: '/workflows', label: 'Workflows', icon: 'workflow' },
  { to: '/connectors', label: 'Connectors', icon: 'plug' },
  { to: '/operate', label: 'Operate', icon: 'play' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  // "Account" exists only when this instance has a cloud: the kill switch
  // ('disabled') removes the nav entry along with every other affordance.
  const cloud = useUplift((state) => state.cloud);
  useEffect(ensureUplift, []);
  const nav = cloud === 'disabled' ? NAV : [...NAV, { to: '/account', label: 'Account', icon: 'cloud' as IconName }];
  const signOut = () => {
    clearToken();
    navigate('/login', { replace: true });
  };
  return (
    <div className="app">
      <nav className="sidebar" aria-label="Primary">
        <NavLink to="/" className="brand" aria-label="Metis home">
          <MetisMark />
          <span className="brand-name">
            met<em>is</em>
          </span>
        </NavLink>
        <div className="side-nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' on' : ''}`}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
        <div className="side-foot">
          <button type="button" className="nav-item" onClick={toggle} aria-label="Switch theme">
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={18} />
            <span>{theme === 'light' ? 'Dark' : 'Light'} theme</span>
          </button>
          <button type="button" className="nav-item" onClick={signOut} aria-label="Sign out">
            <Icon name="logout" size={18} />
            <span>Sign out</span>
          </button>
        </div>
      </nav>
      {children}
    </div>
  );
}
