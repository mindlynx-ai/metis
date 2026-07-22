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
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from './api.js';

export function LoginPage() {
  const [userId, setUserId] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  return (
    <main className="shell-main login-main" aria-label="Sign in">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          api
            .login(userId, secret)
            .then(() => navigate('/'))
            .catch((cause: unknown) => {
              setError(cause instanceof ApiError ? cause.message : 'could not sign in');
            });
        }}
      >
        <div className="login-brand">
          <span className="login-wordmark" aria-hidden="true">
            met<span className="wordmark-tail">is</span>
          </span>
          <h1 className="login-title">Welcome back</h1>
          <p className="login-tag">The open workflow engine. Sign in to build and run.</p>
        </div>
        <div className="field">
          <label htmlFor="userId">User</label>
          <input
            id="userId"
            value={userId}
            autoComplete="username"
            onChange={(event) => setUserId(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="secret">Password</label>
          <input
            id="secret"
            type="password"
            value={secret}
            autoComplete="current-password"
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="login-error">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary">
          Sign in
        </button>
      </form>
    </main>
  );
}
