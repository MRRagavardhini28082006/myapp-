const exampleSearch = document.querySelector('#example-search');
const categoryCards = document.querySelectorAll('.category-card');
const browsePanel = document.querySelector('#browse-panel');
const browseTitle = document.querySelector('#browse-title');
const browseDescription = document.querySelector('#browse-description');
const seriesFormats = document.querySelector('#series-formats');
const formatChips = document.querySelectorAll('.format-chip');
const languageChips = document.querySelectorAll('.language-chip');
const browseTitleSearch = document.querySelector('#browse-title-search');
const browseResults = document.querySelector('#browse-results');
const installApp = document.querySelector('#install-app');
const clearLanguage = document.querySelector('#clear-language');
const mobileNavItems = document.querySelectorAll('.mobile-nav-item');
const mobileSearch = document.querySelector('#mobile-search');
let selectedCategory = '';
let selectedLanguage = '';
let browseRequestId = 0;
let browseAbortController;
let titleSearchTimer;
let deferredInstallPrompt;

function setMobileTabActive(tab) {
  mobileNavItems.forEach((item) => {
    const active = item.dataset.tab === tab;
    item.classList.toggle('active', active);
    if (active) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

const mediaTypes = {
  all: '',
  series: 'TV series web series',
  movie: 'movie',
  drama: 'drama',
  webseries: 'web series',
  serial: 'serial',
  tv: 'TV show series',
  kdrama: 'K-drama',
  reality: 'reality show',
  documentary: 'documentary',
  anime: 'anime',
  family: 'kids family',
  sports: 'sports show',
  variety: 'variety talk show',
  miniseries: 'mini-series'
};

const categoryNames = {
  all: 'All movies, series & shows',
  movie: 'Movies',
  series: 'Series',
  tv: 'TV series',
  webseries: 'Web series',
  kdrama: 'K-dramas',
  drama: 'Drama',
  serial: 'TV serials',
  reality: 'Reality & talent shows',
  documentary: 'Documentaries',
  anime: 'Anime',
  family: 'Kids & family',
  sports: 'Sports shows',
  variety: 'Variety & talk shows',
  miniseries: 'Mini-series'
};

function escapeSparqlString(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\\"]/g, (character) => {
    if (character === '\\') {
      return '\\\\';
    }
    if (character === '"') {
      return '\\"';
    }
    if (character === '\n') {
      return '\\n';
    }
    if (character === '\r') {
      return '\\r';
    }
    if (character === '\t') {
      return '\\t';
    }
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

async function fetchBrowserJson(url, sourceName, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${sourceName} request failed with status ${response.status}`);
  }
  return response.json();
}

function getWikidataSearchLanguage(language) {
  const languageCodes = {
    Arabic: 'ar', Bengali: 'bn', Chinese: 'zh', English: 'en', French: 'fr',
    German: 'de', Gujarati: 'gu', Hindi: 'hi', Indonesian: 'id', Italian: 'it',
    Japanese: 'ja', Kannada: 'kn', Korean: 'ko', Malayalam: 'ml', Marathi: 'mr',
    Mandarin: 'zh', Persian: 'fa', Polish: 'pl', Portuguese: 'pt', Punjabi: 'pa',
    Russian: 'ru', Spanish: 'es', Swedish: 'sv', Tamil: 'ta', Telugu: 'te',
    Thai: 'th', Turkish: 'tr', Urdu: 'ur', Vietnamese: 'vi'
  };
  return languageCodes[language] || 'en';
}

async function searchWikidataByTitle({ category, language, title, signal }) {
  const searchUrl = new URL('https://www.wikidata.org/w/api.php');
  searchUrl.searchParams.set('action', 'wbsearchentities');
  searchUrl.searchParams.set('search', title);
  searchUrl.searchParams.set('language', getWikidataSearchLanguage(language));
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('limit', '50');
  searchUrl.searchParams.set('origin', '*');
  const searchData = await fetchBrowserJson(searchUrl, 'Wikidata title search', signal);
  if (!Array.isArray(searchData.search)) {
    throw new Error('Wikidata title search response has an unexpected format');
  }

  const hitsById = new Map();
  searchData.search.forEach((hit) => {
    if (hit && /^Q\d+$/.test(hit.id || '') && !hitsById.has(hit.id)) {
      hitsById.set(hit.id, hit);
    }
  });
  const ids = Array.from(hitsById.keys());
  if (!ids.length) {
    return { results: { bindings: [] } };
  }

  const typeIds = category === 'movie'
    ? 'wd:Q11424'
    : category === 'all'
      ? 'wd:Q11424 wd:Q5398426 wd:Q15416'
      : 'wd:Q5398426 wd:Q15416';
  const values = ids.map((id) => `wd:${id}`).join(' ');
  const languagePattern = language
    ? `?item wdt:P364 ?language. ?language rdfs:label "${escapeSparqlString(language)}"@en.`
    : '';
  const typeQuery = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?item ?type WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P31/wdt:P279* ?type.
  VALUES ?type { ${typeIds} }
  ${languagePattern}
}
LIMIT 50`;
  const typeUrl = new URL('https://query.wikidata.org/sparql');
  typeUrl.searchParams.set('query', typeQuery);
  typeUrl.searchParams.set('format', 'json');

  const entitiesUrl = new URL('https://www.wikidata.org/w/api.php');
  entitiesUrl.searchParams.set('action', 'wbgetentities');
  entitiesUrl.searchParams.set('ids', ids.join('|'));
  entitiesUrl.searchParams.set('props', 'labels|claims');
  entitiesUrl.searchParams.set('languages', `en|${getWikidataSearchLanguage(language)}`);
  entitiesUrl.searchParams.set('format', 'json');
  entitiesUrl.searchParams.set('origin', '*');

  const [typeData, entitiesData] = await Promise.all([
    fetchBrowserJson(typeUrl, 'Movie category search', signal),
    fetchBrowserJson(entitiesUrl, 'Movie details', signal)
  ]);
  const typeBindings = typeData.results && typeData.results.bindings;
  if (!Array.isArray(typeBindings) || !entitiesData.entities) {
    throw new Error('Wikidata movie search response has an unexpected format');
  }

  const typesById = new Map();
  typeBindings.forEach((binding) => {
    const itemId = binding.item && binding.item.value.split('/').pop();
    const typeId = binding.type && binding.type.value.split('/').pop();
    if (itemId && typeId && !typesById.has(itemId)) {
      typesById.set(itemId, typeId);
    }
  });

  const bindings = [];
  ids.forEach((id) => {
    const typeId = typesById.get(id);
    const entity = entitiesData.entities[id];
    if (!typeId || !entity) {
      return;
    }
    const labels = entity.labels || {};
    const englishLabel = labels.en && labels.en.value;
    const searchLanguage = getWikidataSearchLanguage(language);
    const itemLabel = englishLabel
      || (labels[searchLanguage] && labels[searchLanguage].value)
      || hitsById.get(id).label
      || id;
    const imageClaim = (entity.claims && entity.claims.P18 || []).find((claim) => (
      claim.mainsnak
      && claim.mainsnak.datavalue
      && typeof claim.mainsnak.datavalue.value === 'string'
    ));
    const imageName = imageClaim && imageClaim.mainsnak.datavalue.value;
    const imageUrl = imageName
      ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageName)}`
      : '';
    bindings.push({
      item: { value: `http://www.wikidata.org/entity/${id}` },
      itemLabel: { value: itemLabel },
      englishLabel: englishLabel ? { value: englishLabel } : undefined,
      type: { value: `http://www.wikidata.org/entity/${typeId}` },
      image: imageUrl ? { value: imageUrl } : undefined
    });
  });

  return { results: { bindings } };
}

