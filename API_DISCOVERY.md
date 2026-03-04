## Selected API
- Endpoint (listings): `POST https://candidat.francetravail.fr/offres/recherche.rechercheoffre:afficherplusderesultats/{start}-{end}/0?{query}`
- Endpoint (details): `POST https://candidat.francetravail.fr/offres/recherche.rechercheoffre.voletdetail:chargerdetail?{query}&idOffre={offerId}&indexFin=0&navigation=`
- Method: `POST`
- Auth: No token required, but session cookies are required (bootstrap with initial search page request)
- Pagination: Range-based (`0-19`, `20-39`, `40-59`, ...)
- Fields available (listings `initOver`): `id`, `title`, `subtitle/company`, `description`, `subdescription/date`, `address`, `contract`, `coordonnees.lat`, `coordonnees.lon`
- Fields available (detail): full offer detail block containing salary, contract/work hours, long description, experience, education, skills, languages, qualification, sector
- Fields currently missing in actor before this update: reliable listing lat/lon, stable listing metadata from `initOver`, high-throughput detail collection (concurrent + batched)
- Field count:
  - Listing API: ~10 direct fields per result
  - Listing + detail flow: 15+ output fields per record (depending on source completeness)

## Scoring (Apify Updater rubric)
- Returns JSON directly: **+30** (`_tapestry` JSON payload)
- Has >15 unique fields: **+25** (listing + detail extraction)
- No auth required: **+20** (cookie session only, no OAuth/API key)
- Has pagination support: **+15** (range-based endpoint)
- Matches/extends current fields: **+10**

**Total score: 100 / 100**

## Why this API pair was selected
1. It is stable and available without partner API credentials.
2. It is materially faster than DOM-only crawling because listing data comes from structured JSON and details can be fetched concurrently.
3. It supports batch dataset writes and low-noise logs while preserving existing actor inputs.
