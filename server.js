'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const catalogCache = new Map();

const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/stile.css', ['stile.css', 'text/css; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/tamilflix.webmanifest', ['tamilflix.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/tamilflix-icon.svg', ['tamilflix-icon.svg', 'image/svg+xml']],
  ['/tamilflix-icon-192.png', ['tamilflix-icon-192.png', 'image/png']],
  ['/tamilflix-icon-512.png', ['tamilflix-icon-512.png', 'image/png']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']]
]);

const CATEGORY_TYPE_IDS = {
  all: ['Q11424', 'Q5398426', 'Q15416'],
  movie: ['Q11424'],
  series: ['Q5398426', 'Q15416'],
  tv: ['Q5398426', 'Q15416'],
  webseries: ['Q5398426', 'Q15416'],
  kdrama: ['Q5398426', 'Q15416'],
  serial: ['Q5398426', 'Q15416'],
  reality: ['Q5398426', 'Q15416'],
  documentary: ['Q5398426', 'Q15416'],
  anime: ['Q5398426', 'Q15416'],
  family: ['Q5398426', 'Q15416'],
  sports: ['Q5398426', 'Q15416'],
  variety: ['Q5398426', 'Q15416'],
  miniseries: ['Q5398426', 'Q15416']
};

const LANGUAGE_CODES = {
  Arabic: 'ar', Bengali: 'bn', Chinese: 'zh', English: 'en', French: 'fr',
  German: 'de', Gujarati: 'gu', Hindi: 'hi', Indonesian: 'id', Italian: 'it',
  Japanese: 'ja', Kannada: 'kn', Korean: 'ko', Malayalam: 'ml', Marathi: 'mr',
  Mandarin: 'zh', Persian: 'fa', Polish: 'pl', Portuguese: 'pt', Punjabi: 'pa',
  Russian: 'ru', Spanish: 'es', Swedish: 'sv', Tamil: 'ta', Telugu: 'te',
  Thai: 'th', Turkish: 'tr', Urdu: 'ur', Vietnamese: 'vi'
};

const LANGUAGE_NAMES = Object.fromEntries(
  Object.entries(LANGUAGE_CODES).map(([name, code]) => [code, name])
);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function escapeSparqlLiteral(value) {
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

function getWikidataQuery(category, language) {
  const typeIds = CATEGORY_TYPE_IDS[category].map((id) => `wd:${id}`).join(' ');
  const languagePattern = language
    ? `?language rdfs:label "${escapeSparqlLiteral(language)}"@en. ?item wdt:P364 ?language.`
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

  return `PREFIX wd: <http://www.wikidata.org/entity/>
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
}

function getWikidataUrl(query) {
  const url = new URL('https://query.wikidata.org/sparql');
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');
  return url;
}

async function fetchJson(url, sourceName) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/sparql-results+json, application/json',
      'User-Agent': 'TamilFlix/1.0 (catalog search)'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    throw new Error(`${sourceName} request failed with status ${response.status}`);
  }
  return response.json();
}

function getWikidataSearchLanguage(language) {
  return LANGUAGE_CODES[language] || 'en';
}

async function searchWikidataByTitle({ category, language, title }) {
  const searchUrl = new URL('https://www.wikidata.org/w/api.php');
  searchUrl.searchParams.set('action', 'wbsearchentities');
  searchUrl.searchParams.set('search', title);
  searchUrl.searchParams.set('language', getWikidataSearchLanguage(language));
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('limit', '50');
  const searchData = await fetchJson(searchUrl, 'Wikidata title search');
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

  const values = ids.map((id) => `wd:${id}`).join(' ');
  const typeIds = CATEGORY_TYPE_IDS[category].map((id) => `wd:${id}`).join(' ');
  const languagePattern = language
    ? `?item wdt:P364 ?language. ?language rdfs:label "${escapeSparqlLiteral(language)}"@en.`
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
  const typeUrl = getWikidataUrl(typeQuery);
  const entitiesUrl = new URL('https://www.wikidata.org/w/api.php');
  entitiesUrl.searchParams.set('action', 'wbgetentities');
  entitiesUrl.searchParams.set('ids', ids.join('|'));
  entitiesUrl.searchParams.set('props', 'labels|claims');
  entitiesUrl.searchParams.set('languages', `en|${getWikidataSearchLanguage(language)}`);
  entitiesUrl.searchParams.set('format', 'json');

  const [typeData, entitiesData] = await Promise.all([
    fetchJson(typeUrl, 'Movie category search'),
    fetchJson(entitiesUrl, 'Movie details')
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
    const itemLabel = englishLabel
      || (labels[getWikidataSearchLanguage(language)] && labels[getWikidataSearchLanguage(language)].value)
      || hitsById.get(id).label;
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

async function getTmdbCatalog({ language, title }) {
  const apiKey = (process.env.TMDB_API_KEY || '').trim();
  if (!apiKey) {
    return null;
  }

  const languageCode = LANGUAGE_CODES[language] || '';
  const pages = title ? [1] : [1, 2, 3, 4, 5];
  const responses = await Promise.all(pages.map(async (page) => {
    const url = new URL(title
      ? 'https://api.themoviedb.org/3/search/movie'
      : 'https://api.themoviedb.org/3/discover/movie');
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('language', 'en-US');
    url.searchParams.set('include_adult', 'false');
    url.searchParams.set('region', 'IN');
    url.searchParams.set('page', String(page));
    if (title) {
      url.searchParams.set('query', title);
    } else {
      url.searchParams.set('sort_by', 'popularity.desc');
      if (languageCode) {
        url.searchParams.set('with_original_language', languageCode);
      }
    }

    const data = await fetchJson(url, 'TMDb movie catalog');
    if (!Array.isArray(data.results)) {
      throw new Error('TMDb response has an unexpected format');
    }
    return data.results;
  }));
  const seenIds = new Set();
  const items = responses.flat().flatMap((movie) => {
    if (!movie || !movie.id || !movie.title || seenIds.has(movie.id)) {
      return [];
    }
    if (languageCode && movie.original_language !== languageCode) {
      return [];
    }
    seenIds.add(movie.id);
    return [{
      name: movie.title,
      language: LANGUAGE_NAMES[movie.original_language] || movie.original_language || '',
      type: 'Movie',
      image: movie.poster_path
        ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
        : '',
      detailsUrl: `https://www.themoviedb.org/movie/${movie.id}`
    }];
  });

  return { items, warnings: [] };
}

