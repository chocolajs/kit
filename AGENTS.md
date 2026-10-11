# ChocolaKit Coding Agent Guide

This guide is for AI coding agents working in ChocolaKit.

**Important:** Read and follow [`CONTRIBUTING.md`](./CONTRIBUTING.md) as well — it contains essential information about testing, code structure, and contribution guidelines that applies here.

When submitting a PR, you **MUST** read [`PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) and fill it out correctly. **DO NOT** submit a PR without running the full test suite.

## Project Structure

This repo is the ChocolaKit metaframework (dev server, SSR server, CLI) (`@chocolajs/kit`) for the Chocola UI library (`chocola`) wich  lives in its own repo.

- **Tests**: `tests/*.test.js` — run with `npm test`