async function fetchCatalogInBrowser(category, language, title, signal) {
  const typeIds = category === 'movie'
    ? 'wd:Q11424'
    : category === 'all'
      ? 'wd:Q11424 wd:Q5398426 wd:Q15416'
      : 'wd:Q5398426 wd:Q15416';
  const languagePattern = language
    ? `?language rdfs:label "${escapeSparqlString(language)}"@en. ?item wdt:P364 ?language.`
    : '';
  const typePattern = language
    ? '?item wdt:P31/wdt:P279* ?type.'
    : '?item wdt:P31 ?type.';
  const labelPattern = language
    ? `OPTIONAL { ?item rdfs:label ?englishLabel. FILTER(LANG(?englishLabel) = "en") }
  OPTIONAL {
    ?language wdt:P424 ?languageCode.
    ?item rdfs:label ?nativeLabel.
    FILTER(LANG(?nativeLabel) = ?languageCode)
  }
  BIND(COALESCE(?englishLabel, ?nativeLabel) AS ?itemLabel)`
    : '?item rdfs:label ?itemLabel. FILTER(LANG(?itemLabel) = "en")';
  const wikidataQuery = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?item ?itemLabel ?englishLabel ?type ?image WHERE {
  ${languagePattern}
  ${typePattern}
  VALUES ?type { ${typeIds} }
  ${labelPattern}
  OPTIONAL { ?item wdt:P18 ?image. }
  FILTER(BOUND(?itemLabel))
}
LIMIT 100`;
  const wikidataUrl = new URL('https://query.wikidata.org/sparql');
  wikidataUrl.searchParams.set('query', wikidataQuery);
  wikidataUrl.searchParams.set('format', 'json');

  const searchTerm = title || language;
  const tvMazePromise = category === 'movie' || !searchTerm
    ? Promise.resolve(null)
    : (() => {
      const url = new URL('https://api.tvmaze.com/search/shows');
      url.searchParams.set('q', searchTerm);
      return fetchBrowserJson(url, 'TV catalog', signal);
    })();
  const wikidataPromise = title
    ? searchWikidataByTitle({ category, language, title, signal })
    : fetchBrowserJson(wikidataUrl, 'Movie and TV catalog', signal);
  const [wikidataResult, tvMazeResult] = await Promise.allSettled([
    wikidataPromise,
    tvMazePromise
  ]);
  if (signal.aborted) {
    return Promise.reject(new DOMException('Catalog request was cancelled.', 'AbortError'));
  }

  const warnings = [];
  const wikidataData = wikidataResult.status === 'fulfilled' ? wikidataResult.value : null;
  const tvMazeMatches = tvMazeResult.status === 'fulfilled' ? tvMazeResult.value : null;
  if (wikidataResult.status === 'rejected') {
    console.error('Could not load movie and TV catalog results.', wikidataResult.reason);
    warnings.push('catalog_unavailable');
  }
  if (tvMazeResult.status === 'rejected') {
    console.error('Could not load TV show catalog results.', tvMazeResult.reason);
    warnings.push('tv_catalog_unavailable');
  }
  if (!wikidataData && !tvMazeMatches) {
    throw new Error('Both title catalogs are unavailable');
  }

  const wikidataItems = wikidataData && wikidataData.results && wikidataData.results.bindings;
  const itemsByName = new Map();
  if (Array.isArray(wikidataItems)) {
    const languagesByItem = new Map();
    if (!language && wikidataItems.length) {
      const itemIds = Array.from(new Set(wikidataItems
        .map((item) => item.item && item.item.value.split('/').pop())
        .filter((id) => /^Q\d+$/.test(id || ''))));
      if (itemIds.length) {
        const values = itemIds.map((id) => `wd:${id}`).join(' ');
        const languageQuery = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?item ?languageLabel WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P364 ?language.
  ?language rdfs:label ?languageLabel.
  FILTER(LANG(?languageLabel) = "en")
}`;
        const languageUrl = new URL('https://query.wikidata.org/sparql');
        languageUrl.searchParams.set('query', languageQuery);
        languageUrl.searchParams.set('format', 'json');
        try {
          const languageData = await fetchBrowserJson(languageUrl, 'Language metadata', signal);
          const bindings = languageData.results && languageData.results.bindings;
          if (!Array.isArray(bindings)) {
            throw new Error('Language metadata response has an unexpected format');
          }
          bindings.forEach((binding) => {
            const itemUri = binding.item && binding.item.value;
            const languageLabel = binding.languageLabel && binding.languageLabel.value;
            if (!itemUri || !languageLabel) {
              return;
            }
            if (!languagesByItem.has(itemUri)) {
              languagesByItem.set(itemUri, new Set());
            }
            languagesByItem.get(itemUri).add(languageLabel);
          });
        } catch (error) {
          if (error.name === 'AbortError') {
            throw error;
          }
          console.error('Could not load original-language labels.', error);
          warnings.push('language_metadata_unavailable');
        }
      }
    }

    wikidataItems.forEach((item) => {
      const name = item.itemLabel && item.itemLabel.value;
      if (!name) {
        return;
      }
      const typeId = item.type && item.type.value.split('/').pop();
      const type = typeId === 'Q11424'
        ? 'Movie'
        : typeId === 'Q5398426'
          ? 'TV series'
          : typeId === 'Q15416'
            ? 'TV show'
            : 'Title';
      const itemUri = item.item && item.item.value;
      const itemLanguages = languagesByItem.get(itemUri);
      const itemLanguage = language || (itemLanguages ? Array.from(itemLanguages).join(', ') : '');
      const key = name.toLowerCase();
      const existing = itemsByName.get(key);
      if (existing) {
        const languages = new Set([existing.language, itemLanguage].filter(Boolean).flatMap((value) => value.split(', ')));
        existing.language = Array.from(languages).join(', ');
        existing.image = existing.image || (item.image && item.image.value);
        existing.detailsUrl = existing.detailsUrl || itemUri;
        return;
      }
      itemsByName.set(key, {
        name,
        language: itemLanguage,
        type,
        image: item.image && item.image.value,
        detailsUrl: itemUri
      });
    });
  }

  if (Array.isArray(tvMazeMatches)) {
    tvMazeMatches.forEach((match) => {
      const show = match.show;
      if (!show || !show.name) {
        return;
      }
      if (language && String(show.language || '').toLowerCase() !== language.toLowerCase()) {
        return;
      }
      if (category === 'reality' && show.type !== 'Reality') {
        return;
      }
      if (category === 'serial' && show.type !== 'Scripted') {
        return;
      }
      const key = show.name.toLowerCase();
      const existing = itemsByName.get(key);
      if (existing) {
        existing.language = Array.from(new Set([existing.language, show.language].filter(Boolean).flatMap((value) => value.split(', ')))).join(', ');
        existing.type = show.type || existing.type;
        existing.image = existing.image || (show.image && show.image.medium);
        existing.detailsUrl = existing.detailsUrl || show.url;
        return;
      }
      itemsByName.set(key, {
        name: show.name,
        language: show.language || '',
        type: show.type || 'TV show',
        image: show.image && show.image.medium,
        detailsUrl: show.url || ''
      });
    });
  }

  return { items: Array.from(itemsByName.values()), warnings };
}