function cacheCatalogPayload(cacheKey, payload) {
  if (catalogCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = catalogCache.keys().next().value;
    if (oldestKey) {
      catalogCache.delete(oldestKey);
    }
  }
  catalogCache.set(cacheKey, { createdAt: Date.now(), payload });
  return payload;
}

function addLanguage(languageMap, itemUri, language) {
  if (!itemUri || !language) {
    return;
  }
  if (!languageMap.has(itemUri)) {
    languageMap.set(itemUri, new Set());
  }
  languageMap.get(itemUri).add(language);
}

function setTitle(itemsByName, item) {
  const key = item.name.toLowerCase();
  const existing = itemsByName.get(key);
  if (existing) {
    const languages = new Set(
      [existing.language, item.language]
        .filter(Boolean)
        .flatMap((language) => language.split(', '))
    );
    existing.language = Array.from(languages).join(', ');
    if (!existing.image && item.image) {
      existing.image = item.image;
    }
    if (item.type && item.source === 'tvmaze') {
      existing.type = item.type;
    }
    if (!existing.detailsUrl && item.detailsUrl) {
      existing.detailsUrl = item.detailsUrl;
    }
    return;
  }
  itemsByName.set(key, {
    name: item.name,
    language: item.language || '',
    type: item.type || 'Title',
    image: item.image || '',
    detailsUrl: item.detailsUrl || ''
  });
}

