---
title: CTP Evidence Lab
emoji: 🔎
colorFrom: blue
colorTo: indigo
sdk: static
pinned: false
short_description: Transparent claim-evidence review prototype
---

# CTP Evidence Lab

A static, browser-only demonstration of **CTP (Contradiction-to-Proof)**: recording a claim, a source excerpt, a user-assessed relationship, and explicit limitations.

## What it does
- Records a claim and the evidence excerpt supplied by the user.
- Labels the entered relationship as supported, contradicted, or insufficient.
- Shows an audit record and permits exporting the session as JSON.
- Explicitly marks records as not independently verified (verified_fixed: false).

## What it does not do
- Does not fetch URLs, authenticate sources, or use an AI model.
- Does not independently determine whether a claim is true.
- Does not store records on a server; the session exists in the current browser page.
- Does not treat a user-selected relationship as proof.

## Deploy
This is a single-file static web app. Serve index.html from any static host or upload it to a Hugging Face Static Space.

## Safety and scientific scope
The demo separates submitted evidence from independent verification. Do not use it as an automated fact-checker or operational decision system without source validation, reproducible tests, and independent review.
