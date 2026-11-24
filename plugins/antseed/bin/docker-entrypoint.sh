#!/bin/sh
set -eu

# Use the official image's config directory. Add is idempotent and a local
# plugin has no package installation step in Magpie's Bun host.
/magpie plugin add /opt/magpie-antseed
node /opt/magpie-antseed/bin/docker-settings.mjs
exec /magpie "$@"
