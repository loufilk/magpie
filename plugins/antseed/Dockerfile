ARG MAGPIE_IMAGE=ghcr.io/yetone/magpie:0.1.4755@sha256:da0c9c12e8d13cf6d629801a3165ebd6d718a1ffe429d56fac080890e8c89e96
FROM ${MAGPIE_IMAGE}

USER root
# Official Magpie 0.1.4755 includes Node 24 and npm. Compilers provide a
# fallback on architectures without the upstream native prebuilt modules.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ cmake \
    && rm -rf /var/lib/apt/lists/*
COPY . /opt/magpie-antseed
WORKDIR /opt/magpie-antseed
RUN npm_config_python=/usr/bin/python3 PYTHON=/usr/bin/python3 node --input-type=module -e "import {prepareManagedRuntime} from './lib/runtime.mjs'; await prepareManagedRuntime({dataRoot:'/tmp/antseed-image-build',runtimeDir:'/opt/antseed-runtime'});" \
    && chown -R 65532:65532 /opt/magpie-antseed /opt/antseed-runtime \
    && chmod 755 bin/docker-entrypoint.sh
ENV MAGPIE_ANTSEED_DATA_DIR=/config/antseed \
    MAGPIE_ANTSEED_RUNTIME_DIR=/opt/antseed-runtime \
    DO_NOT_TRACK=1 \
    MAGPIE_NO_STATS=1 \
    MAGPIE_ADDR=127.0.0.1:3425
USER nonroot
WORKDIR /config
ENTRYPOINT ["/opt/magpie-antseed/bin/docker-entrypoint.sh"]
CMD ["web", "--addr", "127.0.0.1:3430", "--no-open"]
