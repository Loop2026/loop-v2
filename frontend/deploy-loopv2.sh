#!/bin/bash
# Deploy Loop v2 (dashboard clienti) su Netlify — sempre sul sito giusto, da qualsiasi cartella.
set -e
cd "$(dirname "$0")"
npx netlify-cli deploy --prod --dir=. --site=53ecf2e7-3a93-4eac-9fdb-cfd9bbe53a7b