async function getLanguageLabels(items) {
  const itemIds = Array.from(new Set(items
    .map((item) => item.item && item.item.value.split('/').pop())
    .filter((id) => /^Q\d+$/.test(id || ''))));
  if (!itemIds.length) {
    return new Map();
  }

  const values = itemIds.map((id) => `wd:${id}`).join(' ');
  const query = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?item ?languageLabel WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P364 ?language.
  ?language rdfs:label ?languageLabel.
  FILTER(LANG(?languageLabel) = "en")
}`;
  const data = await fetchJson(getWikidataUrl(query), 'Language metadata');
  const bindings = data.results && data.results.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error('Language metadata response has an unexpected format');
  }

  const languagesByItem = new Map();
  bindings.forEach((binding) => {
    const itemUri = binding.item && binding.item.value;
    const language = binding.languageLabel && binding.languageLabel.value;
    addLanguage(languagesByItem, itemUri, language);
  });
  return languagesByItem;
}

async function getCatalog({ category, language, title }) {
  const cacheKey = JSON.stringify([category, language, title]);
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.payload;
  }

  const warnings = [];
  if (category === 'movie') {
    if (!(process.env.TMDB_API_KEY || '').trim()) {
      warnings.push('tmdb_not_configured');
    } else {
      try {
        const tmdbPayload = await getTmdbCatalog({ language, title });
        if (tmdbPayload && tmdbPayload.items.length) {
          return cacheCatalogPayload(cacheKey, tmdbPayload);
        }
      } catch (error) {
        console.error('Could not load movie artwork from TMDb.', error);
        warnings.push('tmdb_unavailable');
      }
    }
  }

  const wikidataPromise = title
    ? searchWikidataByTitle({ category, language, title })
    : fetchJson(getWikidataUrl(getWikidataQuery(category, language)), 'Movie and TV catalog');
  const searchTerm = title || language;
  const tvMazePromise = category === 'movie' || !searchTerm
    ? Promise.resolve(null)
    : (() => {
      const url = new URL('https://api.tvmaze.com/search/shows');
      url.searchParams.set('q', searchTerm);
      return fetchJson(url, 'TV catalog');
    })();
  const [wikidataResult, tvMazeResult] = await Promise.allSettled([wikidataPromise, tvMazePromise]);
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

  const items = wikidataData && wikidataData.results && wikidataData.results.bindings;
  const itemsByName = new Map();
  if (Array.isArray(items)) {
    let languagesByItem = new Map();
    if (!language && items.length) {
      try {
        languagesByItem = await getLanguageLabels(items);
      } catch (error) {
        console.error('Could not load original-language labels.', error);
        warnings.push('language_metadata_unavailable');
      }
    }

    items.forEach((item) => {
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
      setTitle(itemsByName, {
        name,
        language: language || Array.from(languagesByItem.get(itemUri) || []).join(', '),
        type,
        image: item.image && item.image.value,
        detailsUrl: itemUri
      });
    });
  } else if (wikidataData) {
    throw new Error('Movie and TV catalog response has an unexpected format');
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
      setTitle(itemsByName, {
        name: show.name,
        language: show.language,
        type: show.type || 'TV show',
        image: show.image && show.image.medium,
        detailsUrl: show.url,
        source: 'tvmaze'
      });
    });
  } else if (tvMazeMatches !== null) {
    throw new Error('TV catalog response has an unexpected format');
  }

  return cacheCatalogPayload(cacheKey, {
    items: Array.from(itemsByName.values()),
    warnings
  });
}

function readCatalogParameters(url) {
  const category = url.searchParams.get('category') || 'all';
  const language = (url.searchParams.get('language') || '').trim();
  const title = (url.searchParams.get('title') || '').trim();
  if (!Object.hasOwn(CATEGORY_TYPE_IDS, category)) {
    return { error: 'Choose a supported catalog category.' };
  }
  if (language.length > 60 || title.length > 80) {
    return { error: 'Language or title search is too long.' };
  }
  return { category, language, title };
}

async function serveStaticFile(request, response, pathname) {
  const publicFile = PUBLIC_FILES.get(pathname);
  if (!publicFile) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  try {
    const contents = await fs.readFile(path.join(ROOT, publicFile[0]));
    response.writeHead(200, {
      'Content-Type': publicFile[1],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    console.error(`Could not serve ${publicFile[0]}.`, error);
    sendJson(response, 500, { error: 'The app file could not be served.' });
  }
}

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (url.pathname === '/api/catalog') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }
      const parameters = readCatalogParameters(url);
      if (parameters.error) {
        sendJson(response, 400, { error: parameters.error });
        return;
      }
      try {
        const payload = await getCatalog(parameters);
        sendJson(response, 200, payload);
      } catch (error) {
        console.error('Could not complete the catalog request.', error);
        sendJson(response, 502, { error: 'The catalog is unavailable right now. Please try again.' });
      }
      return;
    }
    await serveStaticFile(request, response, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error('Request could not be handled.', error);
    sendJson(response, 400, { error: 'The request could not be handled.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TamilFlix is running at http://localhost:${PORT}`);
  console.log('To open it from a phone on the same Wi-Fi, use this computer’s local IP address and the same port.');
});
