# France Travail Scraper

Scrape job listings from **France Travail** (formerly Pôle Emploi) — the French national employment agency. Extract structured job data including title, company, location, salary, contract type, description, skills, experience requirements, and more.

## Features

- Search jobs by keyword, location, and radius
- Filter by contract type (CDI, CDD, Intérim, etc.)
- Collect detailed job information from individual offer pages
- Automatic pagination to gather large datasets
- Batched dataset writes for faster large runs
- Cleaner records by omitting null and empty fields by default
- Export data in JSON, CSV, Excel, or connect via API
- Built-in proxy support for reliable data collection

---

## Use Cases

- **Job market research** — Analyze employment trends across French regions
- **Salary benchmarking** — Compare salary ranges by role, sector, and location
- **HR and recruitment** — Discover active job postings from competitors
- **Academic research** — Study labor market dynamics, skill demand, and sector growth
- **Career planning** — Monitor job openings matching your profile

---

## Input Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `startUrl` | string | A specific France Travail search URL to start from | — |
| `keyword` | string | Job search keyword(s), e.g., "admin", "développeur" | `admin` |
| `location` | string | Location filter, e.g., "Paris", "Lyon" | — |
| `radius` | integer | Search radius in km | `10` |
| `contractType` | string | Filter by contract: CDI, CDD, Intérim, etc. | — |
| `collectDetails` | boolean | Visit detail pages for full job info | `true` |
| `results_wanted` | integer | Maximum number of results to collect | `20` |
| `max_pages` | integer | Maximum listing pages to visit | `10` |
| `detail_concurrency` | integer | Parallel detail requests (1-20) | `8` |
| `push_batch_size` | integer | Number of records pushed per dataset batch | `25` |
| `omit_null_values` | boolean | Remove null/empty fields from each record | `true` |
| `proxyConfiguration` | object | Proxy settings (residential recommended) | Apify Proxy |

---

## Output Data

Each job listing contains the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `job_title` | string | Job title |
| `offer_id` | string | France Travail offer reference number |
| `company` | string | Employer name |
| `location` | string | Department and city (e.g., "33 - BORDEAUX") |
| `contract_type` | string | CDI, CDD, Intérim, etc. |
| `work_hours` | string | Temps plein, Temps partiel |
| `salary` | string | Salary details (annual, monthly, or hourly) |
| `date_posted` | string | Publication date |
| `description_text` | string | Full job description (plain text) |
| `description_html` | string | Full job description (HTML) |
| `experience` | string | Required experience |
| `formation` | string | Required education or training |
| `skills` | array | Required competencies |
| `languages` | array | Required languages |
| `qualification` | string | Qualification level |
| `sector` | string | Industry sector |
| `latitude` | number | Job latitude when available |
| `longitude` | number | Job longitude when available |
| `url` | string | Direct link to the job offer |

---

## Usage Examples

### Search by keyword

```json
{
    "keyword": "développeur web",
    "results_wanted": 50
}
```

### Search with location and radius

```json
{
    "keyword": "comptable",
    "location": "Paris",
    "radius": 20,
    "results_wanted": 100
}
```

### Use a specific search URL

```json
{
    "startUrl": "https://candidat.francetravail.fr/offres/recherche?motsCles=admin&offresPartenaires=true&rayon=10&tri=0",
    "results_wanted": 30
}
```

### Quick URL-only mode (no detail pages)

```json
{
    "keyword": "infirmier",
    "collectDetails": false,
    "results_wanted": 200
}
```

---

## Sample Output

```json
{
    "job_title": "Secrétaire administratif et financier (H/F)",
    "offer_id": "204WBLS",
    "company": "SOCIETE D'APPLICATION DES GAZ POUR L'IND",
    "location": "42 - ST ETIENNE",
    "contract_type": "CDI",
    "work_hours": "Temps plein",
    "salary": "Annuel de 28000.00 Euros à 33000.00 Euros sur 12 mois",
    "date_posted": "03 mars 2026",
    "description_text": "OBJET DU POSTE - Accueil - Administration générale - Réaliser et suivre les commandes fournisseurs...",
    "experience": "3 An(s)",
    "formation": "Bac+2 ou équivalents Secrétariat assistanat gestion PME PMI",
    "skills": [
        "Maitrise d'Excel",
        "Notions comptables",
        "Classer des documents",
        "Gestion administrative du courrier"
    ],
    "languages": ["Anglais"],
    "qualification": "Employé qualifié",
    "sector": "Fabrication d'autres machines d'usage général",
    "latitude": 45.418831,
    "longitude": 4.420513,
    "url": "https://candidat.francetravail.fr/offres/recherche/detail/204WBLS"
}
```

---

## Tips

- **Use residential proxies** for most reliable results — France Travail may block datacenter IPs
- **Set a reasonable `results_wanted`** to control costs and run time
- **Enable `collectDetails`** for complete job information including salary, skills, and experience
- **Disable `collectDetails`** for faster runs when you only need job titles and URLs
- **Use `startUrl`** to scrape results from a pre-filtered search on the France Travail website

---

## Integrations

Connect this scraper with other Apify tools:

- **Google Sheets** — Automatically export job data to a spreadsheet
- **Slack / Email** — Get notified when new jobs match your criteria
- **Zapier / Make** — Build automated workflows with scraped data
- **API** — Access results programmatically via the Apify REST API

---

## FAQ

**How many jobs can I scrape?**
You can scrape thousands of listings. Use `results_wanted` to set your limit.

**Does this scraper handle pagination?**
Yes, it automatically loads additional pages until your `results_wanted` limit or `max_pages` cap is reached.

**Can I filter by contract type?**
Yes, use the `contractType` input or include the filter in your `startUrl`.

**Is the data in French?**
Yes, France Travail is a French platform and all job listings are in French.

**How often is the data updated?**
France Travail updates listings in real time. Run the scraper as often as needed for fresh data.

---

## Legal Notice

This scraper is designed for personal use, academic research, and legitimate business purposes. Please scrape responsibly and comply with France Travail's terms of service. The scraper does not collect any personal data of job seekers.
