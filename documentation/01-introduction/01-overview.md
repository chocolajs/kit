---
title: Overview
description: What is ChocolaKit and why use it
---

## What is ChocolaKit?

ChocolaKit is the official lightweight framework to create web apps using [Chocola](https://chocolajs.dev).

This package features a fully functional modern framework with SSG, SSR/CSR, dev server, CLI, and more useful tools, with minimal dependencies and no third-party tooling (e.g. Vite, Rollup, etc.), providing an ultrafast and easy way to build your Chocola web apps.

## What is Chocola?

Chocola is a JavaScript library for building single-file components (SFCs) — a single `.chjs` file containing your template, logic, and styles.

Components become part of an app through explicit JavaScript imports. ChocolaKit passes those imports to the Chocola compiler, which builds one module graph per page and turns it into vanilla JavaScript, scoped CSS, and ESM runtime chunks.

## Learn the difference

To choose the right tool for your project, it helps to understand how Chocola and ChocolaKit complement each other:

- **Chocola** is the core library responsible for module-graph construction, single-file component compilation, and rendering, turning your `.chjs` components into vanilla JavaScript web apps.
- **ChocolaKit** is the full-featured framework built on top of Chocola that provides the surrounding infrastructure—such as file-based routing, SSG, SSR/CSR, a development server, and a CLI—so you don't have to configure third-party tooling yourself.

In short, use **Chocola** if you want to build components or integrate the compilation library into an existing setup, and use ChocolaKit when you want a complete, ready-to-go development environment and production framework for your web applications.
