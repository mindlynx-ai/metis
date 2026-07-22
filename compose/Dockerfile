# Copyright 2026 Seillen Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# The Metis image: build the workspace, then run the control plane and
# worker against the compose Temporal service. SQLite lives in the
# mounted /data volume.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
RUN mkdir -p /data
EXPOSE 3000
# The container entrypoint boots the runtime against the compose
# Temporal service and serves the editor and API on port 3000.
CMD ["node", "packages/metis-cli/dist/compose-entry.js"]
