---
title: FAQ
description: Frequently asked questions about ChocolaKit
---

## General

### What is ChocolaKit?
ChocolaKit is a full-stack web framework for building static sites, SSR applications, and developer tools with a focus on simplicity and performance.

### Who maintains ChocolaKit?
As of now, ChocolaKit is maintained by only me ([@sadgabi20](https://github.com/sadgabi20)), but since it is intended to be a community-driven project, a striving ChocolaJS community and a team (including me) may maintain it in the future..

## Getting Started

### How do I install ChocolaKit?
```sh
npm i -g chocola
```
Or use it as a dev dependency:
```sh
npm i -D chocola
```

### What's the difference between `chocola` and `chjs`?
Both commands are available after installation. `chocola` is the main CLI, while `chjs` is an alias for the same binary.

## Development

### How do I start development mode?
```sh
chocola dev
```
This starts a dev server with hot-reload at `http://localhost:3000` by default.

### How do I change the dev server port?
```sh
chocola dev --port 5173
```

### How do I build for production?
```sh
chocola build
```

### How do I customize the build output directory?
```sh
chocola build --outDir ./dist
```

## Configuration

### How do I configure middleware?
Middleware is configured via `chocola.config.json`:
```json
{
  "server": {
    "middleware": "./middleware.js"
  }
}
```

## Deployment

### How do I deploy to production?
Use the SSR server:
```sh
chocola serve
```

### How do I deploy to containers?
Set the `PORT` environment variable:
```sh
PORT=8080 chocola serve --host 0.0.0.0
```

## Troubleshooting

### "command not found: chocola"
Ensure you've installed ChocolaKit globally: `npm i -g chocola`

### Hot-reload not working
Ensure you're running `chocola dev` (not `chocola build`) and that file changes trigger the polling mechanism.

### Production build fails
Check that your `chocola.config.json` is valid JSON and that all configured paths exist.