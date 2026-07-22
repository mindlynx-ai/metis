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
import { type CSSProperties } from 'react';

/** The connector's brand mark: a soft-washed tile with its initial. */
export function ConnMark({ name, color, size }: { name: string; color?: string; size?: 'lg' }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      className={`conn-mark${size === 'lg' ? ' conn-mark-lg' : ''}`}
      style={color ? ({ '--mark': color } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