async function renderBrowse() {
  const requestId = ++browseRequestId;
  if (browseAbortController) {
    browseAbortController.abort();
  }
  browseAbortController = new AbortController();
  const title = browseTitleSearch.value.trim();
  const typeTerms = mediaTypes[selectedCategory] || '';
  const query = [selectedLanguage, title, typeTerms].filter(Boolean).join(' ');
  const availabilityUrl = new URL('https://www.justwatch.com/in/search');
  availabilityUrl.searchParams.set('q', query);
  availabilityUrl.searchParams.set('monetization_types', 'free');

  const clipsUrl = new URL('https://www.youtube.com/results');
  clipsUrl.searchParams.set('search_query', `${selectedLanguage} ${title} ${typeTerms} official trailer clip`.trim());
  const languageText = selectedLanguage || 'all languages';
  const categoryText = categoryNames[selectedCategory] || 'movies and shows';
  const heading = title
    ? `${title}${selectedLanguage ? ` — ${selectedLanguage} search` : ''}`
    : `${categoryText}${selectedLanguage ? ` in ${selectedLanguage}` : ' in all languages'}`;

  const availabilityDescription = selectedLanguage
    ? 'The selected language is included in this search. Use the provider’s Free filter and verify the audio language in the title details; availability directories may still show versions in other languages.'
    : 'This search covers all languages. Use the provider’s Free filter and verify the audio language in the title details.';
  const availabilityCard = `<article class="availability-card">
    <p class="section-kicker">FREE-FILTERED SEARCH · ${escapeHtml(languageText.toUpperCase())}</p>
    <h3>${escapeHtml(heading)}</h3>
    <p>${escapeHtml(availabilityDescription)}</p>
    <a class="button button-light" href="${escapeHtml(availabilityUrl.href)}" target="_blank" rel="noopener noreferrer">Browse free-filtered listings <span aria-hidden="true">↗</span></a>
    <a class="button button-muted" href="${escapeHtml(clipsUrl.href)}" target="_blank" rel="noopener noreferrer">Find official clips <span aria-hidden="true">↗</span></a>
  </article>`;

  browseResults.innerHTML = `<p class="status-message">Finding ${escapeHtml(languageText)} titles…</p>${availabilityCard}`;

  try {
    const catalogUrl = new URL('./api/catalog', window.location.href);
    catalogUrl.searchParams.set('category', selectedCategory || 'all');
    if (selectedLanguage) {
      catalogUrl.searchParams.set('language', selectedLanguage);
    }
    if (title) {
      catalogUrl.searchParams.set('title', title);
    }
    let catalogData;
    let usedBrowserFallback = false;
    try {
      const response = await fetch(catalogUrl, { signal: browseAbortController.signal });
      const backendData = await response.json();
      if (!response.ok) {
        throw new Error(backendData.error || `Catalog request failed with status ${response.status}`);
      }
      if (!backendData || !Array.isArray(backendData.items)) {
        throw new Error('Catalog response has an unexpected format');
      }
      catalogData = backendData;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw error;
      }
      console.warn('Catalog backend unavailable; trying public catalog sources directly.', error);
      catalogData = await fetchCatalogInBrowser(
        selectedCategory || 'all',
        selectedLanguage,
        title,
        browseAbortController.signal
      );
      usedBrowserFallback = true;
    }
    if (requestId !== browseRequestId) {
      return;
    }

    const titleResults = new Map();
    catalogData.items.forEach((item) => {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) {
        return;
      }
      titleResults.set(item.name.toLowerCase(), item);
    });

    const resultsHtml = Array.from(titleResults.values()).map((item) => {
      const itemAvailabilityUrl = new URL('https://www.justwatch.com/in/search');
      itemAvailabilityUrl.searchParams.set('q', [selectedLanguage, item.name, typeTerms].filter(Boolean).join(' '));
      itemAvailabilityUrl.searchParams.set('monetization_types', 'free');
      const imageUrl = getHttpsUrl(item.image);
      const detailsUrl = getHttpsUrl(item.detailsUrl);
      const fallbackImage = createPosterFallback(item.name);
      const imageSource = imageUrl || fallbackImage;
      const image = `<img class="show-result-image" src="${escapeHtml(imageSource)}" alt="" loading="lazy"${imageUrl ? ` data-fallback="${escapeHtml(fallbackImage)}"` : ''}>`;
      const detailsLink = detailsUrl
        ? `<a href="${escapeHtml(detailsUrl)}" target="_blank" rel="noopener noreferrer">Title details</a>`
        : '';

      return `<article class="show-result-card">
        ${image}
        <div class="show-result-content">
          <h3>${escapeHtml(item.name)}</h3>
          <p>${escapeHtml([item.language, item.type].filter(Boolean).join(' · '))}</p>
          <a class="button button-light" href="${escapeHtml(itemAvailabilityUrl.href)}" target="_blank" rel="noopener noreferrer">Check free listings <span aria-hidden="true">↗</span></a>
          ${detailsLink}
        </div>
      </article>`;
    }).join('');

    const resultsScope = selectedLanguage
      ? `${selectedLanguage} ${selectedCategory === 'all' ? 'movies and shows' : categoryText}`
      : `${categoryText} in all languages`;
    const resultsHeading = titleResults.size
      ? `<h3 class="show-results-heading">${escapeHtml(resultsScope)}</h3><div class="show-results-grid">${resultsHtml}</div>`
      : `<p class="empty-note">No ${escapeHtml(languageText)} titles matched${title ? ` “${escapeHtml(title)}”` : ''}. Try another title or check the availability listing below.</p>`;
    const warningMessages = [];
    if (usedBrowserFallback) {
      warningMessages.push('The app server is unavailable; results were loaded directly from public catalog services.');
    }
    if (Array.isArray(catalogData.warnings)) {
      if (catalogData.warnings.includes('language_metadata_unavailable')) {
        warningMessages.push('Some original-language labels could not be loaded.');
      }
      if (catalogData.warnings.includes('catalog_unavailable') || catalogData.warnings.includes('tv_catalog_unavailable')) {
        warningMessages.push('Some catalog sources are temporarily unavailable, so results may be incomplete.');
      }
      if (catalogData.warnings.includes('tmdb_unavailable')) {
        warningMessages.push('TMDb artwork is temporarily unavailable; some titles may use generated covers.');
      }
      if (catalogData.warnings.includes('tmdb_not_configured')) {
        warningMessages.push('Configure TMDB_API_KEY on the app server to load real movie posters where available.');
      }
    }
    const warningNote = warningMessages.length
      ? `<p class="status-message">${escapeHtml(warningMessages.join(' '))}</p>`
      : '';
    browseResults.innerHTML = `${resultsHeading}${availabilityCard}${warningNote}<p class="language-note">Provider availability and audio tracks should be confirmed before watching.</p>`;
    browseResults.querySelectorAll('.show-result-image[data-fallback]').forEach((image) => {
      image.addEventListener('error', () => {
        image.src = image.dataset.fallback;
        image.removeAttribute('data-fallback');
      }, { once: true });
    });
  } catch (error) {
    if (requestId !== browseRequestId) {
      return;
    }
    console.error('Could not load matching TV show results.', error);
    browseResults.innerHTML = `<p class="status-message">Title results could not be loaded: ${escapeHtml(error.message)} Check your connection and try again.</p>${availabilityCard}`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function getHttpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
    }
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function createPosterFallback(title) {
  const palettes = [
    ['#271153', '#d63f68'],
    ['#102f45', '#d16a38'],
    ['#183b34', '#bf3d63'],
    ['#382344', '#d18b36'],
    ['#172d55', '#7b3ea6']
  ];
  const seed = Array.from(title).reduce((total, character) => total + character.charCodeAt(0), 0);
  const [startColor, endColor] = palettes[seed % palettes.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 260">
  <defs>
    <linearGradient id="poster" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${startColor}"/>
      <stop offset="1" stop-color="${endColor}"/>
    </linearGradient>
    <radialGradient id="glow">
      <stop stop-color="#fff" stop-opacity=".22"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="180" height="260" fill="url(#poster)"/>
  <circle cx="142" cy="72" r="92" fill="url(#glow)"/>
  <path d="M0 204 180 111v149H0z" fill="#080b17" fill-opacity=".38"/>
  <rect x="11" y="11" width="158" height="238" rx="4" fill="none" stroke="#fff" stroke-opacity=".38"/>
  <text x="90" y="38" fill="#fff" fill-opacity=".8" font-family="Arial,sans-serif" font-size="8" letter-spacing="2" text-anchor="middle">TAMILFLIX PRESENTS</text>
  <path d="M76 85h28l-14 24z" fill="#fff" fill-opacity=".86"/>
  <text x="90" y="172" fill="#fff" font-family="Arial,sans-serif" font-size="15" font-weight="700" text-anchor="middle" textLength="145" lengthAdjust="spacingAndGlyphs">${escapeHtml(title)}</text>
  <text x="90" y="191" fill="#fff" fill-opacity=".72" font-family="Arial,sans-serif" font-size="7" letter-spacing="2" text-anchor="middle">MOVIE COLLECTION</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

exampleSearch.addEventListener('click', () => {
  document.querySelector('.category-movies').click();
  browseTitleSearch.value = 'Jailer';
  renderBrowse();
  browseTitleSearch.focus();
});

mobileNavItems.forEach((item) => {
  if (item.tagName === 'A') {
    item.addEventListener('click', () => setMobileTabActive(item.dataset.tab));
  }
});

mobileSearch.addEventListener('click', () => {
  document.querySelector('.category-card[data-type="all"]').click();
  setMobileTabActive('search');
  browseTitleSearch.focus();
});

categoryCards.forEach((card) => {
  card.addEventListener('click', () => {
    setMobileTabActive('browse');
    selectedCategory = card.dataset.type === 'tv' ? 'series' : card.dataset.type;
    browseTitleSearch.value = '';
    browsePanel.classList.remove('hidden');
    browseTitle.textContent = `Browse ${categoryNames[selectedCategory] || 'shows'}`;
    if (selectedCategory === 'series') {
      browseDescription.textContent = 'Explore every series format below, then choose the language you want to watch in.';
    } else if (selectedCategory === 'all') {
      browseDescription.textContent = 'Browse movies and shows in every language, or choose a language below to filter the results.';
    } else if (selectedCategory === 'reality') {
      browseDescription.textContent = 'Find reality and talent shows such as Bigg Boss in all languages, or filter by language.';
    } else {
      browseDescription.textContent = `Browse ${categoryNames[selectedCategory] || 'titles'} in all languages, or filter by language.`;
    }
    browseTitleSearch.placeholder = selectedCategory === 'reality'
      ? 'Try Bigg Boss or enter a title'
      : 'Try Bigg Boss or a movie title';
    seriesFormats.classList.toggle('hidden', !['series', 'tv', 'webseries', 'kdrama', 'serial'].includes(selectedCategory));
    formatChips.forEach((chip) => {
      const active = chip.dataset.format === selectedCategory;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    languageChips.forEach((chip) => {
      const active = chip.dataset.language === selectedLanguage;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
    clearLanguage.classList.toggle('hidden', !selectedLanguage);
    renderBrowse();
    browsePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

formatChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    selectedCategory = chip.dataset.format;
    formatChips.forEach((item) => {
      const active = item === chip;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    browseTitle.textContent = `Browse ${categoryNames[selectedCategory] || 'series'}`;
    browseDescription.textContent = `Browse ${categoryNames[selectedCategory] || 'series'} in all languages, or filter by language.`;
    browseTitleSearch.value = '';
    renderBrowse();
  });
});

languageChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    selectedLanguage = chip.dataset.language;
    languageChips.forEach((item) => {
      const active = item === chip;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    clearLanguage.classList.toggle('hidden', !selectedLanguage);
    renderBrowse();
  });
});

clearLanguage.addEventListener('click', () => {
  selectedLanguage = '';
  languageChips.forEach((chip) => {
    chip.classList.remove('active');
    chip.setAttribute('aria-pressed', 'false');
  });
  clearLanguage.classList.add('hidden');
  renderBrowse();
});

browseTitleSearch.addEventListener('input', () => {
  window.clearTimeout(titleSearchTimer);
  titleSearchTimer = window.setTimeout(renderBrowse, 450);
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installApp.classList.remove('hidden');
});

installApp.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    return;
  }

  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      installApp.classList.add('hidden');
    }
    deferredInstallPrompt = null;
  } catch (error) {
    console.error('Could not open the app installation prompt.', error);
  }
});

if ('serviceWorker' in navigator) {
  const hadControllerAtStartup = Boolean(navigator.serviceWorker.controller);
  let reloadedForServiceWorkerUpdate = false;
  let lastServiceWorkerUpdateCheck = 0;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadControllerAtStartup && !reloadedForServiceWorkerUpdate) {
      reloadedForServiceWorkerUpdate = true;
      window.location.reload();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        const checkForUpdates = () => {
          if (document.visibilityState !== 'visible' || Date.now() - lastServiceWorkerUpdateCheck < 5 * 60 * 1000) {
            return;
          }

          lastServiceWorkerUpdateCheck = Date.now();
          registration.update()
            .catch((error) => console.error('Could not check for app updates.', error));
        };

        checkForUpdates();
        document.addEventListener('visibilitychange', checkForUpdates);
      })
      .catch((error) => console.error('Could not register the app service worker.', error));
  });
}
