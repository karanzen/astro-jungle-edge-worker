# astro-jungle-edge-worker

Browser worker for **Astro Jungle Edge**, a competitive price-intelligence service for online retailers. It reads competitors' public product pages in a real browser (for shops that only render prices in JavaScript), and posts the prices to an Edge server. It runs on a free GitHub Actions schedule.

Configuration (which sites, which selectors) comes from the Edge server; the only things this repository holds are the worker script and the workflow. Keys are kept in repository secrets.

## Running locally

```
npm i playwright@1.47.0 && npx playwright install chromium
node edge-worker.mjs --endpoint https://YOUR-EDGE-SITE/wp-json/aje/v1 --key <source key> --concurrency 1 --verbose
```

Useful flags: `--url <page>` reads one page and prints what was found; `--limit N` stops after N products; `--debug` prints card HTML and saves a screenshot.

## About

Built by [Astro Jungle Corporation](https://astrojungles.com), an e-commerce growth company that runs its own stores, including [KlippiK](https://klippik.com), and builds tools like Edge for other retailers.
