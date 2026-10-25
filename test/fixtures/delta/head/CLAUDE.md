# Project root

This repo holds the API and the web client.
Both ship from one pipeline, so a broken
build blocks every package.

`Node version`: 20

## Build and test

Run `npm ci` then `npm test`. Do not skip the lint step.
Keep changes scoped to one package per PR.
