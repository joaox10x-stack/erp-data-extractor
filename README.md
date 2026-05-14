# ERP Data Extractor

Automated browser-based scraper for ERP systems.
Captures modal screenshots and extracts phone numbers via OCR.

## Scripts

- `src/scraper.mjs` — logs into the ERP, filters records, takes screenshots and saves declaration images
- `src/extract-phones.cjs` — runs OCR on declaration images, parses phone numbers, POSTs to a webhook

## Requirements

- Node.js >= 18
- Chromium (installed via Playwright)

## Setup

    npm install
    npm run install:playwright
    cp .env.example .env

## Tech stack

- Playwright — browser automation
- Tesseract.js — OCR
- node-fetch — HTTP client

## License

MIT
