FROM docker.io/cloudflare/sandbox:0.7.2

ENV BUN_VERSION=1.3.5
ENV PATH="/root/.bun/bin:${PATH}"

# Install Bun and runtime requirements for Flint gateway/app servers.
RUN apt-get update \
    && apt-get install -y curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} \
    && bun --version

WORKDIR /workspace

# Copy workspace manifests and packages used by Flint runtime.
COPY package.json /workspace/package.json
COPY bun.lock /workspace/bun.lock
COPY apps /workspace/apps
COPY packages /workspace/packages

RUN bun install --frozen-lockfile

COPY apps/cloudflare-sandbox/scripts/start-flint-gateway.sh /usr/local/bin/start-flint-gateway.sh
RUN chmod +x /usr/local/bin/start-flint-gateway.sh \
    && mkdir -p /workspace/.data

EXPOSE 8788
