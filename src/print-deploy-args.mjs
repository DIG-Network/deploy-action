#!/usr/bin/env node
// Entrypoint: the composite action shells into this to build the `digstore
// deploy` argv (src/deploy-args.mjs's tested branch logic) from the step's
// IN_* env vars, then prints each arg NUL-separated on stdout so the bash step
// can load it into an array (`mapfile -d '' -t args < <(node …)`) without any
// re-tokenizing/quoting hazard — a value containing spaces or newlines (e.g.
// `message`) survives intact.

import { buildDeployArgs } from "./deploy-args.mjs";

const args = buildDeployArgs({
  preview: process.env.IN_PREVIEW === "true",
  directory: process.env.IN_DIRECTORY || "",
  ifChanged: process.env.IN_IF_CHANGED === "true",
  storeId: process.env.IN_STORE_ID || "",
  remote: process.env.IN_REMOTE || "",
  message: process.env.IN_MESSAGE || "",
  buildCommand: process.env.IN_BUILD_COMMAND || "",
  waitTimeout: process.env.IN_WAIT_TIMEOUT || "",
});

process.stdout.write(args.join("\0") + "\0");
