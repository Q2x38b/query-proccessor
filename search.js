/**
 * Search Module - Fetch real search results from ANY source via CORS proxies
 * Parses HTML responses to extract actual search results
 */

const SearchEngine = {
  // CORS proxies to try (in order of reliability)
  corsProxies: [
    { url: 'https://api.allorigins.win/raw?url=', encode: true },
    { url: 'https://corsproxy.io/?', encode: true },
    { url: 'https://api.codetabs.com/v1/proxy?quest=', encode: true },
    { url: 'https://cors-anywhere.herokuapp.com/', encode: false },
  ],

  currentProxyIndex: 0,
  proxyFailures: {},

  // Sites that block most proxies - use alternative search methods instead
  blockedSites: [
    'truepeoplesearch.com',
    'whitepages.com',
    'spokeo.com',
    'peekyou.com',
    'linkedin.com',
    'facebook.com',
    'instagram.com',
  ],

  /**
   * Check if a URL is from a site known to block proxies
   */
  isBlockedSite(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.blockedSites.some(site => hostname.includes(site));
    } catch {
      return false;
    }
  },

  /**
   * Fetch any URL with CORS proxy fallback
   */
  async fetchWithProxy(url, options = {}) {
    const timeout = options.timeout || 8000;

    // Skip sites known to block proxies
    if (this.isBlockedSite(url)) {
      throw new Error('Site blocks proxy access: ' + url);
    }

    // Try CORS proxies (skip direct fetch - it almost never works)
    for (let i = 0; i < this.corsProxies.length; i++) {
      const proxyIndex = (this.currentProxyIndex + i) % this.corsProxies.length;
      const proxy = this.corsProxies[proxyIndex];

      // Skip proxies that have failed recently (30 second cooldown)
      if (this.proxyFailures[proxy.url] && Date.now() - this.proxyFailures[proxy.url] < 30000) {
        continue;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const proxyUrl = proxy.url + (proxy.encode ? encodeURIComponent(url) : url);
        const response = await fetch(proxyUrl, {
          ...options,
          signal: controller.signal,
          headers: {
            ...options.headers,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          }
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          this.currentProxyIndex = proxyIndex;
          return response;
        } else {
          this.proxyFailures[proxy.url] = Date.now();
        }
      } catch (e) {
        this.proxyFailures[proxy.url] = Date.now();
        continue;
      }
    }

    throw new Error('All proxies failed for: ' + url);
  },

  /**
   * Fetch HTML from any URL and return parsed document
   */
  async fetchHTML(url) {
    try {
      const response = await this.fetchWithProxy(url);
      const html = await response.text();
      const parser = new DOMParser();
      return parser.parseFromString(html, 'text/html');
    } catch (e) {
      // Silently fail - this is expected for many sites
      return null;
    }
  },

  /**
   * Generic search result extractor - tries to find results from any page
   */
  extractGenericResults(doc, baseUrl) {
    const results = [];
    if (!doc) return results;

    // Common result selectors used by search engines and directories
    const selectors = [
      // Google-like results
      '.g', '.search-result', '.result', '.searchresult',
      // List items that might be results
      '.listing', '.record', '.person-card', '.profile-card',
      // Table rows
      'table tr', '.data-row',
      // Article/card patterns
      'article', '.card', '.item', '.entry',
      // Links with descriptions
      '.link-item', '.search-item'
    ];

    for (const selector of selectors) {
      const elements = doc.querySelectorAll(selector);
      if (elements.length > 0 && elements.length < 50) {
        elements.forEach(el => {
          const link = el.querySelector('a[href]');
          const title = el.querySelector('h1, h2, h3, h4, .title, .name, a')?.textContent?.trim();
          const snippet = el.querySelector('p, .snippet, .description, .summary, .text')?.textContent?.trim();

          if (title && title.length > 2) {
            results.push({
              title: title.substring(0, 200),
              snippet: snippet?.substring(0, 300) || '',
              url: link?.href || baseUrl,
              source: new URL(baseUrl).hostname.replace('www.', '')
            });
          }
        });
        if (results.length > 0) break;
      }
    }

    return results;
  },

  //=========================================
  // SITE-SPECIFIC PARSERS
  //=========================================

  parsers: {
    // Google Search Results
    google: (doc) => {
      const results = [];
      doc.querySelectorAll('.g').forEach(el => {
        const titleEl = el.querySelector('h3');
        const linkEl = el.querySelector('a[href^="http"]');
        const snippetEl = el.querySelector('.VwiC3b, .s, .st');

        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent.trim(),
            url: linkEl.href,
            snippet: snippetEl?.textContent?.trim() || '',
            source: 'Google'
          });
        }
      });
      return results;
    },

    // DuckDuckGo HTML results
    duckduckgo: (doc) => {
      const results = [];
      doc.querySelectorAll('.result, .results_links, .result__body').forEach(el => {
        const titleEl = el.querySelector('.result__a');
        const snippetEl = el.querySelector('.result__snippet');
        const urlEl = el.querySelector('.result__url');

        if (titleEl) {
          // Extract real URL from DDG redirect link
          let realUrl = '';
          const href = titleEl.getAttribute('href') || '';
          if (href.includes('uddg=')) {
            // Decode the uddg parameter which contains the real URL
            const match = href.match(/uddg=([^&]+)/);
            if (match) {
              realUrl = decodeURIComponent(match[1]);
            }
          } else if (urlEl) {
            // Use the display URL
            realUrl = 'https://' + urlEl.textContent.trim();
          } else if (href.startsWith('http')) {
            realUrl = href;
          }

          if (realUrl) {
            results.push({
              title: titleEl.textContent.trim(),
              url: realUrl,
              snippet: snippetEl?.textContent?.trim() || '',
              source: 'DuckDuckGo'
            });
          }
        }
      });
      return results;
    },

    // TruePeopleSearch
    truepeoplesearch: (doc) => {
      const results = [];
      doc.querySelectorAll('.card-summary, .people-card').forEach(el => {
        const nameEl = el.querySelector('.h4, .name, a');
        const ageEl = el.querySelector('.age');
        const locationEl = el.querySelector('.location, .address');
        const linkEl = el.querySelector('a[href]');

        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: [ageEl?.textContent, locationEl?.textContent].filter(Boolean).join(' - '),
            url: linkEl?.href || '',
            source: 'TruePeopleSearch',
            type: 'person'
          });
        }
      });
      return results;
    },

    // WhitePages
    whitepages: (doc) => {
      const results = [];
      doc.querySelectorAll('.serp-card, .person-card').forEach(el => {
        const nameEl = el.querySelector('.name, h2, h3');
        const detailsEl = el.querySelector('.details, .meta');
        const linkEl = el.querySelector('a[href]');

        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: detailsEl?.textContent?.trim() || '',
            url: linkEl?.href || '',
            source: 'WhitePages',
            type: 'person'
          });
        }
      });
      return results;
    },

    // Spokeo
    spokeo: (doc) => {
      const results = [];
      doc.querySelectorAll('.result-card, .person-result').forEach(el => {
        const nameEl = el.querySelector('.name, h3');
        const infoEl = el.querySelector('.info, .details');
        const linkEl = el.querySelector('a[href]');

        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: infoEl?.textContent?.trim() || '',
            url: linkEl?.href || '',
            source: 'Spokeo',
            type: 'person'
          });
        }
      });
      return results;
    },

    // PeekYou
    peekyou: (doc) => {
      const results = [];
      doc.querySelectorAll('.result, .person').forEach(el => {
        const nameEl = el.querySelector('.name, h2, a');
        const bioEl = el.querySelector('.bio, .tagline');
        const linkEl = el.querySelector('a[href]');

        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: bioEl?.textContent?.trim() || '',
            url: linkEl?.href || '',
            source: 'PeekYou',
            type: 'person'
          });
        }
      });
      return results;
    },

    // WebMii
    webmii: (doc) => {
      const results = [];
      doc.querySelectorAll('.person-result, .result-item, .card').forEach(el => {
        const nameEl = el.querySelector('.name, h3, h4, a');
        const scoreEl = el.querySelector('.score, .visibility');
        const linksEl = el.querySelector('.links, .profiles');

        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: [scoreEl?.textContent, linksEl?.textContent].filter(Boolean).join(' - '),
            url: el.querySelector('a')?.href || '',
            source: 'WebMii',
            type: 'person'
          });
        }
      });
      return results;
    },

    // LinkedIn (limited - often blocked)
    linkedin: (doc) => {
      const results = [];
      doc.querySelectorAll('.search-result, .entity-result').forEach(el => {
        const nameEl = el.querySelector('.name, .actor-name');
        const titleEl = el.querySelector('.subline, .primary-subtitle');
        const linkEl = el.querySelector('a[href*="/in/"]');

        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: titleEl?.textContent?.trim() || '',
            url: linkEl?.href || '',
            source: 'LinkedIn',
            type: 'profile'
          });
        }
      });
      return results;
    },

    // Twitter/X
    twitter: (doc) => {
      const results = [];
      doc.querySelectorAll('[data-testid="tweet"], .tweet').forEach(el => {
        const userEl = el.querySelector('[data-testid="User-Name"], .username');
        const textEl = el.querySelector('[data-testid="tweetText"], .tweet-text');
        const linkEl = el.querySelector('a[href*="/status/"]');

        if (textEl) {
          results.push({
            title: userEl?.textContent?.trim() || 'Tweet',
            snippet: textEl.textContent.trim(),
            url: linkEl?.href || '',
            source: 'Twitter',
            type: 'social'
          });
        }
      });
      return results;
    },

    // Reddit
    reddit: (doc) => {
      const results = [];
      doc.querySelectorAll('.Post, .search-result, .thing').forEach(el => {
        const titleEl = el.querySelector('h3, .title, a.title');
        const authorEl = el.querySelector('.author, [data-testid="post_author_link"]');
        const subredditEl = el.querySelector('.subreddit, [data-testid="subreddit-name"]');

        if (titleEl) {
          results.push({
            title: titleEl.textContent.trim(),
            snippet: `by ${authorEl?.textContent || 'unknown'} in ${subredditEl?.textContent || 'reddit'}`,
            url: el.querySelector('a[href*="/comments/"]')?.href || '',
            source: 'Reddit',
            type: 'discussion'
          });
        }
      });
      return results;
    },

    // Instagram (Google search results for Instagram)
    instagram: (doc) => {
      const results = [];
      doc.querySelectorAll('.g').forEach(el => {
        const titleEl = el.querySelector('h3');
        const linkEl = el.querySelector('a[href*="instagram.com"]');
        const snippetEl = el.querySelector('.VwiC3b');

        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent.trim(),
            url: linkEl.href,
            snippet: snippetEl?.textContent?.trim() || '',
            source: 'Instagram',
            type: 'profile'
          });
        }
      });
      return results;
    },

    // Facebook
    facebook: (doc) => {
      const results = [];
      // Facebook blocks most scraping, so we parse Google results
      doc.querySelectorAll('.g').forEach(el => {
        const titleEl = el.querySelector('h3');
        const linkEl = el.querySelector('a[href*="facebook.com"]');
        const snippetEl = el.querySelector('.VwiC3b');

        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent.trim(),
            url: linkEl.href,
            snippet: snippetEl?.textContent?.trim() || '',
            source: 'Facebook',
            type: 'profile'
          });
        }
      });
      return results;
    },

    // Pipl
    pipl: (doc) => {
      const results = [];
      doc.querySelectorAll('.result, .person-card').forEach(el => {
        const nameEl = el.querySelector('.name, h2');
        const detailsEl = el.querySelector('.details, .info');

        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: detailsEl?.textContent?.trim() || '',
            url: el.querySelector('a')?.href || '',
            source: 'Pipl',
            type: 'person'
          });
        }
      });
      return results;
    },

    // Shodan
    shodan: (doc) => {
      const results = [];
      doc.querySelectorAll('.search-result, .result').forEach(el => {
        const ipEl = el.querySelector('.ip, a[href*="/host/"]');
        const detailsEl = el.querySelector('.details, .hostnames');
        if (ipEl) {
          results.push({
            title: ipEl.textContent.trim(),
            snippet: detailsEl?.textContent?.trim() || '',
            url: el.querySelector('a')?.href || '',
            source: 'Shodan',
            type: 'host'
          });
        }
      });
      return results;
    },

    // VirusTotal
    virustotal: (doc) => {
      const results = [];
      doc.querySelectorAll('.detection, .result-row').forEach(el => {
        const nameEl = el.querySelector('.engine-name, .name');
        const resultEl = el.querySelector('.result, .detection-result');
        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: resultEl?.textContent?.trim() || '',
            source: 'VirusTotal',
            type: 'scan'
          });
        }
      });
      return results;
    },

    // GitHub
    github: (doc) => {
      const results = [];
      doc.querySelectorAll('.repo-list-item, .code-list-item').forEach(el => {
        const nameEl = el.querySelector('.v-align-middle, a[href*="/"]');
        const descEl = el.querySelector('.mb-1, p');
        const linkEl = el.querySelector('a[href]');
        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: descEl?.textContent?.trim() || '',
            url: linkEl?.href || '',
            source: 'GitHub',
            type: 'repo'
          });
        }
      });
      return results;
    },

    // Archive.org
    archive: (doc) => {
      const results = [];
      doc.querySelectorAll('.item-ttl, .results .item').forEach(el => {
        const titleEl = el.querySelector('a, .ttl');
        const descEl = el.querySelector('.byv, .description');
        if (titleEl) {
          results.push({
            title: titleEl.textContent.trim(),
            snippet: descEl?.textContent?.trim() || '',
            url: titleEl.href || '',
            source: 'Archive.org',
            type: 'archive'
          });
        }
      });
      return results;
    },

    // OpenCorporates
    opencorporates: (doc) => {
      const results = [];
      doc.querySelectorAll('.company_search_result, .result').forEach(el => {
        const nameEl = el.querySelector('.company_name, a');
        const infoEl = el.querySelector('.company_info, .jurisdiction');
        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: infoEl?.textContent?.trim() || '',
            url: el.querySelector('a')?.href || '',
            source: 'OpenCorporates',
            type: 'company'
          });
        }
      });
      return results;
    },

    // Court Listener
    courtlistener: (doc) => {
      const results = [];
      doc.querySelectorAll('.search-result, .result').forEach(el => {
        const titleEl = el.querySelector('.case-name, h3, a');
        const courtEl = el.querySelector('.court, .meta');
        if (titleEl) {
          results.push({
            title: titleEl.textContent.trim(),
            snippet: courtEl?.textContent?.trim() || '',
            url: el.querySelector('a')?.href || '',
            source: 'CourtListener',
            type: 'legal'
          });
        }
      });
      return results;
    },

    // Google Scholar
    scholar: (doc) => {
      const results = [];
      doc.querySelectorAll('.gs_ri, .gs_r').forEach(el => {
        const titleEl = el.querySelector('.gs_rt a, h3 a');
        const snippetEl = el.querySelector('.gs_rs');
        const authorsEl = el.querySelector('.gs_a');
        if (titleEl) {
          results.push({
            title: titleEl.textContent.trim(),
            snippet: snippetEl?.textContent?.trim() || '',
            url: titleEl.href || '',
            source: 'Google Scholar',
            type: 'paper',
            authors: authorsEl?.textContent?.trim()
          });
        }
      });
      return results;
    },

    // Google News
    googlenews: (doc) => {
      const results = [];
      doc.querySelectorAll('article, .NiLAwe').forEach(el => {
        const titleEl = el.querySelector('h3, h4, a');
        const sourceEl = el.querySelector('.wEwyrc, time');
        if (titleEl) {
          results.push({
            title: titleEl.textContent.trim(),
            snippet: sourceEl?.textContent?.trim() || '',
            url: el.querySelector('a')?.href || '',
            source: 'Google News',
            type: 'news'
          });
        }
      });
      return results;
    },

    // HaveIBeenPwned
    hibp: (doc) => {
      const results = [];
      doc.querySelectorAll('.pwnedWebsite, .breach').forEach(el => {
        const nameEl = el.querySelector('.pwnedCompany, h3');
        const descEl = el.querySelector('.pwnedDescription, p');
        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: descEl?.textContent?.trim() || '',
            source: 'HIBP',
            type: 'breach'
          });
        }
      });
      return results;
    },

    // Crunchbase
    crunchbase: (doc) => {
      const results = [];
      doc.querySelectorAll('.component--search-result, .result').forEach(el => {
        const nameEl = el.querySelector('.name, h3, a');
        const descEl = el.querySelector('.description, .snippet');
        if (nameEl) {
          results.push({
            title: nameEl.textContent.trim(),
            snippet: descEl?.textContent?.trim() || '',
            url: el.querySelector('a')?.href || '',
            source: 'Crunchbase',
            type: 'company'
          });
        }
      });
      return results;
    },

    // YouTube
    youtube: (doc) => {
      const results = [];
      doc.querySelectorAll('ytd-video-renderer, .yt-lockup').forEach(el => {
        const titleEl = el.querySelector('#video-title, .yt-lockup-title a');
        const channelEl = el.querySelector('#channel-name, .yt-lockup-byline');
        if (titleEl) {
          results.push({
            title: titleEl.textContent.trim(),
            snippet: channelEl?.textContent?.trim() || '',
            url: titleEl.href || '',
            source: 'YouTube',
            type: 'video'
          });
        }
      });
      return results;
    },
  },

  //=========================================
  // FETCH AND PARSE FROM SPECIFIC SITES
  //=========================================

  /**
   * Fetch and parse results from a specific URL
   */
  async fetchAndParse(url, parserName) {
    try {
      const doc = await this.fetchHTML(url);
      if (!doc) return [];

      // Use specific parser if available
      if (parserName && this.parsers[parserName]) {
        const results = this.parsers[parserName](doc);
        if (results.length > 0) return results;
      }

      // Fall back to generic extraction
      return this.extractGenericResults(doc, url);
    } catch (e) {
      // Silently return empty - errors are expected
      return [];
    }
  },

  /**
   * Search Google and parse results (via proxy) - falls back to DuckDuckGo if blocked
   */
  async searchGoogle(query, site = null) {
    const fullQuery = site ? `site:${site} ${query}` : query;

    // Try DuckDuckGo HTML first (more reliable than Google via proxy)
    try {
      const ddgResults = await this.searchDuckDuckGoHTML(fullQuery);
      if (ddgResults.length > 0) {
        return ddgResults.map(r => ({ ...r, source: site ? site.split('.')[0] : 'Web' }));
      }
    } catch (e) {
      // Continue to try Google
    }

    // Try Google as backup
    try {
      const siteParam = site ? `site:${site}+` : '';
      const url = `https://www.google.com/search?q=${siteParam}${encodeURIComponent(query)}&num=20`;
      return await this.fetchAndParse(url, 'google');
    } catch (e) {
      return [];
    }
  },

  /**
   * Search DuckDuckGo HTML (via proxy) - most reliable scraping method
   */
  async searchDuckDuckGoHTML(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
      return await this.fetchAndParse(url, 'duckduckgo');
    } catch (e) {
      return [];
    }
  },

  /**
   * Search TruePeopleSearch (via DuckDuckGo site: search since direct access blocked)
   */
  async searchTruePeopleSearch(name) {
    // Site blocks proxies - search via DuckDuckGo
    const results = await this.searchDuckDuckGoHTML(`site:truepeoplesearch.com ${name}`);
    return results.map(r => ({ ...r, source: 'TruePeopleSearch', type: 'person' }));
  },

  /**
   * Search WhitePages (via DuckDuckGo site: search since direct access blocked)
   */
  async searchWhitePages(name) {
    const results = await this.searchDuckDuckGoHTML(`site:whitepages.com ${name}`);
    return results.map(r => ({ ...r, source: 'WhitePages', type: 'person' }));
  },

  /**
   * Search Spokeo (via DuckDuckGo site: search since direct access blocked)
   */
  async searchSpokeo(name) {
    const results = await this.searchDuckDuckGoHTML(`site:spokeo.com ${name}`);
    return results.map(r => ({ ...r, source: 'Spokeo', type: 'person' }));
  },

  /**
   * Search PeekYou (via DuckDuckGo site: search since direct access blocked)
   */
  async searchPeekYou(name) {
    const results = await this.searchDuckDuckGoHTML(`site:peekyou.com ${name}`);
    return results.map(r => ({ ...r, source: 'PeekYou', type: 'person' }));
  },

  /**
   * Search WebMii
   */
  async searchWebMii(name) {
    // Try direct first, fall back to DuckDuckGo
    try {
      const url = `https://webmii.com/people?n=${encodeURIComponent(name)}`;
      const results = await this.fetchAndParse(url, 'webmii');
      if (results.length > 0) return results;
    } catch (e) {
      // Fall through to DuckDuckGo
    }
    const results = await this.searchDuckDuckGoHTML(`site:webmii.com ${name}`);
    return results.map(r => ({ ...r, source: 'WebMii', type: 'person' }));
  },

  /**
   * Search Shodan
   */
  async searchShodan(query) {
    const url = `https://www.shodan.io/search?query=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'shodan');
  },

  /**
   * Search VirusTotal
   */
  async searchVirusTotal(query) {
    const url = `https://www.virustotal.com/gui/search/${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'virustotal');
  },

  /**
   * Search OpenCorporates
   */
  async searchOpenCorporates(query) {
    const url = `https://opencorporates.com/companies?q=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'opencorporates');
  },

  /**
   * Search CourtListener
   */
  async searchCourtListener(query) {
    const url = `https://www.courtlistener.com/?q=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'courtlistener');
  },

  /**
   * Search Google Scholar
   */
  async searchGoogleScholar(query) {
    const url = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'scholar');
  },

  /**
   * Search Google News
   */
  async searchGoogleNews(query) {
    const url = `https://news.google.com/search?q=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'googlenews');
  },

  /**
   * Search Crunchbase
   */
  async searchCrunchbase(query) {
    const url = `https://www.crunchbase.com/textsearch?q=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'crunchbase');
  },

  /**
   * Search YouTube
   */
  async searchYouTube(query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'youtube');
  },

  /**
   * Search Archive.org
   */
  async searchArchiveOrg(query) {
    const url = `https://archive.org/search?query=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'archive');
  },

  /**
   * Search Wayback Machine
   */
  async searchWayback(url) {
    const waybackUrl = `https://web.archive.org/web/*/${url}`;
    return this.fetchAndParse(waybackUrl, 'archive');
  },

  /**
   * Search Bing
   */
  async searchBing(query) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'google'); // Similar structure to Google
  },

  /**
   * Search Brave
   */
  async searchBrave(query) {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    return this.fetchAndParse(url, 'google'); // Similar structure
  },

  /**
   * Search TikTok (via Google)
   */
  async searchTikTok(query) {
    return this.searchGoogle(query, 'tiktok.com');
  },

  /**
   * Search Telegram (via Google)
   */
  async searchTelegram(query) {
    return this.searchGoogle(query, 't.me');
  },

  /**
   * Generic URL scraper - works for any site
   */
  async scrapeURL(url) {
    return this.fetchAndParse(url, null);
  },

  //=========================================
  // API-BASED SEARCHES (no scraping needed)
  //=========================================

  /**
   * Search using Google Custom Search Engine (CSE)
   */
  async searchGoogleCSE(query, cseId = '20e0bdcc4fe9a4599') {
    return new Promise((resolve) => {
      const results = [];
      const containerId = 'cse-temp-' + Date.now();

      // Create hidden container for CSE
      const container = document.createElement('div');
      container.id = containerId;
      container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
      document.body.appendChild(container);

      // Create search element
      const searchDiv = document.createElement('div');
      searchDiv.className = 'gcse-searchresults-only';
      searchDiv.setAttribute('data-queryParameterName', 'search');
      container.appendChild(searchDiv);

      // Load CSE script if not already loaded
      if (!window.__gcse) {
        window.__gcse = {
          parsetags: 'explicit',
          callback: function() {
            if (window.google?.search?.cse) {
              const element = window.google.search.cse.element.render({
                div: containerId,
                tag: 'searchresults-only'
              });
              element.execute(query);
            }
          }
        };

        const script = document.createElement('script');
        script.src = `https://cse.google.com/cse.js?cx=${cseId}`;
        script.async = true;
        document.head.appendChild(script);
      } else if (window.google?.search?.cse) {
        const element = window.google.search.cse.element.render({
          div: containerId,
          tag: 'searchresults-only'
        });
        element.execute(query);
      }

      // Poll for results
      let attempts = 0;
      const maxAttempts = 50;
      const checkInterval = setInterval(() => {
        attempts++;

        const resultItems = container.querySelectorAll('.gsc-webResult, .gs-webResult');
        resultItems.forEach(item => {
          const titleEl = item.querySelector('.gs-title a, a.gs-title');
          const snippetEl = item.querySelector('.gs-snippet');
          const urlEl = item.querySelector('.gs-visibleUrl, .gs-visibleUrl-short');

          if (titleEl && !results.find(r => r.url === titleEl.href)) {
            results.push({
              title: titleEl.textContent.trim(),
              url: titleEl.href,
              snippet: snippetEl?.textContent?.trim() || '',
              displayUrl: urlEl?.textContent?.trim() || '',
              source: 'Google CSE'
            });
          }
        });

        if (results.length > 0 || attempts >= maxAttempts) {
          clearInterval(checkInterval);
          setTimeout(() => container.remove(), 100);
          resolve(results);
        }
      }, 200);

      // Timeout fallback
      setTimeout(() => {
        clearInterval(checkInterval);
        container.remove();
        resolve(results);
      }, 12000);
    });
  },

  /**
   * Search DuckDuckGo Instant Answer API
   */
  async searchDuckDuckGo(query) {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const response = await this.fetchWithProxy(url);
      const data = await response.json();

      const results = [];

      // Abstract (main answer)
      if (data.Abstract) {
        results.push({
          title: data.Heading || query,
          snippet: data.Abstract,
          url: data.AbstractURL,
          source: data.AbstractSource || 'DuckDuckGo',
          type: 'answer',
          image: data.Image ? `https://duckduckgo.com${data.Image}` : null
        });
      }

      // Related topics
      if (data.RelatedTopics) {
        data.RelatedTopics.forEach(topic => {
          if (topic.FirstURL) {
            results.push({
              title: topic.Text?.split(' - ')[0] || '',
              snippet: topic.Text || '',
              url: topic.FirstURL,
              source: 'DuckDuckGo',
              type: 'related',
              image: topic.Icon?.URL ? `https://duckduckgo.com${topic.Icon.URL}` : null
            });
          }
          if (topic.Topics) {
            topic.Topics.forEach(sub => {
              if (sub.FirstURL) {
                results.push({
                  title: sub.Text?.split(' - ')[0] || '',
                  snippet: sub.Text || '',
                  url: sub.FirstURL,
                  source: 'DuckDuckGo',
                  type: 'related'
                });
              }
            });
          }
        });
      }

      // Infobox
      if (data.Infobox?.content) {
        results.push({
          title: data.Heading,
          type: 'infobox',
          source: 'DuckDuckGo',
          data: data.Infobox.content.reduce((acc, item) => {
            acc[item.label] = item.value;
            return acc;
          }, {}),
          url: data.AbstractURL
        });
      }

      return results;
    } catch (e) {
      // Fallback to HTML scraping
      return this.searchDuckDuckGoHTML(query);
    }
  },

  /**
   * Search Wikipedia API
   */
  async searchWikipedia(query, limit = 10) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=${limit}`;
      const response = await fetch(url);
      const data = await response.json();

      return (data.query?.search || []).map(item => ({
        title: item.title,
        snippet: item.snippet.replace(/<[^>]+>/g, ''),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
        source: 'Wikipedia',
        type: 'wiki',
        wordCount: item.wordcount
      }));
    } catch (e) {
      // Wikipedia search failed - silently return empty
      return [];
    }
  },

  /**
   * Get Wikipedia summary
   */
  async getWikipediaSummary(title) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const response = await fetch(url);
      const data = await response.json();

      return {
        title: data.title,
        description: data.description,
        extract: data.extract,
        url: data.content_urls?.desktop?.page,
        image: data.thumbnail?.source,
        source: 'Wikipedia',
        type: 'summary'
      };
    } catch (e) {
      // Wikipedia summary failed
      return null;
    }
  },

  /**
   * Search Wikidata
   */
  async searchWikidata(query, type = 'person') {
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&origin=*&limit=10`;
      const response = await fetch(url);
      const data = await response.json();

      return (data.search || []).map(item => ({
        id: item.id,
        title: item.label,
        description: item.description,
        url: `https://www.wikidata.org/wiki/${item.id}`,
        source: 'Wikidata',
        type: 'entity'
      }));
    } catch (e) {
      // Wikidata search failed
      return [];
    }
  },

  /**
   * Search Reddit JSON API
   */
  async searchReddit(query, limit = 10) {
    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${limit}&sort=relevance`;
      const response = await this.fetchWithProxy(url);
      const data = await response.json();

      return (data.data?.children || []).map(post => ({
        title: post.data.title,
        snippet: post.data.selftext?.substring(0, 300) || '',
        url: `https://reddit.com${post.data.permalink}`,
        source: 'Reddit',
        type: 'discussion',
        subreddit: post.data.subreddit,
        score: post.data.score,
        comments: post.data.num_comments,
        author: post.data.author
      }));
    } catch (e) {
      // Reddit API failed
      return [];
    }
  },

  /**
   * Search Hacker News
   */
  async searchHackerNews(query, limit = 10) {
    try {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
      const response = await fetch(url);
      const data = await response.json();

      return (data.hits || []).map(hit => ({
        title: hit.title || hit.story_title,
        snippet: hit.comment_text?.substring(0, 300) || '',
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        source: 'Hacker News',
        type: hit.comment_text ? 'comment' : 'story',
        points: hit.points,
        author: hit.author,
        date: hit.created_at
      })).filter(h => h.title);
    } catch (e) {
      // Hacker News search failed
      return [];
    }
  },

  /**
   * Search arXiv
   */
  async searchArxiv(query, limit = 10) {
    try {
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
      const response = await this.fetchWithProxy(url);
      const text = await response.text();

      const parser = new DOMParser();
      const xml = parser.parseFromString(text, 'text/xml');
      const entries = xml.querySelectorAll('entry');

      return Array.from(entries).map(entry => ({
        title: entry.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim(),
        snippet: entry.querySelector('summary')?.textContent?.substring(0, 300).trim(),
        url: entry.querySelector('id')?.textContent,
        source: 'arXiv',
        type: 'paper',
        authors: Array.from(entry.querySelectorAll('author name')).map(a => a.textContent),
        published: entry.querySelector('published')?.textContent
      }));
    } catch (e) {
      // arXiv search failed
      return [];
    }
  },

  /**
   * Search GitHub
   */
  async searchGitHub(query, type = 'repositories', limit = 10) {
    try {
      const url = `https://api.github.com/search/${type}?q=${encodeURIComponent(query)}&per_page=${limit}`;
      const response = await fetch(url);
      const data = await response.json();

      return (data.items || []).map(item => ({
        title: item.full_name || item.name,
        snippet: item.description || '',
        url: item.html_url,
        source: 'GitHub',
        type: type === 'repositories' ? 'repo' : 'code',
        stars: item.stargazers_count,
        language: item.language,
        owner: item.owner?.login
      }));
    } catch (e) {
      // GitHub search failed
      return [];
    }
  },

  /**
   * Search StackOverflow
   */
  async searchStackOverflow(query, limit = 10) {
    try {
      const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${limit}`;
      const response = await fetch(url);
      const data = await response.json();

      return (data.items || []).map(item => ({
        title: item.title,
        snippet: '',
        url: item.link,
        source: 'Stack Overflow',
        type: 'qa',
        score: item.score,
        answered: item.is_answered,
        answers: item.answer_count,
        tags: item.tags
      }));
    } catch (e) {
      // StackOverflow search failed
      return [];
    }
  },

  //=========================================
  // GOVERNMENT & PUBLIC RECORD SOURCES
  //=========================================

  /**
   * NHTSA VIN Decoder - Free government API
   */
  async decodeVIN(vin) {
    try {
      const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`;
      const response = await fetch(url);
      const data = await response.json();

      const results = (data.Results || [])
        .filter(r => r.Value && r.Value.trim() !== '' && r.Value !== 'Not Applicable')
        .map(r => ({
          title: r.Variable,
          snippet: r.Value,
          source: 'NHTSA',
          type: 'vehicle'
        }));

      return results;
    } catch (e) {
      return [];
    }
  },

  /**
   * NHTSA Complaints/Recalls by VIN
   */
  async getVehicleRecalls(vin) {
    try {
      // Search by decoded make/model/year
      const decoded = await this.decodeVIN(vin);
      const make = decoded.find(d => d.title === 'Make')?.snippet;
      const model = decoded.find(d => d.title === 'Model')?.snippet;
      const year = decoded.find(d => d.title === 'Model Year')?.snippet;

      if (make && model && year) {
        const recallUrl = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`;
        const response = await fetch(recallUrl);
        const data = await response.json();

        return (data.results || []).map(r => ({
          title: `Recall: ${r.Component}`,
          snippet: r.Summary,
          url: `https://www.nhtsa.gov/recalls?nhtsaId=${r.NHTSACampaignNumber}`,
          source: 'NHTSA Recalls',
          type: 'recall',
          date: r.ReportReceivedDate
        }));
      }
      return [];
    } catch (e) {
      return [];
    }
  },

  /**
   * FCC License Search - Amateur radio, broadcast, etc.
   */
  async searchFCCLicense(query) {
    try {
      const url = `https://data.fcc.gov/api/license-view/basicSearch/getLicenses?searchValue=${encodeURIComponent(query)}&format=json`;
      const response = await this.fetchWithProxy(url);
      const data = await response.json();

      return (data.Licenses?.License || []).map(lic => ({
        title: `${lic.licName} (${lic.callsign || lic.licenseID})`,
        snippet: `${lic.serviceDesc} - ${lic.statusDesc} - Expires: ${lic.expiredDate || 'N/A'}`,
        url: `https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${lic.licenseID}`,
        source: 'FCC',
        type: 'license',
        callsign: lic.callsign,
        status: lic.statusDesc
      }));
    } catch (e) {
      return [];
    }
  },

  /**
   * SEC EDGAR - Corporate filings search
   */
  async searchSEC(query) {
    try {
      const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&dateRange=custom&startdt=2020-01-01&enddt=2025-12-31&forms=10-K,10-Q,8-K,DEF%2014A`;
      const response = await this.fetchWithProxy(url);
      const data = await response.json();

      return (data.hits?.hits || []).slice(0, 15).map(hit => ({
        title: `${hit._source.display_names?.[0] || 'Unknown'} - ${hit._source.form}`,
        snippet: `Filed: ${hit._source.file_date} | ${hit._source.file_description || ''}`,
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(query)}&type=&dateb=&owner=include&count=40`,
        source: 'SEC EDGAR',
        type: 'filing',
        form: hit._source.form,
        date: hit._source.file_date
      }));
    } catch (e) {
      // Try alternative SEC company search
      try {
        const altUrl = `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(query)}&CIK=&type=&owner=include&count=20&action=getcompany&output=atom`;
        const response = await this.fetchWithProxy(altUrl);
        const text = await response.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');

        return Array.from(xml.querySelectorAll('entry')).map(entry => ({
          title: entry.querySelector('title')?.textContent || '',
          snippet: entry.querySelector('summary')?.textContent || '',
          url: entry.querySelector('link')?.getAttribute('href') || '',
          source: 'SEC EDGAR',
          type: 'filing'
        }));
      } catch {
        return [];
      }
    }
  },

  /**
   * RDAP Domain WHOIS - Modern WHOIS replacement
   */
  async lookupDomainRDAP(domain) {
    try {
      // Clean domain
      domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();

      // Try RDAP bootstrap
      const url = `https://rdap.org/domain/${domain}`;
      const response = await this.fetchWithProxy(url);
      const data = await response.json();

      const results = [];

      // Domain status
      if (data.status) {
        results.push({
          title: 'Domain Status',
          snippet: data.status.join(', '),
          source: 'RDAP',
          type: 'whois'
        });
      }

      // Registrar
      if (data.entities) {
        data.entities.forEach(entity => {
          if (entity.roles?.includes('registrar')) {
            results.push({
              title: 'Registrar',
              snippet: entity.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || entity.handle || 'Unknown',
              source: 'RDAP',
              type: 'whois'
            });
          }
          if (entity.roles?.includes('registrant')) {
            const fn = entity.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3];
            if (fn) {
              results.push({
                title: 'Registrant',
                snippet: fn,
                source: 'RDAP',
                type: 'whois'
              });
            }
          }
        });
      }

      // Dates
      if (data.events) {
        data.events.forEach(event => {
          results.push({
            title: event.eventAction.replace(/([A-Z])/g, ' $1').trim(),
            snippet: new Date(event.eventDate).toLocaleDateString(),
            source: 'RDAP',
            type: 'whois'
          });
        });
      }

      // Nameservers
      if (data.nameservers) {
        results.push({
          title: 'Nameservers',
          snippet: data.nameservers.map(ns => ns.ldhName).join(', '),
          source: 'RDAP',
          type: 'whois'
        });
      }

      return results;
    } catch (e) {
      return [];
    }
  },

  /**
   * crt.sh - Certificate Transparency Search
   */
  async searchCertificates(domain) {
    try {
      domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const url = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;
      const response = await this.fetchWithProxy(url);
      const data = await response.json();

      // Dedupe by common name and get unique certs
      const seen = new Set();
      return data
        .filter(cert => {
          const key = cert.common_name + cert.issuer_name;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 20)
        .map(cert => ({
          title: cert.common_name,
          snippet: `Issuer: ${cert.issuer_name} | Valid: ${cert.not_before} to ${cert.not_after}`,
          url: `https://crt.sh/?id=${cert.id}`,
          source: 'crt.sh',
          type: 'certificate',
          issuer: cert.issuer_name
        }));
    } catch (e) {
      return [];
    }
  },

  /**
   * Phone number lookup via NumVerify-style API or scraping
   */
  async lookupPhone(phone) {
    // Clean phone number
    const originalPhone = phone;
    phone = phone.replace(/\D/g, '');
    if (phone.length === 10) phone = '1' + phone; // Add US country code

    const results = [];

    // FCC area code info
    const areaCode = phone.slice(-10, -7);
    const exchange = phone.slice(-7, -4);
    const lineNumber = phone.slice(-4);

    // Area code database (comprehensive US data)
    const areaCodeData = {
      '201': { state: 'New Jersey', city: 'Jersey City/Hackensack', timezone: 'EST' },
      '202': { state: 'Washington DC', city: 'Washington', timezone: 'EST' },
      '203': { state: 'Connecticut', city: 'New Haven/Stamford', timezone: 'EST' },
      '205': { state: 'Alabama', city: 'Birmingham', timezone: 'CST' },
      '206': { state: 'Washington', city: 'Seattle', timezone: 'PST' },
      '207': { state: 'Maine', city: 'Portland', timezone: 'EST' },
      '208': { state: 'Idaho', city: 'Boise', timezone: 'MST' },
      '209': { state: 'California', city: 'Stockton/Modesto', timezone: 'PST' },
      '210': { state: 'Texas', city: 'San Antonio', timezone: 'CST' },
      '212': { state: 'New York', city: 'Manhattan', timezone: 'EST' },
      '213': { state: 'California', city: 'Los Angeles', timezone: 'PST' },
      '214': { state: 'Texas', city: 'Dallas', timezone: 'CST' },
      '215': { state: 'Pennsylvania', city: 'Philadelphia', timezone: 'EST' },
      '216': { state: 'Ohio', city: 'Cleveland', timezone: 'EST' },
      '217': { state: 'Illinois', city: 'Springfield', timezone: 'CST' },
      '218': { state: 'Minnesota', city: 'Duluth', timezone: 'CST' },
      '219': { state: 'Indiana', city: 'Gary/Hammond', timezone: 'CST' },
      '224': { state: 'Illinois', city: 'Elgin/Waukegan', timezone: 'CST' },
      '225': { state: 'Louisiana', city: 'Baton Rouge', timezone: 'CST' },
      '228': { state: 'Mississippi', city: 'Gulfport/Biloxi', timezone: 'CST' },
      '229': { state: 'Georgia', city: 'Albany', timezone: 'EST' },
      '231': { state: 'Michigan', city: 'Muskegon/Traverse City', timezone: 'EST' },
      '234': { state: 'Ohio', city: 'Akron/Canton', timezone: 'EST' },
      '239': { state: 'Florida', city: 'Fort Myers/Naples', timezone: 'EST' },
      '240': { state: 'Maryland', city: 'Bethesda/Frederick', timezone: 'EST' },
      '248': { state: 'Michigan', city: 'Pontiac/Troy', timezone: 'EST' },
      '251': { state: 'Alabama', city: 'Mobile', timezone: 'CST' },
      '252': { state: 'North Carolina', city: 'Greenville/Rocky Mount', timezone: 'EST' },
      '253': { state: 'Washington', city: 'Tacoma', timezone: 'PST' },
      '254': { state: 'Texas', city: 'Waco/Killeen', timezone: 'CST' },
      '256': { state: 'Alabama', city: 'Huntsville/Decatur', timezone: 'CST' },
      '260': { state: 'Indiana', city: 'Fort Wayne', timezone: 'EST' },
      '262': { state: 'Wisconsin', city: 'Kenosha/Racine', timezone: 'CST' },
      '267': { state: 'Pennsylvania', city: 'Philadelphia', timezone: 'EST' },
      '269': { state: 'Michigan', city: 'Kalamazoo/Battle Creek', timezone: 'EST' },
      '270': { state: 'Kentucky', city: 'Bowling Green', timezone: 'CST' },
      '276': { state: 'Virginia', city: 'Bristol', timezone: 'EST' },
      '281': { state: 'Texas', city: 'Houston', timezone: 'CST' },
      '301': { state: 'Maryland', city: 'Rockville/Silver Spring', timezone: 'EST' },
      '302': { state: 'Delaware', city: 'Wilmington', timezone: 'EST' },
      '303': { state: 'Colorado', city: 'Denver', timezone: 'MST' },
      '304': { state: 'West Virginia', city: 'Charleston', timezone: 'EST' },
      '305': { state: 'Florida', city: 'Miami', timezone: 'EST' },
      '307': { state: 'Wyoming', city: 'Cheyenne', timezone: 'MST' },
      '308': { state: 'Nebraska', city: 'Grand Island', timezone: 'CST' },
      '309': { state: 'Illinois', city: 'Peoria', timezone: 'CST' },
      '310': { state: 'California', city: 'Los Angeles/Santa Monica', timezone: 'PST' },
      '312': { state: 'Illinois', city: 'Chicago (downtown)', timezone: 'CST' },
      '313': { state: 'Michigan', city: 'Detroit', timezone: 'EST' },
      '314': { state: 'Missouri', city: 'St. Louis', timezone: 'CST' },
      '315': { state: 'New York', city: 'Syracuse', timezone: 'EST' },
      '316': { state: 'Kansas', city: 'Wichita', timezone: 'CST' },
      '317': { state: 'Indiana', city: 'Indianapolis', timezone: 'EST' },
      '318': { state: 'Louisiana', city: 'Shreveport', timezone: 'CST' },
      '319': { state: 'Iowa', city: 'Cedar Rapids', timezone: 'CST' },
      '320': { state: 'Minnesota', city: 'St. Cloud', timezone: 'CST' },
      '321': { state: 'Florida', city: 'Orlando/Cape Canaveral', timezone: 'EST' },
      '323': { state: 'California', city: 'Los Angeles', timezone: 'PST' },
      '325': { state: 'Texas', city: 'Abilene', timezone: 'CST' },
      '330': { state: 'Ohio', city: 'Akron/Youngstown', timezone: 'EST' },
      '331': { state: 'Illinois', city: 'Aurora/Naperville', timezone: 'CST' },
      '334': { state: 'Alabama', city: 'Montgomery', timezone: 'CST' },
      '336': { state: 'North Carolina', city: 'Greensboro/Winston-Salem', timezone: 'EST' },
      '337': { state: 'Louisiana', city: 'Lafayette', timezone: 'CST' },
      '339': { state: 'Massachusetts', city: 'Boston suburbs', timezone: 'EST' },
      '347': { state: 'New York', city: 'NYC (Bronx/Brooklyn/Queens)', timezone: 'EST' },
      '351': { state: 'Massachusetts', city: 'Lowell', timezone: 'EST' },
      '352': { state: 'Florida', city: 'Gainesville/Ocala', timezone: 'EST' },
      '360': { state: 'Washington', city: 'Olympia/Vancouver', timezone: 'PST' },
      '361': { state: 'Texas', city: 'Corpus Christi', timezone: 'CST' },
      '385': { state: 'Utah', city: 'Salt Lake City', timezone: 'MST' },
      '386': { state: 'Florida', city: 'Daytona Beach', timezone: 'EST' },
      '401': { state: 'Rhode Island', city: 'Providence', timezone: 'EST' },
      '402': { state: 'Nebraska', city: 'Omaha/Lincoln', timezone: 'CST' },
      '404': { state: 'Georgia', city: 'Atlanta', timezone: 'EST' },
      '405': { state: 'Oklahoma', city: 'Oklahoma City', timezone: 'CST' },
      '406': { state: 'Montana', city: 'Billings', timezone: 'MST' },
      '407': { state: 'Florida', city: 'Orlando', timezone: 'EST' },
      '408': { state: 'California', city: 'San Jose', timezone: 'PST' },
      '409': { state: 'Texas', city: 'Beaumont/Galveston', timezone: 'CST' },
      '410': { state: 'Maryland', city: 'Baltimore', timezone: 'EST' },
      '412': { state: 'Pennsylvania', city: 'Pittsburgh', timezone: 'EST' },
      '413': { state: 'Massachusetts', city: 'Springfield', timezone: 'EST' },
      '414': { state: 'Wisconsin', city: 'Milwaukee', timezone: 'CST' },
      '415': { state: 'California', city: 'San Francisco', timezone: 'PST' },
      '417': { state: 'Missouri', city: 'Springfield', timezone: 'CST' },
      '419': { state: 'Ohio', city: 'Toledo', timezone: 'EST' },
      '423': { state: 'Tennessee', city: 'Chattanooga', timezone: 'EST' },
      '424': { state: 'California', city: 'Los Angeles', timezone: 'PST' },
      '425': { state: 'Washington', city: 'Bellevue/Redmond', timezone: 'PST' },
      '430': { state: 'Texas', city: 'Tyler/Longview', timezone: 'CST' },
      '432': { state: 'Texas', city: 'Midland/Odessa', timezone: 'CST' },
      '434': { state: 'Virginia', city: 'Lynchburg/Charlottesville', timezone: 'EST' },
      '435': { state: 'Utah', city: 'St. George/Logan', timezone: 'MST' },
      '440': { state: 'Ohio', city: 'Cleveland suburbs', timezone: 'EST' },
      '442': { state: 'California', city: 'Oceanside/Escondido', timezone: 'PST' },
      '443': { state: 'Maryland', city: 'Baltimore', timezone: 'EST' },
      '469': { state: 'Texas', city: 'Dallas', timezone: 'CST' },
      '470': { state: 'Georgia', city: 'Atlanta', timezone: 'EST' },
      '475': { state: 'Connecticut', city: 'New Haven/Bridgeport', timezone: 'EST' },
      '478': { state: 'Georgia', city: 'Macon', timezone: 'EST' },
      '479': { state: 'Arkansas', city: 'Fort Smith', timezone: 'CST' },
      '480': { state: 'Arizona', city: 'Mesa/Scottsdale', timezone: 'MST' },
      '484': { state: 'Pennsylvania', city: 'Allentown/Reading', timezone: 'EST' },
      '501': { state: 'Arkansas', city: 'Little Rock', timezone: 'CST' },
      '502': { state: 'Kentucky', city: 'Louisville', timezone: 'EST' },
      '503': { state: 'Oregon', city: 'Portland', timezone: 'PST' },
      '504': { state: 'Louisiana', city: 'New Orleans', timezone: 'CST' },
      '505': { state: 'New Mexico', city: 'Albuquerque', timezone: 'MST' },
      '507': { state: 'Minnesota', city: 'Rochester', timezone: 'CST' },
      '508': { state: 'Massachusetts', city: 'Worcester', timezone: 'EST' },
      '509': { state: 'Washington', city: 'Spokane', timezone: 'PST' },
      '510': { state: 'California', city: 'Oakland/Fremont', timezone: 'PST' },
      '512': { state: 'Texas', city: 'Austin', timezone: 'CST' },
      '513': { state: 'Ohio', city: 'Cincinnati', timezone: 'EST' },
      '515': { state: 'Iowa', city: 'Des Moines', timezone: 'CST' },
      '516': { state: 'New York', city: 'Long Island (Nassau)', timezone: 'EST' },
      '517': { state: 'Michigan', city: 'Lansing', timezone: 'EST' },
      '518': { state: 'New York', city: 'Albany', timezone: 'EST' },
      '520': { state: 'Arizona', city: 'Tucson', timezone: 'MST' },
      '530': { state: 'California', city: 'Redding/Chico', timezone: 'PST' },
      '531': { state: 'Nebraska', city: 'Omaha', timezone: 'CST' },
      '540': { state: 'Virginia', city: 'Roanoke', timezone: 'EST' },
      '541': { state: 'Oregon', city: 'Eugene', timezone: 'PST' },
      '551': { state: 'New Jersey', city: 'Jersey City', timezone: 'EST' },
      '559': { state: 'California', city: 'Fresno', timezone: 'PST' },
      '561': { state: 'Florida', city: 'West Palm Beach', timezone: 'EST' },
      '562': { state: 'California', city: 'Long Beach', timezone: 'PST' },
      '563': { state: 'Iowa', city: 'Davenport', timezone: 'CST' },
      '567': { state: 'Ohio', city: 'Toledo', timezone: 'EST' },
      '570': { state: 'Pennsylvania', city: 'Scranton', timezone: 'EST' },
      '571': { state: 'Virginia', city: 'Arlington/Alexandria', timezone: 'EST' },
      '573': { state: 'Missouri', city: 'Columbia/Jefferson City', timezone: 'CST' },
      '574': { state: 'Indiana', city: 'South Bend', timezone: 'EST' },
      '575': { state: 'New Mexico', city: 'Las Cruces', timezone: 'MST' },
      '580': { state: 'Oklahoma', city: 'Lawton', timezone: 'CST' },
      '585': { state: 'New York', city: 'Rochester', timezone: 'EST' },
      '586': { state: 'Michigan', city: 'Warren/Sterling Heights', timezone: 'EST' },
      '601': { state: 'Mississippi', city: 'Jackson', timezone: 'CST' },
      '602': { state: 'Arizona', city: 'Phoenix', timezone: 'MST' },
      '603': { state: 'New Hampshire', city: 'Manchester', timezone: 'EST' },
      '605': { state: 'South Dakota', city: 'Sioux Falls', timezone: 'CST' },
      '606': { state: 'Kentucky', city: 'Ashland', timezone: 'EST' },
      '607': { state: 'New York', city: 'Binghamton', timezone: 'EST' },
      '608': { state: 'Wisconsin', city: 'Madison', timezone: 'CST' },
      '609': { state: 'New Jersey', city: 'Trenton/Atlantic City', timezone: 'EST' },
      '610': { state: 'Pennsylvania', city: 'Allentown/Bethlehem', timezone: 'EST' },
      '612': { state: 'Minnesota', city: 'Minneapolis', timezone: 'CST' },
      '614': { state: 'Ohio', city: 'Columbus', timezone: 'EST' },
      '615': { state: 'Tennessee', city: 'Nashville', timezone: 'CST' },
      '616': { state: 'Michigan', city: 'Grand Rapids', timezone: 'EST' },
      '617': { state: 'Massachusetts', city: 'Boston', timezone: 'EST' },
      '618': { state: 'Illinois', city: 'East St. Louis/Belleville', timezone: 'CST' },
      '619': { state: 'California', city: 'San Diego', timezone: 'PST' },
      '620': { state: 'Kansas', city: 'Hutchinson/Dodge City', timezone: 'CST' },
      '623': { state: 'Arizona', city: 'Phoenix (west)', timezone: 'MST' },
      '626': { state: 'California', city: 'Pasadena', timezone: 'PST' },
      '628': { state: 'California', city: 'San Francisco', timezone: 'PST' },
      '629': { state: 'Tennessee', city: 'Nashville', timezone: 'CST' },
      '630': { state: 'Illinois', city: 'Aurora/Naperville', timezone: 'CST' },
      '631': { state: 'New York', city: 'Long Island (Suffolk)', timezone: 'EST' },
      '636': { state: 'Missouri', city: 'St. Louis suburbs', timezone: 'CST' },
      '641': { state: 'Iowa', city: 'Mason City', timezone: 'CST' },
      '646': { state: 'New York', city: 'Manhattan', timezone: 'EST' },
      '650': { state: 'California', city: 'San Mateo/Palo Alto', timezone: 'PST' },
      '651': { state: 'Minnesota', city: 'St. Paul', timezone: 'CST' },
      '657': { state: 'California', city: 'Anaheim', timezone: 'PST' },
      '660': { state: 'Missouri', city: 'Sedalia', timezone: 'CST' },
      '661': { state: 'California', city: 'Bakersfield', timezone: 'PST' },
      '662': { state: 'Mississippi', city: 'Tupelo/Greenville', timezone: 'CST' },
      '667': { state: 'Maryland', city: 'Baltimore', timezone: 'EST' },
      '669': { state: 'California', city: 'San Jose', timezone: 'PST' },
      '678': { state: 'Georgia', city: 'Atlanta', timezone: 'EST' },
      '681': { state: 'West Virginia', city: 'All WV', timezone: 'EST' },
      '682': { state: 'Texas', city: 'Fort Worth', timezone: 'CST' },
      '689': { state: 'Florida', city: 'Orlando', timezone: 'EST' },
      '701': { state: 'North Dakota', city: 'Fargo', timezone: 'CST' },
      '702': { state: 'Nevada', city: 'Las Vegas', timezone: 'PST' },
      '703': { state: 'Virginia', city: 'Arlington/Alexandria', timezone: 'EST' },
      '704': { state: 'North Carolina', city: 'Charlotte', timezone: 'EST' },
      '706': { state: 'Georgia', city: 'Augusta/Columbus', timezone: 'EST' },
      '707': { state: 'California', city: 'Santa Rosa/Napa', timezone: 'PST' },
      '708': { state: 'Illinois', city: 'Chicago (south suburbs)', timezone: 'CST' },
      '712': { state: 'Iowa', city: 'Sioux City', timezone: 'CST' },
      '713': { state: 'Texas', city: 'Houston', timezone: 'CST' },
      '714': { state: 'California', city: 'Orange County/Anaheim', timezone: 'PST' },
      '715': { state: 'Wisconsin', city: 'Eau Claire/Wausau', timezone: 'CST' },
      '716': { state: 'New York', city: 'Buffalo', timezone: 'EST' },
      '717': { state: 'Pennsylvania', city: 'Harrisburg/Lancaster', timezone: 'EST' },
      '718': { state: 'New York', city: 'NYC (Bronx/Brooklyn/Queens)', timezone: 'EST' },
      '719': { state: 'Colorado', city: 'Colorado Springs/Pueblo', timezone: 'MST' },
      '720': { state: 'Colorado', city: 'Denver', timezone: 'MST' },
      '724': { state: 'Pennsylvania', city: 'Pittsburgh suburbs', timezone: 'EST' },
      '725': { state: 'Nevada', city: 'Las Vegas', timezone: 'PST' },
      '727': { state: 'Florida', city: 'St. Petersburg/Clearwater', timezone: 'EST' },
      '731': { state: 'Tennessee', city: 'Jackson', timezone: 'CST' },
      '732': { state: 'New Jersey', city: 'New Brunswick', timezone: 'EST' },
      '734': { state: 'Michigan', city: 'Ann Arbor', timezone: 'EST' },
      '737': { state: 'Texas', city: 'Austin', timezone: 'CST' },
      '740': { state: 'Ohio', city: 'Zanesville/Lancaster', timezone: 'EST' },
      '747': { state: 'California', city: 'Glendale/Burbank', timezone: 'PST' },
      '754': { state: 'Florida', city: 'Fort Lauderdale', timezone: 'EST' },
      '757': { state: 'Virginia', city: 'Norfolk/Virginia Beach', timezone: 'EST' },
      '760': { state: 'California', city: 'Palm Springs/Escondido', timezone: 'PST' },
      '762': { state: 'Georgia', city: 'Augusta', timezone: 'EST' },
      '763': { state: 'Minnesota', city: 'Minneapolis suburbs', timezone: 'CST' },
      '765': { state: 'Indiana', city: 'Muncie/Lafayette', timezone: 'EST' },
      '769': { state: 'Mississippi', city: 'Jackson', timezone: 'CST' },
      '770': { state: 'Georgia', city: 'Atlanta suburbs', timezone: 'EST' },
      '772': { state: 'Florida', city: 'Vero Beach/Port St. Lucie', timezone: 'EST' },
      '773': { state: 'Illinois', city: 'Chicago', timezone: 'CST' },
      '774': { state: 'Massachusetts', city: 'Worcester', timezone: 'EST' },
      '775': { state: 'Nevada', city: 'Reno/Carson City', timezone: 'PST' },
      '779': { state: 'Illinois', city: 'Rockford', timezone: 'CST' },
      '781': { state: 'Massachusetts', city: 'Boston suburbs', timezone: 'EST' },
      '785': { state: 'Kansas', city: 'Topeka', timezone: 'CST' },
      '786': { state: 'Florida', city: 'Miami', timezone: 'EST' },
      '801': { state: 'Utah', city: 'Salt Lake City', timezone: 'MST' },
      '802': { state: 'Vermont', city: 'Burlington', timezone: 'EST' },
      '803': { state: 'South Carolina', city: 'Columbia', timezone: 'EST' },
      '804': { state: 'Virginia', city: 'Richmond', timezone: 'EST' },
      '805': { state: 'California', city: 'Santa Barbara/Ventura', timezone: 'PST' },
      '806': { state: 'Texas', city: 'Lubbock/Amarillo', timezone: 'CST' },
      '808': { state: 'Hawaii', city: 'Honolulu', timezone: 'HST' },
      '810': { state: 'Michigan', city: 'Flint', timezone: 'EST' },
      '812': { state: 'Indiana', city: 'Evansville/Bloomington', timezone: 'EST' },
      '813': { state: 'Florida', city: 'Tampa', timezone: 'EST' },
      '814': { state: 'Pennsylvania', city: 'Erie', timezone: 'EST' },
      '815': { state: 'Illinois', city: 'Rockford/Joliet', timezone: 'CST' },
      '816': { state: 'Missouri', city: 'Kansas City', timezone: 'CST' },
      '817': { state: 'Texas', city: 'Fort Worth', timezone: 'CST' },
      '818': { state: 'California', city: 'San Fernando Valley', timezone: 'PST' },
      '828': { state: 'North Carolina', city: 'Asheville', timezone: 'EST' },
      '830': { state: 'Texas', city: 'Fredericksburg', timezone: 'CST' },
      '831': { state: 'California', city: 'Monterey/Santa Cruz', timezone: 'PST' },
      '832': { state: 'Texas', city: 'Houston', timezone: 'CST' },
      '843': { state: 'South Carolina', city: 'Charleston', timezone: 'EST' },
      '845': { state: 'New York', city: 'Poughkeepsie', timezone: 'EST' },
      '847': { state: 'Illinois', city: 'Chicago (north suburbs)', timezone: 'CST' },
      '848': { state: 'New Jersey', city: 'New Brunswick', timezone: 'EST' },
      '850': { state: 'Florida', city: 'Tallahassee/Pensacola', timezone: 'EST/CST' },
      '856': { state: 'New Jersey', city: 'Camden/Vineland', timezone: 'EST' },
      '857': { state: 'Massachusetts', city: 'Boston', timezone: 'EST' },
      '858': { state: 'California', city: 'San Diego (north)', timezone: 'PST' },
      '859': { state: 'Kentucky', city: 'Lexington', timezone: 'EST' },
      '860': { state: 'Connecticut', city: 'Hartford', timezone: 'EST' },
      '862': { state: 'New Jersey', city: 'Newark', timezone: 'EST' },
      '863': { state: 'Florida', city: 'Lakeland', timezone: 'EST' },
      '864': { state: 'South Carolina', city: 'Greenville/Spartanburg', timezone: 'EST' },
      '865': { state: 'Tennessee', city: 'Knoxville', timezone: 'EST' },
      '870': { state: 'Arkansas', city: 'Jonesboro', timezone: 'CST' },
      '872': { state: 'Illinois', city: 'Chicago', timezone: 'CST' },
      '878': { state: 'Pennsylvania', city: 'Pittsburgh', timezone: 'EST' },
      '901': { state: 'Tennessee', city: 'Memphis', timezone: 'CST' },
      '903': { state: 'Texas', city: 'Tyler', timezone: 'CST' },
      '904': { state: 'Florida', city: 'Jacksonville', timezone: 'EST' },
      '906': { state: 'Michigan', city: 'Upper Peninsula', timezone: 'EST/CST' },
      '907': { state: 'Alaska', city: 'Anchorage', timezone: 'AKST' },
      '908': { state: 'New Jersey', city: 'Elizabeth/Union', timezone: 'EST' },
      '909': { state: 'California', city: 'San Bernardino/Ontario', timezone: 'PST' },
      '910': { state: 'North Carolina', city: 'Fayetteville/Wilmington', timezone: 'EST' },
      '912': { state: 'Georgia', city: 'Savannah', timezone: 'EST' },
      '913': { state: 'Kansas', city: 'Kansas City/Overland Park', timezone: 'CST' },
      '914': { state: 'New York', city: 'Westchester', timezone: 'EST' },
      '915': { state: 'Texas', city: 'El Paso', timezone: 'MST' },
      '916': { state: 'California', city: 'Sacramento', timezone: 'PST' },
      '917': { state: 'New York', city: 'NYC (mobile)', timezone: 'EST' },
      '918': { state: 'Oklahoma', city: 'Tulsa', timezone: 'CST' },
      '919': { state: 'North Carolina', city: 'Raleigh/Durham', timezone: 'EST' },
      '920': { state: 'Wisconsin', city: 'Green Bay/Appleton', timezone: 'CST' },
      '925': { state: 'California', city: 'Concord/Walnut Creek', timezone: 'PST' },
      '928': { state: 'Arizona', city: 'Flagstaff/Yuma', timezone: 'MST' },
      '929': { state: 'New York', city: 'NYC (Bronx/Brooklyn/Queens)', timezone: 'EST' },
      '931': { state: 'Tennessee', city: 'Clarksville', timezone: 'CST' },
      '936': { state: 'Texas', city: 'Conroe/Huntsville', timezone: 'CST' },
      '937': { state: 'Ohio', city: 'Dayton', timezone: 'EST' },
      '938': { state: 'Alabama', city: 'Huntsville', timezone: 'CST' },
      '940': { state: 'Texas', city: 'Denton/Wichita Falls', timezone: 'CST' },
      '941': { state: 'Florida', city: 'Sarasota/Bradenton', timezone: 'EST' },
      '947': { state: 'Michigan', city: 'Troy/Pontiac', timezone: 'EST' },
      '949': { state: 'California', city: 'Irvine/Orange County (south)', timezone: 'PST' },
      '951': { state: 'California', city: 'Riverside/Corona', timezone: 'PST' },
      '952': { state: 'Minnesota', city: 'Minneapolis (south suburbs)', timezone: 'CST' },
      '954': { state: 'Florida', city: 'Fort Lauderdale', timezone: 'EST' },
      '956': { state: 'Texas', city: 'Laredo/Brownsville', timezone: 'CST' },
      '959': { state: 'Connecticut', city: 'Hartford', timezone: 'EST' },
      '970': { state: 'Colorado', city: 'Fort Collins/Aspen', timezone: 'MST' },
      '971': { state: 'Oregon', city: 'Portland', timezone: 'PST' },
      '972': { state: 'Texas', city: 'Dallas', timezone: 'CST' },
      '973': { state: 'New Jersey', city: 'Newark/Paterson', timezone: 'EST' },
      '978': { state: 'Massachusetts', city: 'Lowell', timezone: 'EST' },
      '979': { state: 'Texas', city: 'College Station', timezone: 'CST' },
      '980': { state: 'North Carolina', city: 'Charlotte', timezone: 'EST' },
      '984': { state: 'North Carolina', city: 'Raleigh', timezone: 'EST' },
      '985': { state: 'Louisiana', city: 'Houma', timezone: 'CST' },
      '989': { state: 'Michigan', city: 'Saginaw', timezone: 'EST' }
    };

    // Phone type detection (rough heuristic based on exchange)
    const mobileExchanges = ['200', '201', '202', '203', '204', '205', '206', '207', '208', '209', '210'];
    const probablyMobile = parseInt(exchange) >= 200 && parseInt(exchange) <= 999;

    // Add location info
    if (areaCodeData[areaCode]) {
      const info = areaCodeData[areaCode];
      results.push({
        title: 'Location',
        snippet: `${info.city}, ${info.state}`,
        source: 'Area Code DB',
        type: 'phone'
      });
      results.push({
        title: 'Area Code',
        snippet: areaCode,
        source: 'Area Code DB',
        type: 'phone'
      });
      results.push({
        title: 'Time Zone',
        snippet: info.timezone,
        source: 'Area Code DB',
        type: 'phone'
      });
    }

    // Format display
    const formatted = phone.length === 11
      ? `+${phone[0]} (${areaCode}) ${exchange}-${lineNumber}`
      : phone;
    results.push({
      title: 'Formatted Number',
      snippet: formatted,
      source: 'Parser',
      type: 'phone'
    });

    // Phone type guess
    results.push({
      title: 'Line Type',
      snippet: probablyMobile ? 'Mobile/Wireless (likely)' : 'Landline/VoIP (likely)',
      source: 'Heuristic',
      type: 'phone'
    });

    // NumVerify alternative - use a free carrier lookup if available
    try {
      // Try to get additional info from FCC's API (public NANPA data)
      // This is a rough approximation since most free APIs have limits
      const countryCode = phone.length === 11 && phone.startsWith('1') ? 'US' : 'Unknown';
      results.push({
        title: 'Country',
        snippet: countryCode === 'US' ? 'United States (+1)' : countryCode,
        source: 'NANPA',
        type: 'phone'
      });
    } catch (e) {}

    // Search for phone in public records via multiple engines
    try {
      const ddgResults = await this.searchDuckDuckGoHTML(`"${formatted}" OR "${phone.slice(-10)}" phone`);
      if (ddgResults.length > 0) {
        results.push({
          title: 'Web Mentions',
          snippet: `Found ${ddgResults.length} web results mentioning this number`,
          source: 'DuckDuckGo',
          type: 'phone'
        });
      }
      // Add first few actual results for context
      results.push(...ddgResults.slice(0, 3).map(r => ({ ...r, type: 'phone' })));
    } catch (e) {}

    // Add direct search links
    results.push({
      title: 'Search on Whitepages',
      snippet: 'Look up owner & address',
      url: `https://www.whitepages.com/phone/${phone.slice(-10)}`,
      source: 'Whitepages',
      type: 'phone'
    });
    results.push({
      title: 'Search on SpyDialer',
      snippet: 'Free reverse lookup',
      url: `https://www.spydialer.com/results.aspx?q=${phone.slice(-10)}`,
      source: 'SpyDialer',
      type: 'phone'
    });
    results.push({
      title: 'Search on TrueCaller',
      snippet: 'Caller ID lookup',
      url: `https://www.truecaller.com/search/us/${phone.slice(-10)}`,
      source: 'TrueCaller',
      type: 'phone'
    });
    results.push({
      title: 'Search on NumLookup',
      snippet: 'Free carrier lookup',
      url: `https://www.numlookup.com/phone/${phone}`,
      source: 'NumLookup',
      type: 'phone'
    });

    return results;
  },

  /**
   * IP Geolocation - Free API
   */
  async lookupIP(ip) {
    try {
      // ip-api.com (free, no key needed)
      const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,query`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.status === 'success') {
        return [
          { title: 'IP Address', snippet: data.query, source: 'ip-api', type: 'ip' },
          { title: 'Location', snippet: `${data.city}, ${data.regionName}, ${data.country}`, source: 'ip-api', type: 'ip' },
          { title: 'ISP', snippet: data.isp, source: 'ip-api', type: 'ip' },
          { title: 'Organization', snippet: data.org, source: 'ip-api', type: 'ip' },
          { title: 'ASN', snippet: `${data.as} (${data.asname})`, source: 'ip-api', type: 'ip' },
          { title: 'Coordinates', snippet: `${data.lat}, ${data.lon}`, source: 'ip-api', type: 'ip' },
          { title: 'Timezone', snippet: data.timezone, source: 'ip-api', type: 'ip' },
        ].filter(r => r.snippet);
      }
      return [];
    } catch (e) {
      return [];
    }
  },

  /**
   * DNS Lookup
   */
  async lookupDNS(domain) {
    try {
      domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

      // Use Google DNS-over-HTTPS
      const types = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'];
      const results = [];

      for (const type of types) {
        try {
          const url = `https://dns.google/resolve?name=${domain}&type=${type}`;
          const response = await fetch(url);
          const data = await response.json();

          if (data.Answer) {
            data.Answer.forEach(record => {
              results.push({
                title: `${type} Record`,
                snippet: record.data,
                source: 'Google DNS',
                type: 'dns'
              });
            });
          }
        } catch (e) {}
      }

      return results;
    } catch (e) {
      return [];
    }
  },

  /**
   * VIN (Vehicle Identification Number) Lookup
   */
  async lookupVIN(vin) {
    vin = vin.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
    if (vin.length !== 17) {
      return [{ title: 'Error', snippet: 'VIN must be exactly 17 characters', type: 'vin' }];
    }

    const results = [];

    // Decode VIN structure
    const wmi = vin.substring(0, 3); // World Manufacturer Identifier
    const vds = vin.substring(3, 9); // Vehicle Descriptor Section
    const vis = vin.substring(9, 17); // Vehicle Identifier Section
    const year = vin.charAt(9);
    const plant = vin.charAt(10);
    const serial = vin.substring(11, 17);

    // Year decoder (1980-2039)
    const yearCodes = {
      'A': 1980, 'B': 1981, 'C': 1982, 'D': 1983, 'E': 1984, 'F': 1985, 'G': 1986, 'H': 1987,
      'J': 1988, 'K': 1989, 'L': 1990, 'M': 1991, 'N': 1992, 'P': 1993, 'R': 1994, 'S': 1995,
      'T': 1996, 'V': 1997, 'W': 1998, 'X': 1999, 'Y': 2000, '1': 2001, '2': 2002, '3': 2003,
      '4': 2004, '5': 2005, '6': 2006, '7': 2007, '8': 2008, '9': 2009, 'A': 2010, 'B': 2011,
      'C': 2012, 'D': 2013, 'E': 2014, 'F': 2015, 'G': 2016, 'H': 2017, 'J': 2018, 'K': 2019,
      'L': 2020, 'M': 2021, 'N': 2022, 'P': 2023, 'R': 2024, 'S': 2025
    };

    // Country of origin from WMI
    const countryPrefixes = {
      '1': 'United States', '2': 'Canada', '3': 'Mexico', '4': 'United States', '5': 'United States',
      'J': 'Japan', 'K': 'South Korea', 'L': 'China', 'S': 'United Kingdom', 'V': 'France/Spain',
      'W': 'Germany', 'Y': 'Sweden/Finland', 'Z': 'Italy', '9': 'Brazil'
    };

    // Manufacturer from WMI
    const manufacturers = {
      '1G1': 'Chevrolet', '1G2': 'Pontiac', '1GC': 'Chevrolet Truck', '1GT': 'GMC Truck',
      '1GY': 'Cadillac', '1HG': 'Honda', '1J4': 'Jeep', '1FA': 'Ford', '1FB': 'Ford',
      '1FC': 'Ford', '1FD': 'Ford', '1FM': 'Ford', '1FT': 'Ford Truck', '1FU': 'Freightliner',
      '1G6': 'Cadillac', '1GM': 'Pontiac', '1GN': 'Chevrolet/GMC', '1N4': 'Nissan',
      '1NX': 'Toyota', '1VW': 'Volkswagen', '1YV': 'Mazda', '1ZV': 'Ford (Mazda)',
      '2C3': 'Chrysler', '2D4': 'Dodge', '2FA': 'Ford Canada', '2G1': 'Chevrolet Canada',
      '2HG': 'Honda Canada', '2HM': 'Hyundai Canada', '2T1': 'Toyota Canada',
      '3FA': 'Ford Mexico', '3G1': 'Chevrolet Mexico', '3GN': 'GMC Mexico',
      '3VW': 'Volkswagen Mexico', '4F2': 'Mazda', '4S3': 'Subaru', '4S4': 'Subaru',
      '4T1': 'Toyota', '4US': 'BMW', '5FN': 'Honda', '5J6': 'Honda', '5NP': 'Hyundai',
      '5TD': 'Toyota', '5XY': 'Kia', 'JA3': 'Mitsubishi', 'JA4': 'Mitsubishi', 'JF1': 'Subaru',
      'JF2': 'Subaru', 'JH4': 'Acura', 'JHM': 'Honda', 'JM1': 'Mazda', 'JN1': 'Nissan',
      'JN8': 'Nissan', 'JT2': 'Toyota', 'JT3': 'Toyota', 'JT4': 'Toyota', 'JTE': 'Toyota',
      'KL4': 'Daewoo', 'KM8': 'Hyundai', 'KNA': 'Kia', 'KNB': 'Kia', 'KND': 'Kia',
      'SAJ': 'Jaguar', 'SAL': 'Land Rover', 'SCC': 'Lotus', 'SCF': 'Aston Martin',
      'WA1': 'Audi', 'WAU': 'Audi', 'WBA': 'BMW', 'WBS': 'BMW M', 'WDB': 'Mercedes-Benz',
      'WDD': 'Mercedes-Benz', 'WDC': 'Mercedes-Benz', 'WF0': 'Ford Germany',
      'WMW': 'Mini', 'WP0': 'Porsche', 'WP1': 'Porsche', 'WUA': 'Audi', 'WV1': 'Volkswagen',
      'WV2': 'Volkswagen', 'WVW': 'Volkswagen', 'YV1': 'Volvo', 'YV4': 'Volvo',
      'ZAM': 'Maserati', 'ZAR': 'Alfa Romeo', 'ZFF': 'Ferrari'
    };

    // Get country
    const countryCode = vin.charAt(0);
    const country = countryPrefixes[countryCode] || 'Unknown';

    // Get manufacturer
    const mfr = manufacturers[wmi] || 'Unknown Manufacturer';

    // Get model year (handle both cycles)
    let modelYear = yearCodes[year];
    if (year >= 'A' && year <= 'Y') {
      // Could be 1980s or 2010s - use 7th digit check
      const checkDigit = parseInt(vin.charAt(6));
      if (!isNaN(checkDigit) && checkDigit > 5) modelYear += 30;
    }

    results.push({ title: 'VIN', snippet: vin, source: 'VIN Decoder', type: 'vin' });
    results.push({ title: 'Manufacturer', snippet: mfr, source: 'VIN Decoder', type: 'vin' });
    results.push({ title: 'Country of Origin', snippet: country, source: 'VIN Decoder', type: 'vin' });
    if (modelYear) {
      results.push({ title: 'Model Year', snippet: String(modelYear), source: 'VIN Decoder', type: 'vin' });
    }
    results.push({ title: 'Plant Code', snippet: plant, source: 'VIN Decoder', type: 'vin' });
    results.push({ title: 'Serial Number', snippet: serial, source: 'VIN Decoder', type: 'vin' });

    // Try NHTSA API (free, no key needed)
    try {
      const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
      const data = await response.json();
      if (data.Results) {
        const fields = ['Make', 'Model', 'ModelYear', 'BodyClass', 'DriveType', 'FuelTypePrimary', 'EngineCylinders', 'DisplacementL', 'VehicleType', 'PlantCity', 'PlantState', 'PlantCountry'];
        data.Results.forEach(item => {
          if (fields.includes(item.Variable) && item.Value && item.Value.trim()) {
            results.push({
              title: item.Variable.replace(/([A-Z])/g, ' $1').trim(),
              snippet: item.Value,
              source: 'NHTSA',
              type: 'vin'
            });
          }
        });
      }
    } catch (e) {}

    // Add lookup links
    results.push({
      title: 'Search on NICB VINCheck',
      snippet: 'Check theft/total loss records',
      url: `https://www.nicb.org/vincheck`,
      source: 'NICB',
      type: 'vin'
    });
    results.push({
      title: 'Search on VehicleHistory',
      snippet: 'Free vehicle history',
      url: `https://www.vehiclehistory.com/vin-report/${vin}`,
      source: 'VehicleHistory',
      type: 'vin'
    });

    return results;
  },

  /**
   * Email Address Lookup
   */
  async lookupEmail(email) {
    email = email.toLowerCase().trim();
    const results = [];

    // Parse email parts
    const parts = email.split('@');
    if (parts.length !== 2) {
      return [{ title: 'Error', snippet: 'Invalid email format', type: 'email' }];
    }

    const [localPart, domain] = parts;
    results.push({ title: 'Email', snippet: email, source: 'Parser', type: 'email' });
    results.push({ title: 'Local Part', snippet: localPart, source: 'Parser', type: 'email' });
    results.push({ title: 'Domain', snippet: domain, source: 'Parser', type: 'email' });

    // Common email provider detection
    const providers = {
      'gmail.com': 'Google Gmail',
      'googlemail.com': 'Google Gmail',
      'yahoo.com': 'Yahoo Mail',
      'outlook.com': 'Microsoft Outlook',
      'hotmail.com': 'Microsoft Hotmail',
      'live.com': 'Microsoft Live',
      'msn.com': 'Microsoft MSN',
      'aol.com': 'AOL Mail',
      'icloud.com': 'Apple iCloud',
      'me.com': 'Apple Mail',
      'protonmail.com': 'ProtonMail (Encrypted)',
      'proton.me': 'Proton Mail (Encrypted)',
      'tutanota.com': 'Tutanota (Encrypted)',
      'fastmail.com': 'FastMail',
      'zoho.com': 'Zoho Mail',
      'yandex.com': 'Yandex Mail',
      'mail.ru': 'Mail.ru',
      'gmx.com': 'GMX Mail',
      'gmx.net': 'GMX Mail'
    };

    if (providers[domain]) {
      results.push({ title: 'Provider', snippet: providers[domain], source: 'Known Providers', type: 'email' });
    }

    // Check if disposable email domain
    const disposableDomains = ['tempmail.com', 'guerrillamail.com', '10minutemail.com', 'mailinator.com', 'throwaway.email', 'temp-mail.org', 'fakeinbox.com', 'sharklasers.com', 'yopmail.com', 'maildrop.cc'];
    if (disposableDomains.some(d => domain.includes(d))) {
      results.push({ title: 'Warning', snippet: 'Disposable/temporary email detected', source: 'Analysis', type: 'email' });
    }

    // Try to get MX records for the domain (validates domain accepts email)
    try {
      const dnsUrl = `https://dns.google/resolve?name=${domain}&type=MX`;
      const response = await fetch(dnsUrl);
      const data = await response.json();
      if (data.Answer && data.Answer.length > 0) {
        results.push({
          title: 'Mail Server',
          snippet: data.Answer[0].data.split(' ').pop(),
          source: 'DNS',
          type: 'email'
        });
        results.push({
          title: 'Domain Status',
          snippet: 'Valid (has MX records)',
          source: 'DNS',
          type: 'email'
        });
      } else {
        results.push({
          title: 'Domain Status',
          snippet: 'No MX records (may not receive email)',
          source: 'DNS',
          type: 'email'
        });
      }
    } catch (e) {}

    // Gravatar check (public)
    try {
      const md5 = await this.md5Hash(email);
      results.push({
        title: 'Gravatar',
        snippet: 'Check for profile image',
        url: `https://www.gravatar.com/${md5}`,
        source: 'Gravatar',
        type: 'email'
      });
    } catch (e) {}

    // Search for email on web
    try {
      const ddgResults = await this.searchDuckDuckGoHTML(`"${email}"`);
      if (ddgResults.length > 0) {
        results.push({
          title: 'Web Presence',
          snippet: `Found ${ddgResults.length} mentions online`,
          source: 'Web Search',
          type: 'email'
        });
      }
    } catch (e) {}

    // Add lookup links
    results.push({
      title: 'Search on Have I Been Pwned',
      snippet: 'Check for data breaches',
      url: `https://haveibeenpwned.com/unifiedsearch/${encodeURIComponent(email)}`,
      source: 'HIBP',
      type: 'email'
    });
    results.push({
      title: 'Search on Hunter.io',
      snippet: 'Email verification',
      url: `https://hunter.io/email-verifier/${encodeURIComponent(email)}`,
      source: 'Hunter',
      type: 'email'
    });

    return results;
  },

  // Simple MD5 hash for Gravatar (client-side)
  async md5Hash(str) {
    const msgBuffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('MD5', msgBuffer).catch(() => null);
    if (!hashBuffer) {
      // Fallback: simple hash for gravatar URL
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return Math.abs(hash).toString(16);
    }
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /**
   * Username Lookup
   */
  async lookupUsername(username) {
    username = username.toLowerCase().trim().replace(/^@/, '');
    const results = [];

    results.push({ title: 'Username', snippet: username, source: 'Parser', type: 'username' });

    // Common platform checks
    const platforms = [
      { name: 'Twitter/X', url: `https://twitter.com/${username}`, check: `twitter.com/${username}` },
      { name: 'Instagram', url: `https://instagram.com/${username}`, check: `instagram.com/${username}` },
      { name: 'GitHub', url: `https://github.com/${username}`, check: `github.com/${username}` },
      { name: 'Reddit', url: `https://reddit.com/user/${username}`, check: `reddit.com/user/${username}` },
      { name: 'TikTok', url: `https://tiktok.com/@${username}`, check: `tiktok.com/@${username}` },
      { name: 'LinkedIn', url: `https://linkedin.com/in/${username}`, check: `linkedin.com/in/${username}` },
      { name: 'Facebook', url: `https://facebook.com/${username}`, check: `facebook.com/${username}` },
      { name: 'YouTube', url: `https://youtube.com/@${username}`, check: `youtube.com/@${username}` },
      { name: 'Pinterest', url: `https://pinterest.com/${username}`, check: `pinterest.com/${username}` },
      { name: 'Twitch', url: `https://twitch.tv/${username}`, check: `twitch.tv/${username}` },
      { name: 'Steam', url: `https://steamcommunity.com/id/${username}`, check: `steamcommunity.com/id/${username}` },
      { name: 'Spotify', url: `https://open.spotify.com/user/${username}`, check: `open.spotify.com/user/${username}` },
      { name: 'Medium', url: `https://medium.com/@${username}`, check: `medium.com/@${username}` },
      { name: 'Telegram', url: `https://t.me/${username}`, check: `t.me/${username}` }
    ];

    // Add direct links
    platforms.forEach(p => {
      results.push({
        title: p.name,
        snippet: `Check profile`,
        url: p.url,
        source: p.name,
        type: 'username'
      });
    });

    // Search across web
    try {
      const ddgResults = await this.searchDuckDuckGoHTML(`"${username}" profile OR account`);
      if (ddgResults.length > 0) {
        results.push({
          title: 'Web Presence',
          snippet: `Found ${ddgResults.length} potential matches`,
          source: 'Web Search',
          type: 'username'
        });
      }
    } catch (e) {}

    // Add OSINT tool links
    results.push({
      title: 'Search on WhatsMyName',
      snippet: 'Check 500+ sites',
      url: `https://whatsmyname.app/?q=${encodeURIComponent(username)}`,
      source: 'WhatsMyName',
      type: 'username'
    });
    results.push({
      title: 'Search on NameCheckr',
      snippet: 'Username availability',
      url: `https://www.namecheckr.com/`,
      source: 'NameCheckr',
      type: 'username'
    });

    return results;
  },

  /**
   * Cryptocurrency Address Lookup
   */
  async lookupCrypto(address) {
    address = address.trim();
    const results = [];

    // Detect cryptocurrency type
    let cryptoType = 'Unknown';
    let explorerUrl = '';

    // Bitcoin (Legacy P2PKH: 1..., P2SH: 3..., Bech32: bc1...)
    if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
      cryptoType = 'Bitcoin (Legacy)';
      explorerUrl = `https://www.blockchain.com/btc/address/${address}`;
    } else if (/^bc1[a-z0-9]{39,59}$/i.test(address)) {
      cryptoType = 'Bitcoin (Bech32/SegWit)';
      explorerUrl = `https://www.blockchain.com/btc/address/${address}`;
    }
    // Ethereum (0x...)
    else if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
      cryptoType = 'Ethereum/ERC-20';
      explorerUrl = `https://etherscan.io/address/${address}`;
    }
    // Litecoin (L..., M..., ltc1...)
    else if (/^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(address) || /^ltc1[a-z0-9]{39,59}$/i.test(address)) {
      cryptoType = 'Litecoin';
      explorerUrl = `https://blockchair.com/litecoin/address/${address}`;
    }
    // Bitcoin Cash (q..., p...)
    else if (/^(bitcoincash:)?[qp][a-z0-9]{41}$/i.test(address)) {
      cryptoType = 'Bitcoin Cash';
      explorerUrl = `https://www.blockchain.com/bch/address/${address}`;
    }
    // Dogecoin (D...)
    else if (/^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/.test(address)) {
      cryptoType = 'Dogecoin';
      explorerUrl = `https://dogechain.info/address/${address}`;
    }
    // Monero (4...)
    else if (/^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(address)) {
      cryptoType = 'Monero';
      explorerUrl = `https://xmrchain.net/search?value=${address}`;
    }
    // Ripple/XRP (r...)
    else if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) {
      cryptoType = 'Ripple (XRP)';
      explorerUrl = `https://xrpscan.com/account/${address}`;
    }
    // Solana
    else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && address.length >= 32 && address.length <= 44) {
      cryptoType = 'Solana (possible)';
      explorerUrl = `https://solscan.io/account/${address}`;
    }

    results.push({ title: 'Address', snippet: address.substring(0, 20) + '...' + address.substring(address.length - 10), source: 'Parser', type: 'crypto' });
    results.push({ title: 'Blockchain', snippet: cryptoType, source: 'Detection', type: 'crypto' });

    // For Bitcoin/Ethereum, try to get balance from free APIs
    if (cryptoType.includes('Bitcoin')) {
      try {
        const response = await fetch(`https://blockchain.info/q/addressbalance/${address}`);
        const satoshis = await response.text();
        const btc = parseInt(satoshis) / 100000000;
        results.push({
          title: 'Balance',
          snippet: `${btc.toFixed(8)} BTC`,
          source: 'Blockchain.info',
          type: 'crypto'
        });
      } catch (e) {}

      // Transaction count
      try {
        const response = await fetch(`https://blockchain.info/q/getreceivedbyaddress/${address}`);
        const received = await response.text();
        const btc = parseInt(received) / 100000000;
        results.push({
          title: 'Total Received',
          snippet: `${btc.toFixed(8)} BTC`,
          source: 'Blockchain.info',
          type: 'crypto'
        });
      } catch (e) {}
    }

    if (cryptoType.includes('Ethereum')) {
      try {
        // Use a free Ethereum balance API
        const response = await fetch(`https://api.ethplorer.io/getAddressInfo/${address}?apiKey=freekey`);
        const data = await response.json();
        if (data.ETH) {
          results.push({
            title: 'ETH Balance',
            snippet: `${data.ETH.balance.toFixed(6)} ETH`,
            source: 'Ethplorer',
            type: 'crypto'
          });
          if (data.ETH.totalIn) {
            results.push({
              title: 'Total In',
              snippet: `${data.ETH.totalIn.toFixed(4)} ETH`,
              source: 'Ethplorer',
              type: 'crypto'
            });
          }
        }
        if (data.tokens && data.tokens.length > 0) {
          results.push({
            title: 'ERC-20 Tokens',
            snippet: `${data.tokens.length} token types held`,
            source: 'Ethplorer',
            type: 'crypto'
          });
        }
      } catch (e) {}
    }

    // Add explorer link
    if (explorerUrl) {
      results.push({
        title: 'View on Explorer',
        snippet: 'Full transaction history',
        url: explorerUrl,
        source: 'Blockchain Explorer',
        type: 'crypto'
      });
    }

    // Add analysis links
    results.push({
      title: 'Search on Blockchair',
      snippet: 'Multi-chain explorer',
      url: `https://blockchair.com/search?q=${address}`,
      source: 'Blockchair',
      type: 'crypto'
    });

    return results;
  },

  /**
   * Company/Business Lookup
   */
  async lookupCompany(name) {
    const results = [];
    name = name.trim();

    results.push({ title: 'Company Name', snippet: name, source: 'Query', type: 'company' });

    // Try OpenCorporates (free tier)
    try {
      const response = await fetch(`https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&per_page=5`);
      const data = await response.json();
      if (data.results && data.results.companies) {
        data.results.companies.slice(0, 3).forEach(item => {
          const company = item.company;
          results.push({
            title: company.name,
            snippet: `${company.jurisdiction_code?.toUpperCase() || ''} - ${company.company_type || 'Company'} - ${company.current_status || 'Unknown status'}`,
            url: company.opencorporates_url,
            source: 'OpenCorporates',
            type: 'company'
          });
        });
      }
    } catch (e) {}

    // SEC EDGAR search
    try {
      const ddgResults = await this.searchDuckDuckGoHTML(`site:sec.gov/cgi-bin/browse-edgar "${name}"`);
      if (ddgResults.length > 0) {
        results.push({
          title: 'SEC Filings',
          snippet: `Found ${ddgResults.length} potential SEC filings`,
          url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(name)}`,
          source: 'SEC EDGAR',
          type: 'company'
        });
      }
    } catch (e) {}

    // Add lookup links
    results.push({
      title: 'Search on OpenCorporates',
      snippet: 'Global company database',
      url: `https://opencorporates.com/companies?q=${encodeURIComponent(name)}`,
      source: 'OpenCorporates',
      type: 'company'
    });
    results.push({
      title: 'Search on Crunchbase',
      snippet: 'Startup & company info',
      url: `https://www.crunchbase.com/textsearch?q=${encodeURIComponent(name)}`,
      source: 'Crunchbase',
      type: 'company'
    });
    results.push({
      title: 'Search on LinkedIn',
      snippet: 'Company profiles',
      url: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(name)}`,
      source: 'LinkedIn',
      type: 'company'
    });

    return results;
  },

  /**
   * USPTO Trademark Search
   */
  async searchUSPTO(query) {
    try {
      // USPTO TESS is hard to scrape, use their XML API
      const results = await this.searchDuckDuckGoHTML(`site:uspto.gov trademark "${query}"`);
      return results.map(r => ({ ...r, source: 'USPTO', type: 'trademark' }));
    } catch (e) {
      return [];
    }
  },

  /**
   * State Business Entity Search (via DuckDuckGo)
   */
  async searchBusinessEntity(name, state = null) {
    try {
      const stateQueries = state
        ? [`site:${state}.gov business entity "${name}"`, `site:sos.${state}.gov "${name}"`]
        : [
          `site:*.gov secretary of state business "${name}"`,
          `"${name}" corporation LLC registered agent`
        ];

      const results = [];
      for (const q of stateQueries) {
        const ddg = await this.searchDuckDuckGoHTML(q);
        results.push(...ddg.slice(0, 3));
      }

      return results.slice(0, 10).map(r => ({ ...r, source: 'State Records', type: 'business' }));
    } catch (e) {
      return [];
    }
  },

  /**
   * Court Records Search (public court databases)
   */
  async searchCourtRecords(name) {
    try {
      const queries = [
        `site:courtlistener.com "${name}"`,
        `site:unicourt.com "${name}"`,
        `site:judyrecords.com "${name}"`,
        `"${name}" court case filing judgment`
      ];

      const results = [];
      for (const q of queries) {
        const ddg = await this.searchDuckDuckGoHTML(q);
        results.push(...ddg.slice(0, 3));
      }

      return results.slice(0, 15).map(r => ({ ...r, source: 'Court Records', type: 'legal' }));
    } catch (e) {
      return [];
    }
  },

  /**
   * Property Records Search
   */
  async searchPropertyRecords(query) {
    try {
      const results = await this.searchDuckDuckGoHTML(
        `site:*.gov property records "${query}" OR site:zillow.com "${query}" OR site:redfin.com "${query}"`
      );
      return results.slice(0, 10).map(r => ({ ...r, source: 'Property Records', type: 'property' }));
    } catch (e) {
      return [];
    }
  },

  //=========================================
  // COMPREHENSIVE PERSON SEARCH
  //=========================================

  /**
   * Search for a person across all available sources
   */
  async searchPerson(name) {
    const results = {
      summary: null,
      sources: [],
      discussions: [],
      infobox: null,
      loading: true
    };

    // Helper to wrap search with error handling
    const safeSearch = (promise, source) =>
      promise
        .then(r => ({ source, results: r || [] }))
        .catch(() => ({ source, results: [] }));

    // All searches to run (prioritize API-based sources)
    const searches = [
      // APIs (most reliable - these have CORS enabled)
      safeSearch(this.searchWikipedia(name, 8), 'wikipedia'),
      safeSearch(this.searchDuckDuckGo(name), 'duckduckgo'),
      safeSearch(this.searchWikidata(name), 'wikidata'),
      safeSearch(this.getWikipediaSummary(name).then(r => r ? [r] : []), 'wikipedia-summary'),
      safeSearch(this.searchReddit(`"${name}"`, 5), 'reddit'),
      safeSearch(this.searchHackerNews(name, 5), 'hackernews'),

      // Google CSE (your custom search)
      safeSearch(this.searchGoogleCSE(name), 'cse'),

      // DuckDuckGo HTML (most reliable proxy target)
      safeSearch(this.searchDuckDuckGoHTML(name), 'ddg-html'),

      // People search sites (via DuckDuckGo site: search)
      safeSearch(this.searchTruePeopleSearch(name), 'truepeoplesearch'),
      safeSearch(this.searchWhitePages(name), 'whitepages'),
      safeSearch(this.searchPeekYou(name), 'peekyou'),
      safeSearch(this.searchWebMii(name), 'webmii'),

      // Social media (via DuckDuckGo site: search)
      safeSearch(this.searchGoogle(name, 'linkedin.com'), 'linkedin'),
      safeSearch(this.searchGoogle(name, 'twitter.com'), 'twitter'),
      safeSearch(this.searchGoogle(name, 'facebook.com'), 'facebook'),
      safeSearch(this.searchGoogle(name, 'instagram.com'), 'instagram'),
    ];

    const settled = await Promise.allSettled(searches);

    // Process results
    settled.forEach(result => {
      if (result.status === 'fulfilled' && result.value.results) {
        const { source, results: sourceResults } = result.value;

        if (Array.isArray(sourceResults)) {
          // Find summary from DuckDuckGo or Wikipedia
          const summary = sourceResults.find(r => r.type === 'answer' || r.type === 'summary');
          if (summary && !results.summary) {
            results.summary = summary;
          }

          // Find infobox
          const infobox = sourceResults.find(r => r.type === 'infobox');
          if (infobox && !results.infobox) {
            results.infobox = infobox;
          }

          // Add discussions
          const discussions = sourceResults.filter(r => r.type === 'discussion');
          results.discussions.push(...discussions);

          // Add all other results
          results.sources.push(...sourceResults.filter(r =>
            r.type !== 'answer' && r.type !== 'summary' && r.type !== 'infobox'
          ).map(r => ({ ...r, _source: source })));
        }
      }
    });

    // Deduplicate by URL
    const seen = new Set();
    results.sources = results.sources.filter(s => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    results.loading = false;
    return results;
  },

  /**
   * General multi-source search
   */
  async searchAll(query, options = {}) {
    const {
      useAPIs = true,
      useScraping = true,
      sources = null
    } = options;

    const results = [];
    const searches = [];

    // API-based searches (always try these first)
    if (useAPIs) {
      searches.push(
        this.searchWikipedia(query, 8).catch(() => []),
        this.searchDuckDuckGo(query).catch(() => []),
        this.searchReddit(query, 8).catch(() => []),
        this.searchHackerNews(query, 8).catch(() => []),
        this.searchGitHub(query).catch(() => []),
        this.searchGoogleCSE(query).catch(() => [])
      );
    }

    // Scraping-based searches
    if (useScraping) {
      searches.push(
        this.searchGoogle(query).catch(() => []),
        this.searchDuckDuckGoHTML(query).catch(() => [])
      );
    }

    const settled = await Promise.allSettled(searches);

    settled.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        results.push(...result.value);
      }
    });

    // Deduplicate
    const seen = new Set();
    return results.filter(r => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
  },

  //=========================================
  // PDF 1-5 OSINT SOURCES - Additional search methods
  //=========================================

  // Government & ID Sources (PDF 1)
  governmentSources: {
    littlesis: { name: 'LittleSis', url: q => `https://littlesis.org/search?q=${encodeURIComponent(q)}`, category: 'government', desc: 'Power network database' },
    embassyworld: { name: 'EmbassyWorld', url: q => `https://www.embassyworld.com/search?q=${encodeURIComponent(q)}`, category: 'government', desc: 'Embassy directory' },
    sanctionsexplorer: { name: 'SanctionsExplorer', url: q => `https://sanctionsexplorer.org/search?q=${encodeURIComponent(q)}`, category: 'government', desc: 'Sanctions database' },
    passportindex: { name: 'Passport Index', url: q => `https://www.passportindex.org/search/?q=${encodeURIComponent(q)}`, category: 'identification', desc: 'Passport rankings' },
    prado: { name: 'PRADO', url: q => `https://www.consilium.europa.eu/prado/en/search.html?q=${encodeURIComponent(q)}`, category: 'identification', desc: 'EU document database' },
    ssnlookup: { name: 'SSN Lookup', url: q => `https://www.ssn-verify.com/lookup?ssn=${encodeURIComponent(q)}`, category: 'identification', desc: 'SSN place of issue' },
  },

  // Weapons & Equipment Sources (PDF 2)
  weaponsSources: {
    armalytics: { name: 'Armalytics', url: q => `https://armalytics.ca/?q=${encodeURIComponent(q)}`, category: 'firearms', desc: 'Firearms database' },
    modernfirearms: { name: 'Modern Firearms', url: q => `https://modernfirearms.net/search?q=${encodeURIComponent(q)}`, category: 'firearms', desc: 'Firearm encyclopedia' },
    imfdb: { name: 'IMFDB', url: q => `https://www.imfdb.org/index.php?search=${encodeURIComponent(q)}`, category: 'firearms', desc: 'Movie firearms database' },
    bulletpicker: { name: 'BulletPicker', url: q => `https://bulletpicker.com/search?q=${encodeURIComponent(q)}`, category: 'ordnance', desc: 'Ordnance database' },
    militaryfactory: { name: 'MilitaryFactory', url: q => `https://www.militaryfactory.com/search-results.php?q=${encodeURIComponent(q)}`, category: 'equipment', desc: 'Military equipment' },
    tanksencyclopedia: { name: 'Tanks Encyclopedia', url: q => `https://tanks-encyclopedia.com/?s=${encodeURIComponent(q)}`, category: 'vehicles', desc: 'Tank database' },
    armyrecognition: { name: 'ArmyRecognition', url: q => `https://www.armyrecognition.com/search?q=${encodeURIComponent(q)}`, category: 'equipment', desc: 'Military vehicles' },
    camopedia: { name: 'Camopedia', url: q => `https://camopedia.org/index.php?search=${encodeURIComponent(q)}`, category: 'personnel', desc: 'Camouflage patterns' },
    allbadges: { name: 'AllBadges', url: q => `https://www.allbadges.net/en/search?q=${encodeURIComponent(q)}`, category: 'personnel', desc: 'Military badges' },
  },

  // War & Conflict Sources (PDF 3)
  conflictSources: {
    crisiswatch: { name: 'CrisisWatch', url: q => `https://www.crisisgroup.org/crisiswatch?q=${encodeURIComponent(q)}`, category: 'conflicts', desc: 'Conflict tracker' },
    liveuamap: { name: 'LiveUAMap', url: q => `https://liveuamap.com/search?q=${encodeURIComponent(q)}`, category: 'conflicts', desc: 'Live conflict map' },
    homicidemonitor: { name: 'Homicide Monitor', url: q => `https://homicide.igarape.org.br/?q=${encodeURIComponent(q)}`, category: 'conflicts', desc: 'Murder rate data' },
    gtd: { name: 'Global Terrorism Database', url: q => `https://www.start.umd.edu/gtd/search/?q=${encodeURIComponent(q)}`, category: 'terrorism', desc: 'Terrorism incidents' },
    gunviolencearchive: { name: 'Gun Violence Archive', url: q => `https://www.gunviolencearchive.org/query?q=${encodeURIComponent(q)}`, category: 'terrorism', desc: 'Gun violence data' },
  },

  // Stolen Property Sources (PDF 4)
  stolenPropertySources: {
    artlossregister: { name: 'Art Loss Register', url: q => `https://www.artloss.com/search?q=${encodeURIComponent(q)}`, category: 'art', desc: 'Stolen art database' },
    interpol_art: { name: 'INTERPOL Art', url: q => `https://www.interpol.int/How-we-work/Databases/Works-of-art?search=${encodeURIComponent(q)}`, category: 'art', desc: 'INTERPOL stolen art' },
    findstolenart: { name: 'Find Stolen Art', url: q => `https://findstolenart.com/search?q=${encodeURIComponent(q)}`, category: 'art', desc: 'Stolen art search' },
    stolenboatsuk: { name: 'StolenBoats UK', url: q => `https://stolenboats.org.uk/search?q=${encodeURIComponent(q)}`, category: 'boats', desc: 'UK stolen boats' },
    hotgunz: { name: 'HotGunz', url: q => `https://www.hotgunz.com/search.php?serial=${encodeURIComponent(q)}`, category: 'firearms', desc: 'Stolen firearms' },
    isitnicked: { name: 'IsItNicked', url: q => `https://www.isitnicked.com/check?reg=${encodeURIComponent(q)}`, category: 'vehicles', desc: 'UK stolen vehicles' },
    project529: { name: 'Project529', url: q => `https://project529.com/garage/bikes/search?serial=${encodeURIComponent(q)}`, category: 'property', desc: 'Stolen bicycles' },
    stolenregister: { name: 'StolenRegister', url: q => `https://www.stolenregister.com/search?q=${encodeURIComponent(q)}`, category: 'property', desc: 'Stolen items' },
    imeipro: { name: 'IMEI Pro', url: q => `https://www.imeipro.info/check_imei.html?imei=${encodeURIComponent(q)}`, category: 'property', desc: 'IMEI blacklist check' },
    stolencamerafinder: { name: 'Stolen Camera Finder', url: q => `https://www.stolencamerafinder.com/search?sn=${encodeURIComponent(q)}`, category: 'property', desc: 'Stolen cameras' },
    stolendroneinfo: { name: 'Stolen Drone Info', url: q => `https://stolendroneinfo.com/search?sn=${encodeURIComponent(q)}`, category: 'property', desc: 'Lost/stolen drones' },
  },

  // Organized Crime Sources (PDF 5)
  crimeSources: {
    insightcrime: { name: 'InsightCrime', url: q => `https://insightcrime.org/?s=${encodeURIComponent(q)}`, category: 'crime', desc: 'Organized crime news' },
    globalinitiative: { name: 'Global Initiative', url: q => `https://globalinitiative.net/?s=${encodeURIComponent(q)}`, category: 'crime', desc: 'Organized crime research' },
    numbeocrime: { name: 'Numbeo Crime', url: q => `https://www.numbeo.com/crime/in/${encodeURIComponent(q)}`, category: 'crime', desc: 'Crime statistics' },
    mugshots: { name: 'Mugshots', url: q => `https://mugshots.com/search/?q=${encodeURIComponent(q)}`, category: 'crime', desc: 'Mugshot search' },
    interpol_red: { name: 'INTERPOL Red Notices', url: q => `https://www.interpol.int/How-we-work/Notices/Red-Notices/View-Red-Notices?search=${encodeURIComponent(q)}`, category: 'fugitives', desc: 'Most wanted' },
    europol_wanted: { name: 'Europol Most Wanted', url: q => `https://eumostwanted.eu/search?q=${encodeURIComponent(q)}`, category: 'fugitives', desc: 'EU most wanted' },
    fbi_wanted: { name: 'FBI Most Wanted', url: q => `https://www.fbi.gov/wanted/topten?search=${encodeURIComponent(q)}`, category: 'fugitives', desc: 'FBI top 10' },
    dea_wanted: { name: 'DEA Most Wanted', url: q => `https://www.dea.gov/fugitives?search=${encodeURIComponent(q)}`, category: 'fugitives', desc: 'DEA fugitives' },
    gangsterssinc: { name: 'GangstersInc', url: q => `https://gangstersinc.org/?s=${encodeURIComponent(q)}`, category: 'gangs', desc: 'Mafia news' },
    streetgangs: { name: 'StreetGangs', url: q => `https://www.streetgangs.com/search?q=${encodeURIComponent(q)}`, category: 'gangs', desc: 'Gang information' },
    humantraffickingsearch: { name: 'Human Trafficking Search', url: q => `https://humantraffickingsearch.org/search?q=${encodeURIComponent(q)}`, category: 'trafficking', desc: 'Trafficking research' },
    rxlist: { name: 'RxList Pill ID', url: q => `https://www.rxlist.com/pill-identification-tool/article.htm?search=${encodeURIComponent(q)}`, category: 'drugs', desc: 'Pill identification' },
    erowid: { name: 'Erowid', url: q => `https://www.erowid.org/search.php?q=${encodeURIComponent(q)}`, category: 'drugs', desc: 'Drug information' },
    ofacsanctions: { name: 'OFAC Sanctions', url: q => `https://sanctionssearch.ofac.treas.gov/?search=${encodeURIComponent(q)}`, category: 'crime', desc: 'US sanctions list' },
    oxpeckers: { name: 'Oxpeckers', url: q => `https://oxpeckers.org/?s=${encodeURIComponent(q)}`, category: 'wildlife', desc: 'Wildlife crime' },
    wwf: { name: 'WWF', url: q => `https://www.worldwildlife.org/search?q=${encodeURIComponent(q)}`, category: 'wildlife', desc: 'Wildlife conservation' },
    scamsearch: { name: 'ScamSearch', url: q => `https://scamsearch.io/search?q=${encodeURIComponent(q)}`, category: 'fraud', desc: 'Scam database' },
    scamalert: { name: 'ScamAlert', url: q => `https://www.scamalert.sg/search?q=${encodeURIComponent(q)}`, category: 'fraud', desc: 'Scam reports' },
    havocscope: { name: 'Havocscope', url: q => `https://havocscope.com/search?q=${encodeURIComponent(q)}`, category: 'crime', desc: 'Black market intel' },
  },

  // Data Sets & Archives Sources (PDF 6)
  datasetSources: {
    ucsf_industry: { name: 'UCSF Industry Docs', url: q => `https://www.industrydocuments.ucsf.edu/search/?q=${encodeURIComponent(q)}`, category: 'datasets', desc: 'Industry documents archive' },
    lumendatabase: { name: 'Lumen Database', url: q => `https://lumendatabase.org/notices/search?term=${encodeURIComponent(q)}`, category: 'datasets', desc: 'DMCA takedown database' },
    ncbi: { name: 'NCBI', url: q => `https://www.ncbi.nlm.nih.gov/search/all/?term=${encodeURIComponent(q)}`, category: 'datasets', desc: 'Biotech database' },
    kaggle: { name: 'Kaggle', url: q => `https://www.kaggle.com/search?q=${encodeURIComponent(q)}`, category: 'datasets', desc: 'Public datasets' },
    commoncrawl: { name: 'Common Crawl', url: q => `https://commoncrawl.org/search?q=${encodeURIComponent(q)}`, category: 'datasets', desc: 'Web crawl data' },
    core_research: { name: 'CORE Research', url: q => `https://core.ac.uk/search?q=${encodeURIComponent(q)}`, category: 'datasets', desc: 'Research papers' },
    occrp: { name: 'OCCRP', url: q => `https://aleph.occrp.org/search?q=${encodeURIComponent(q)}`, category: 'datasets', desc: 'Investigative data' },
    google_datasets: { name: 'Google Dataset Search', url: q => `https://datasetsearch.research.google.com/search?query=${encodeURIComponent(q)}`, category: 'datasets', desc: 'Dataset search' },
    fbi_vault: { name: 'FBI Vault', url: q => `https://vault.fbi.gov/search?SearchableText=${encodeURIComponent(q)}`, category: 'government', desc: 'FOIA documents' },
    cia_reading: { name: 'CIA Reading Room', url: q => `https://www.cia.gov/readingroom/search/site/${encodeURIComponent(q)}`, category: 'government', desc: 'CIA documents' },
    us_archives: { name: 'US National Archives', url: q => `https://catalog.archives.gov/search?q=${encodeURIComponent(q)}`, category: 'government', desc: 'US archives' },
    uk_archives: { name: 'UK National Archives', url: q => `https://discovery.nationalarchives.gov.uk/results/r?_q=${encodeURIComponent(q)}`, category: 'government', desc: 'UK archives' },
    wikileaks: { name: 'WikiLeaks', url: q => `https://search.wikileaks.org/?q=${encodeURIComponent(q)}`, category: 'leaks', desc: 'Leaked documents' },
    ddosecrets: { name: 'DDoSecrets', url: q => `https://ddosecrets.com/search?q=${encodeURIComponent(q)}`, category: 'leaks', desc: 'Leaked data' },
    icij_offshore: { name: 'ICIJ Offshore Leaks', url: q => `https://offshoreleaks.icij.org/search?q=${encodeURIComponent(q)}`, category: 'leaks', desc: 'Offshore leaks' },
    blackbookonline: { name: 'BlackBookOnline', url: q => `https://www.blackbookonline.info/USA-Counties.aspx?search=${encodeURIComponent(q)}`, category: 'records', desc: 'US public records' },
    muckrock: { name: 'MuckRock', url: q => `https://www.muckrock.com/foi/list/?q=${encodeURIComponent(q)}`, category: 'records', desc: 'FOIA requests' },
  },

  // Real Estate Sources (PDF 7)
  realEstateSources: {
    zillow: { name: 'Zillow', url: q => `https://www.zillow.com/homes/${encodeURIComponent(q)}`, category: 'realestate', desc: 'Property search' },
    trulia: { name: 'Trulia', url: q => `https://www.trulia.com/for_sale/${encodeURIComponent(q)}`, category: 'realestate', desc: 'Property listings' },
    homemetry: { name: 'Homemetry', url: q => `https://homemetry.com/search?q=${encodeURIComponent(q)}`, category: 'realestate', desc: 'Property info' },
    whoownswhat: { name: 'Who Owns What NYC', url: q => `https://whoownswhat.justfix.nyc/en/address/${encodeURIComponent(q)}`, category: 'realestate', desc: 'NYC property owner' },
    publicaccountability: { name: 'Public Accountability', url: q => `https://publicaccountability.org/search?q=${encodeURIComponent(q)}`, category: 'realestate', desc: 'Property records' },
  },

  // Gaming Sources (PDF 8)
  gamingSources: {
    steamid: { name: 'SteamID', url: q => `https://steamid.io/lookup/${encodeURIComponent(q)}`, category: 'gaming', desc: 'Steam profile lookup' },
    steamdb: { name: 'SteamDB', url: q => `https://steamdb.info/search/?q=${encodeURIComponent(q)}`, category: 'gaming', desc: 'Steam database' },
    steamrep: { name: 'SteamRep', url: q => `https://steamrep.com/search?q=${encodeURIComponent(q)}`, category: 'gaming', desc: 'Steam scam reports' },
    steamspy: { name: 'SteamSpy', url: q => `https://steamspy.com/search.php?s=${encodeURIComponent(q)}`, category: 'gaming', desc: 'Steam analytics' },
    xboxgamertag: { name: 'Xbox Gamertag', url: q => `https://xboxgamertag.com/search/${encodeURIComponent(q)}`, category: 'gaming', desc: 'Xbox profile' },
    psnprofiles: { name: 'PSN Profiles', url: q => `https://psnprofiles.com/search/users?q=${encodeURIComponent(q)}`, category: 'gaming', desc: 'PlayStation profile' },
    tracker_gg: { name: 'Tracker.gg', url: q => `https://tracker.gg/search?q=${encodeURIComponent(q)}`, category: 'gaming', desc: 'Game stats' },
    rolimons: { name: 'Rolimons', url: q => `https://www.rolimons.com/player/${encodeURIComponent(q)}`, category: 'gaming', desc: 'Roblox player' },
    namemc: { name: 'NameMC', url: q => `https://namemc.com/search?q=${encodeURIComponent(q)}`, category: 'gaming', desc: 'Minecraft lookup' },
    fortnitetracker: { name: 'Fortnite Tracker', url: q => `https://fortnitetracker.com/profile/search?q=${encodeURIComponent(q)}`, category: 'gaming', desc: 'Fortnite stats' },
    lolprofile: { name: 'LoL Profile', url: q => `https://lolprofile.net/search?name=${encodeURIComponent(q)}`, category: 'gaming', desc: 'League of Legends' },
  },

  // Username Search Sources (PDF 9)
  usernameSources: {
    whatsmyname: { name: 'WhatsMyName', url: q => `https://whatsmyname.app/?q=${encodeURIComponent(q)}`, category: 'username', desc: 'Username enumeration' },
    namechk: { name: 'Namechk', url: q => `https://namechk.com/search?q=${encodeURIComponent(q)}`, category: 'username', desc: 'Username checker' },
    knowem: { name: 'KnowEm', url: q => `https://knowem.com/checkusernames.php?u=${encodeURIComponent(q)}`, category: 'username', desc: 'Username search 500+ sites' },
    usersearch: { name: 'UserSearch', url: q => `https://usersearch.org/results_normal.php?q=${encodeURIComponent(q)}`, category: 'username', desc: 'Social media lookup' },
    idcrawl: { name: 'IDCrawl', url: q => `https://www.idcrawl.com/${encodeURIComponent(q)}`, category: 'username', desc: 'People search' },
    instantusername: { name: 'InstantUsername', url: q => `https://instantusername.com/#/${encodeURIComponent(q)}`, category: 'username', desc: 'Username availability' },
    checkusernames: { name: 'CheckUsernames', url: q => `https://checkusernames.com/search?q=${encodeURIComponent(q)}`, category: 'username', desc: 'Username checker' },
    namevine: { name: 'Namevine', url: q => `https://namevine.com/#/${encodeURIComponent(q)}`, category: 'username', desc: 'Domain & social search' },
    intelx_username: { name: 'IntelX Username', url: q => `https://intelx.io/?s=${encodeURIComponent(q)}`, category: 'username', desc: 'Username intel' },
  },

  // Phone Number Sources (PDF 10)
  phoneNumberSources: {
    spydialer: { name: 'SpyDialer', url: q => `https://www.spydialer.com/results.aspx?q=${encodeURIComponent(q)}`, category: 'phone', desc: 'Reverse phone lookup' },
    fonefinder: { name: 'FoneFinder', url: q => `https://fonefinder.net/findome.php?npa=${encodeURIComponent(q)}`, category: 'phone', desc: 'Phone number info' },
    zlookup: { name: 'ZLookup', url: q => `https://www.zlookup.com/result?phone=${encodeURIComponent(q)}`, category: 'phone', desc: 'Reverse phone' },
    calleridtest: { name: 'CallerID Test', url: q => `https://calleridtest.com/lookup?number=${encodeURIComponent(q)}`, category: 'phone', desc: 'Caller ID lookup' },
    phonevalidator: { name: 'Phone Validator', url: q => `https://www.phonevalidator.com/index.aspx?number=${encodeURIComponent(q)}`, category: 'phone', desc: 'Phone validation' },
    whitepages_us: { name: 'WhitePages US', url: q => `https://www.whitepages.com/phone/${encodeURIComponent(q)}`, category: 'phone', desc: 'US phone directory' },
    canada411: { name: 'Canada411', url: q => `https://www.canada411.ca/search/?stype=pf&what=${encodeURIComponent(q)}`, category: 'phone', desc: 'Canada phone' },
    infobel: { name: 'InfoBel', url: q => `https://www.infobel.com/en/world/search?q=${encodeURIComponent(q)}`, category: 'phone', desc: 'World phone directory' },
    phonebookworld: { name: 'Phonebook World', url: q => `https://www.phonebookoftheworld.com/search?q=${encodeURIComponent(q)}`, category: 'phone', desc: 'Global phone directory' },
    sync_me: { name: 'Sync.me', url: q => `https://sync.me/search/?number=${encodeURIComponent(q)}`, category: 'phone', desc: 'Caller ID' },
    truecaller: { name: 'Truecaller', url: q => `https://www.truecaller.com/search/${encodeURIComponent(q)}`, category: 'phone', desc: 'Phone lookup' },
  },

  // Email & Data Breach Sources (PDF 11)
  emailSources: {
    epieos: { name: 'Epieos', url: q => `https://epieos.com/?q=${encodeURIComponent(q)}`, category: 'email', desc: 'Email OSINT tool' },
    hunter_io: { name: 'Hunter.io', url: q => `https://hunter.io/search/${encodeURIComponent(q)}`, category: 'email', desc: 'Email finder' },
    haveibeenpwned: { name: 'HaveIBeenPwned', url: q => `https://haveibeenpwned.com/unifiedsearch/${encodeURIComponent(q)}`, category: 'breach', desc: 'Data breach check' },
    breachdirectory: { name: 'BreachDirectory', url: q => `https://breachdirectory.org/search?email=${encodeURIComponent(q)}`, category: 'breach', desc: 'Breach database search' },
    dehashed: { name: 'DeHashed', url: q => `https://www.dehashed.com/search?query=${encodeURIComponent(q)}`, category: 'breach', desc: 'Credential database' },
    intelx_email: { name: 'IntelX Email', url: q => `https://intelx.io/?s=${encodeURIComponent(q)}`, category: 'email', desc: 'Intelligence search' },
    emailrep: { name: 'EmailRep', url: q => `https://emailrep.io/${encodeURIComponent(q)}`, category: 'email', desc: 'Email reputation' },
    snov_io: { name: 'Snov.io', url: q => `https://snov.io/email-finder?search=${encodeURIComponent(q)}`, category: 'email', desc: 'Email finder tool' },
    voilanorbert: { name: 'VoilaNorbert', url: q => `https://www.voilanorbert.com/search?q=${encodeURIComponent(q)}`, category: 'email', desc: 'Email lookup' },
    verify_email: { name: 'Verify-Email', url: q => `https://verify-email.org/check/${encodeURIComponent(q)}`, category: 'email', desc: 'Email verification' },
    pgp_keyserver: { name: 'PGP Keyserver', url: q => `https://keys.openpgp.org/search?q=${encodeURIComponent(q)}`, category: 'email', desc: 'PGP key search' },
    keyserver_ubuntu: { name: 'Ubuntu Keyserver', url: q => `https://keyserver.ubuntu.com/pks/lookup?search=${encodeURIComponent(q)}&op=index`, category: 'email', desc: 'PGP key lookup' },
  },

  // People Investigation & Court Records (PDF 12)
  peopleInvestigationSources: {
    melissa: { name: 'Melissa Lookups', url: q => `https://www.melissa.com/v2/lookups/personatorsearch/search/?name=${encodeURIComponent(q)}`, category: 'people', desc: 'People data platform' },
    socialcatfish: { name: 'SocialCatfish', url: q => `https://socialcatfish.com/search/?q=${encodeURIComponent(q)}`, category: 'people', desc: 'Identity verification' },
    judyrecords: { name: 'JudyRecords', url: q => `https://www.judyrecords.com/search?q=${encodeURIComponent(q)}`, category: 'court', desc: 'Court case search' },
    unicourt: { name: 'UniCourt', url: q => `https://unicourt.com/search?q=${encodeURIComponent(q)}`, category: 'court', desc: 'Court records' },
    courtlistener: { name: 'CourtListener', url: q => `https://www.courtlistener.com/?q=${encodeURIComponent(q)}`, category: 'court', desc: 'Court opinions' },
    pacer: { name: 'PACER', url: q => `https://pcl.uscourts.gov/search?q=${encodeURIComponent(q)}`, category: 'court', desc: 'Federal court records' },
    bop_inmate: { name: 'BOP Inmate Locator', url: q => `https://www.bop.gov/inmateloc/?search=${encodeURIComponent(q)}`, category: 'inmate', desc: 'Federal inmates' },
    vinelink: { name: 'VINELink', url: q => `https://www.vinelink.com/vinelink/initSearchForm.do?searchType=offender&lastName=${encodeURIComponent(q)}`, category: 'inmate', desc: 'Offender locator' },
    nsopw: { name: 'NSOPW', url: q => `https://www.nsopw.gov/search?name=${encodeURIComponent(q)}`, category: 'offender', desc: 'Sex offender registry' },
    familysearch: { name: 'FamilySearch', url: q => `https://www.familysearch.org/search/record/results?q.anyExact=${encodeURIComponent(q)}`, category: 'genealogy', desc: 'Genealogy records' },
    ancestry: { name: 'Ancestry', url: q => `https://www.ancestry.com/search/?name=${encodeURIComponent(q)}`, category: 'genealogy', desc: 'Ancestry records' },
    findagrave: { name: 'Find A Grave', url: q => `https://www.findagrave.com/memorial/search?firstname=${encodeURIComponent(q)}`, category: 'genealogy', desc: 'Cemetery records' },
    legacy: { name: 'Legacy.com', url: q => `https://www.legacy.com/us/obituaries/search?keyword=${encodeURIComponent(q)}`, category: 'genealogy', desc: 'Obituaries' },
    truthfinder: { name: 'TruthFinder', url: q => `https://www.truthfinder.com/dashboard/search?q=${encodeURIComponent(q)}`, category: 'people', desc: 'Background check' },
    intelius: { name: 'Intelius', url: q => `https://www.intelius.com/people-search/${encodeURIComponent(q)}`, category: 'people', desc: 'People search' },
    fastpeoplesearch: { name: 'FastPeopleSearch', url: q => `https://www.fastpeoplesearch.com/name/${encodeURIComponent(q)}`, category: 'people', desc: 'Free people search' },
  },

  // Deep Web & Darknet Sources (PDF 13)
  darknetSources: {
    ahmia: { name: 'Ahmia', url: q => `https://ahmia.fi/search/?q=${encodeURIComponent(q)}`, category: 'darknet', desc: 'TOR search engine' },
    torch: { name: 'Torch', url: q => `http://xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rplyvk3noyd.onion/search?q=${encodeURIComponent(q)}`, category: 'darknet', desc: 'Onion search (TOR)' },
    haystak: { name: 'Haystak', url: q => `http://haystak5njsmn2hqkewecpaxetahtwhsbsa64jom2k22z5afxhnpxfid.onion/?q=${encodeURIComponent(q)}`, category: 'darknet', desc: 'Onion search (TOR)' },
    onionland: { name: 'OnionLand Search', url: q => `https://onionlandsearchengine.com/search?q=${encodeURIComponent(q)}`, category: 'darknet', desc: 'Dark web search' },
    darksearch: { name: 'DarkSearch', url: q => `https://darksearch.io/search?q=${encodeURIComponent(q)}`, category: 'darknet', desc: 'Dark web search' },
    exonera: { name: 'ExoneraTor', url: q => `https://metrics.torproject.org/exonerator.html?ip=${encodeURIComponent(q)}`, category: 'darknet', desc: 'TOR relay checker' },
    tormetrics: { name: 'TOR Metrics', url: q => `https://metrics.torproject.org/rs.html#search/${encodeURIComponent(q)}`, category: 'darknet', desc: 'TOR relay search' },
    onion_live: { name: 'Onion.live', url: q => `https://onion.live/search?q=${encodeURIComponent(q)}`, category: 'darknet', desc: 'Onion link list' },
    dark_fail: { name: 'Dark.Fail', url: q => `https://dark.fail/search?q=${encodeURIComponent(q)}`, category: 'darknet', desc: 'Dark web status' },
    ipfs_search: { name: 'IPFS Search', url: q => `https://ipfs-search.com/#/search?q=${encodeURIComponent(q)}`, category: 'distributed', desc: 'IPFS search' },
  },

  // Signals Intelligence Sources (PDF 14)
  sigintSources: {
    radioreference: { name: 'RadioReference', url: q => `https://www.radioreference.com/apps/db/?search=${encodeURIComponent(q)}`, category: 'radio', desc: 'Radio frequencies database' },
    hfunderground: { name: 'HF Underground', url: q => `https://www.hfunderground.com/board/search?q=${encodeURIComponent(q)}`, category: 'radio', desc: 'Shortwave radio forum' },
    sigidwiki: { name: 'SigIDWiki', url: q => `https://www.sigidwiki.com/wiki/Database:${encodeURIComponent(q)}`, category: 'radio', desc: 'Signal identification' },
    websdr: { name: 'WebSDR', url: q => `http://websdr.org/?search=${encodeURIComponent(q)}`, category: 'radio', desc: 'Software-defined radio' },
    broadcastify: { name: 'Broadcastify', url: q => `https://www.broadcastify.com/listen/search/?q=${encodeURIComponent(q)}`, category: 'radio', desc: 'Live scanner feeds' },
    qrz: { name: 'QRZ', url: q => `https://www.qrz.com/lookup?callsign=${encodeURIComponent(q)}`, category: 'ham', desc: 'HAM radio callsigns' },
    ae7q: { name: 'AE7Q', url: q => `https://www.ae7q.com/query/data/CallHistory.php?CALL=${encodeURIComponent(q)}`, category: 'ham', desc: 'Callsign history' },
    fcc_uls: { name: 'FCC ULS', url: q => `https://wireless2.fcc.gov/UlsApp/UlsSearch/searchLicense.jsp?licName=${encodeURIComponent(q)}`, category: 'ham', desc: 'FCC license search' },
    dxwatch: { name: 'DXWatch', url: q => `https://www.dxwatch.com/dxsd1/s.php?s=1&qrg=${encodeURIComponent(q)}`, category: 'ham', desc: 'DX spots' },
    reversebeacon: { name: 'Reverse Beacon', url: q => `https://www.reversebeacon.net/main.php?callsign=${encodeURIComponent(q)}`, category: 'ham', desc: 'Beacon network' },
  },

  // Digital Network Intelligence Sources (PDF 15)
  dnintSources: {
    whois_domaintools: { name: 'DomainTools WHOIS', url: q => `https://whois.domaintools.com/${encodeURIComponent(q)}`, category: 'domain', desc: 'Domain WHOIS lookup' },
    whoxy: { name: 'Whoxy', url: q => `https://www.whoxy.com/${encodeURIComponent(q)}`, category: 'domain', desc: 'WHOIS history' },
    securitytrails: { name: 'SecurityTrails', url: q => `https://securitytrails.com/domain/${encodeURIComponent(q)}`, category: 'domain', desc: 'DNS intelligence' },
    viewdns: { name: 'ViewDNS', url: q => `https://viewdns.info/reverseip/?host=${encodeURIComponent(q)}`, category: 'domain', desc: 'Reverse IP lookup' },
    dnsdumpster: { name: 'DNSDumpster', url: q => `https://dnsdumpster.com/?q=${encodeURIComponent(q)}`, category: 'dns', desc: 'DNS recon' },
    dnslytics: { name: 'DNSlytics', url: q => `https://dnslytics.com/domain/${encodeURIComponent(q)}`, category: 'dns', desc: 'DNS analytics' },
    bgpview: { name: 'BGPView', url: q => `https://bgpview.io/search?query=${encodeURIComponent(q)}`, category: 'network', desc: 'BGP/ASN lookup' },
    ipinfo: { name: 'IPinfo', url: q => `https://ipinfo.io/${encodeURIComponent(q)}`, category: 'ip', desc: 'IP address info' },
    abuseipdb: { name: 'AbuseIPDB', url: q => `https://www.abuseipdb.com/check/${encodeURIComponent(q)}`, category: 'ip', desc: 'IP abuse reports' },
    censys: { name: 'Censys', url: q => `https://search.censys.io/search?resource=hosts&q=${encodeURIComponent(q)}`, category: 'iot', desc: 'Internet scan data' },
    shodan_search: { name: 'Shodan', url: q => `https://www.shodan.io/search?query=${encodeURIComponent(q)}`, category: 'iot', desc: 'IoT search engine' },
    zoomeye: { name: 'ZoomEye', url: q => `https://www.zoomeye.org/searchResult?q=${encodeURIComponent(q)}`, category: 'iot', desc: 'Cyberspace search' },
    greynoise: { name: 'GreyNoise', url: q => `https://viz.greynoise.io/query?gnql=ip:${encodeURIComponent(q)}`, category: 'ip', desc: 'Internet noise analyzer' },
    wigle: { name: 'WiGLE', url: q => `https://wigle.net/search?query=${encodeURIComponent(q)}`, category: 'wireless', desc: 'WiFi network map' },
    insecam: { name: 'Insecam', url: q => `https://www.insecam.org/en/bycountry/${encodeURIComponent(q)}`, category: 'cctv', desc: 'Public cameras' },
    exploit_db: { name: 'Exploit-DB', url: q => `https://www.exploit-db.com/search?q=${encodeURIComponent(q)}`, category: 'exploit', desc: 'Exploit database' },
    cve_mitre: { name: 'CVE Mitre', url: q => `https://cve.mitre.org/cgi-bin/cvekey.cgi?keyword=${encodeURIComponent(q)}`, category: 'exploit', desc: 'CVE database' },
    nvd_nist: { name: 'NVD NIST', url: q => `https://nvd.nist.gov/vuln/search/results?query=${encodeURIComponent(q)}`, category: 'exploit', desc: 'Vulnerability database' },
    builtwith: { name: 'BuiltWith', url: q => `https://builtwith.com/${encodeURIComponent(q)}`, category: 'tech', desc: 'Technology profiler' },
    wappalyzer: { name: 'Wappalyzer', url: q => `https://www.wappalyzer.com/lookup/${encodeURIComponent(q)}`, category: 'tech', desc: 'Tech stack identifier' },
  },

  // Vehicle & Transportation Sources (PDF 16)
  vehicleSources: {
    nhtsa_vin: { name: 'NHTSA VIN Decoder', url: q => `https://vpic.nhtsa.dot.gov/decoder/Decoder?VIN=${encodeURIComponent(q)}`, category: 'vehicle', desc: 'Official VIN decoder' },
    vehiclehistory: { name: 'VehicleHistory', url: q => `https://www.vehiclehistory.com/vin-report/${encodeURIComponent(q)}`, category: 'vehicle', desc: 'Vehicle history' },
    vincheck: { name: 'VINCheck', url: q => `https://www.nicb.org/vincheck?vin=${encodeURIComponent(q)}`, category: 'vehicle', desc: 'Theft/salvage check' },
    autocheck: { name: 'AutoCheck', url: q => `https://www.autocheck.com/vehiclehistory/search?vin=${encodeURIComponent(q)}`, category: 'vehicle', desc: 'Vehicle reports' },
    faxvin: { name: 'FaxVIN', url: q => `https://www.faxvin.com/vin-check?vin=${encodeURIComponent(q)}`, category: 'vehicle', desc: 'Free VIN check' },
    poctra: { name: 'Poctra', url: q => `https://poctra.com/search?q=${encodeURIComponent(q)}`, category: 'vehicle', desc: 'Salvage auctions' },
    marinetraffic: { name: 'MarineTraffic', url: q => `https://www.marinetraffic.com/en/ais/index/search/all/keyword:${encodeURIComponent(q)}`, category: 'marine', desc: 'Ship tracking' },
    vesselfinder: { name: 'VesselFinder', url: q => `https://www.vesselfinder.com/vessels?name=${encodeURIComponent(q)}`, category: 'marine', desc: 'Vessel search' },
    imo_gisis: { name: 'IMO GISIS', url: q => `https://gisis.imo.org/Public/SHIPS/Search.aspx?search=${encodeURIComponent(q)}`, category: 'marine', desc: 'Ship database' },
    equasis: { name: 'Equasis', url: q => `https://www.equasis.org/EquasisWeb/restricted/Search?fs_search=${encodeURIComponent(q)}`, category: 'marine', desc: 'Ship info' },
    flightaware: { name: 'FlightAware', url: q => `https://flightaware.com/live/flight/${encodeURIComponent(q)}`, category: 'aviation', desc: 'Flight tracking' },
    flightradar24: { name: 'FlightRadar24', url: q => `https://www.flightradar24.com/${encodeURIComponent(q)}`, category: 'aviation', desc: 'Live flight tracking' },
    adsbexchange: { name: 'ADSBexchange', url: q => `https://globe.adsbexchange.com/?q=${encodeURIComponent(q)}`, category: 'aviation', desc: 'Unfiltered ADS-B' },
    planespotters: { name: 'Planespotters', url: q => `https://www.planespotters.net/search?q=${encodeURIComponent(q)}`, category: 'aviation', desc: 'Aircraft photos' },
    faa_registry: { name: 'FAA Registry', url: q => `https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?NNumber=${encodeURIComponent(q)}`, category: 'aviation', desc: 'US aircraft registry' },
    openrailwaymap: { name: 'OpenRailwayMap', url: q => `https://www.openrailwaymap.org/?search=${encodeURIComponent(q)}`, category: 'rail', desc: 'Railway map' },
    raildar: { name: 'Raildar', url: q => `https://raildar.co.uk/search?q=${encodeURIComponent(q)}`, category: 'rail', desc: 'UK train tracker' },
  },

  // Financial Intelligence Sources (PDF 17)
  finintSources: {
    blockchain_btc: { name: 'Blockchain.com', url: q => `https://www.blockchain.com/explorer/search?search=${encodeURIComponent(q)}`, category: 'crypto', desc: 'Bitcoin explorer' },
    etherscan: { name: 'Etherscan', url: q => `https://etherscan.io/search?q=${encodeURIComponent(q)}`, category: 'crypto', desc: 'Ethereum explorer' },
    blockchair: { name: 'Blockchair', url: q => `https://blockchair.com/search?q=${encodeURIComponent(q)}`, category: 'crypto', desc: 'Multi-chain explorer' },
    btc_com: { name: 'BTC.com', url: q => `https://btc.com/search?q=${encodeURIComponent(q)}`, category: 'crypto', desc: 'Bitcoin search' },
    walletexplorer: { name: 'WalletExplorer', url: q => `https://www.walletexplorer.com/wallet/${encodeURIComponent(q)}`, category: 'crypto', desc: 'Bitcoin wallet' },
    solscan: { name: 'Solscan', url: q => `https://solscan.io/search?q=${encodeURIComponent(q)}`, category: 'crypto', desc: 'Solana explorer' },
    polyscan: { name: 'PolygonScan', url: q => `https://polygonscan.com/search?q=${encodeURIComponent(q)}`, category: 'crypto', desc: 'Polygon explorer' },
    bscscan: { name: 'BscScan', url: q => `https://bscscan.com/search?q=${encodeURIComponent(q)}`, category: 'crypto', desc: 'BSC explorer' },
    sec_edgar: { name: 'SEC EDGAR', url: q => `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(q)}&action=getcompany`, category: 'finance', desc: 'SEC filings' },
    finra_brokercheck: { name: 'FINRA BrokerCheck', url: q => `https://brokercheck.finra.org/search/genericsearch/grid?q=${encodeURIComponent(q)}`, category: 'finance', desc: 'Broker lookup' },
    yahoo_finance: { name: 'Yahoo Finance', url: q => `https://finance.yahoo.com/quote/${encodeURIComponent(q)}`, category: 'finance', desc: 'Stock quotes' },
    stockanalysis: { name: 'Stock Analysis', url: q => `https://stockanalysis.com/stocks/${encodeURIComponent(q.toLowerCase())}`, category: 'finance', desc: 'Stock research' },
    fdic_bankfind: { name: 'FDIC BankFind', url: q => `https://banks.data.fdic.gov/bankfind-suite/bankfind?NAME=${encodeURIComponent(q)}`, category: 'banking', desc: 'Bank information' },
    swift_codes: { name: 'SWIFT Codes', url: q => `https://www.swift.com/search?search=${encodeURIComponent(q)}`, category: 'banking', desc: 'SWIFT code lookup' },
    iban_checker: { name: 'IBAN Checker', url: q => `https://www.iban.com/iban-checker?iban=${encodeURIComponent(q)}`, category: 'banking', desc: 'IBAN validation' },
    openinsider: { name: 'OpenInsider', url: q => `https://openinsider.com/search?q=${encodeURIComponent(q)}`, category: 'finance', desc: 'Insider trading' },
  },

  // Business & Trade Intelligence Sources (PDF 18)
  tradintSources: {
    opencorporates: { name: 'OpenCorporates', url: q => `https://opencorporates.com/companies?q=${encodeURIComponent(q)}`, category: 'business', desc: 'Company database' },
    crunchbase: { name: 'Crunchbase', url: q => `https://www.crunchbase.com/discover/organization.companies?search=${encodeURIComponent(q)}`, category: 'business', desc: 'Startup database' },
    dnb: { name: 'D&B', url: q => `https://www.dnb.com/business-directory/company-search.html?term=${encodeURIComponent(q)}`, category: 'business', desc: 'Business credit' },
    glassdoor: { name: 'Glassdoor', url: q => `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(q)}`, category: 'business', desc: 'Company reviews' },
    companieshouse_uk: { name: 'Companies House UK', url: q => `https://find-and-update.company-information.service.gov.uk/search?q=${encodeURIComponent(q)}`, category: 'business', desc: 'UK companies' },
    abn_lookup: { name: 'ABN Lookup', url: q => `https://abr.business.gov.au/Search/ResultsActive?SearchText=${encodeURIComponent(q)}`, category: 'business', desc: 'Australian business' },
    bizapedia: { name: 'Bizapedia', url: q => `https://www.bizapedia.com/search.aspx?q=${encodeURIComponent(q)}`, category: 'business', desc: 'US business search' },
    google_patents: { name: 'Google Patents', url: q => `https://patents.google.com/?q=${encodeURIComponent(q)}`, category: 'patents', desc: 'Patent search' },
    uspto: { name: 'USPTO', url: q => `https://patft.uspto.gov/netahtml/PTO/search-bool.html?Term=${encodeURIComponent(q)}`, category: 'patents', desc: 'US patents' },
    espacenet: { name: 'Espacenet', url: q => `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(q)}`, category: 'patents', desc: 'World patents' },
    wipo: { name: 'WIPO', url: q => `https://patentscope.wipo.int/search/en/search.jsf?query=${encodeURIComponent(q)}`, category: 'patents', desc: 'Global patents' },
    tess_uspto: { name: 'USPTO TESS', url: q => `https://tmsearch.uspto.gov/search/search-results?query=${encodeURIComponent(q)}`, category: 'trademark', desc: 'US trademarks' },
    tmdn: { name: 'TMView', url: q => `https://www.tmdn.org/tmview/#/tmview/results?q=${encodeURIComponent(q)}`, category: 'trademark', desc: 'EU trademarks' },
    importyeti: { name: 'ImportYeti', url: q => `https://www.importyeti.com/search?q=${encodeURIComponent(q)}`, category: 'trade', desc: 'Import records' },
    panjiva: { name: 'Panjiva', url: q => `https://panjiva.com/search?q=${encodeURIComponent(q)}`, category: 'trade', desc: 'Trade data' },
    customs_data: { name: 'Import Genius', url: q => `https://www.importgenius.com/search?q=${encodeURIComponent(q)}`, category: 'trade', desc: 'Customs data' },
  },

  // Orbital Intelligence Sources (PDF 19)
  orbintSources: {
    n2yo: { name: 'N2YO', url: q => `https://www.n2yo.com/satellite/?s=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Satellite tracker' },
    celestrak: { name: 'Celestrak', url: q => `https://celestrak.org/satcat/search.php?search=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Satellite catalog' },
    satcat: { name: 'Space-Track', url: q => `https://www.space-track.org/basicspacedata/query/class/satcat/SATNAME/~~${encodeURIComponent(q)}/format/html`, category: 'satellite', desc: 'Space surveillance' },
    heavens_above: { name: 'Heavens Above', url: q => `https://www.heavens-above.com/search.aspx?q=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Satellite passes' },
    stuffin_space: { name: 'Stuff in Space', url: q => `https://stuffin.space/?search=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Space debris viz' },
    orbtrack: { name: 'OrbTrack', url: q => `https://www.orbtrack.org/search?q=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Orbit tracker' },
    satbeams: { name: 'SatBeams', url: q => `https://www.satbeams.com/search?q=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Satellite beams' },
    in_the_sky: { name: 'In-The-Sky.org', url: q => `https://in-the-sky.org/search.php?s=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Sky objects' },
    satflare: { name: 'SatFlare', url: q => `https://www.satflare.com/track.asp?search=${encodeURIComponent(q)}`, category: 'satellite', desc: 'Real-time tracking' },
  },

  // Social Media Intelligence Sources (PDF 21)
  socmintSources: {
    // General Social Media Tools
    gofindwho: { name: 'GoFindWho', url: q => `https://gofindwho.com/?q=${encodeURIComponent(q)}`, category: 'socmint', desc: 'People finder' },
    social_searcher: { name: 'Social-Searcher', url: q => `https://www.social-searcher.com/social-buzz/?q5=${encodeURIComponent(q)}`, category: 'socmint', desc: 'Real-time social search' },
    socialblade: { name: 'SocialBlade', url: q => `https://socialblade.com/search/search?query=${encodeURIComponent(q)}`, category: 'socmint', desc: 'Social stats tracker' },
    // Discord
    disboard: { name: 'DisBoard', url: q => `https://disboard.org/search?keyword=${encodeURIComponent(q)}`, category: 'discord', desc: 'Discord server search' },
    discordbee: { name: 'DiscordBee', url: q => `https://discordbee.com/servers?q=${encodeURIComponent(q)}`, category: 'discord', desc: 'Discord server search' },
    discordservers: { name: 'DiscordServers', url: q => `https://discordservers.com/search/${encodeURIComponent(q)}`, category: 'discord', desc: 'Discord server search' },
    // Facebook
    whopostedwhat: { name: 'WhoPostedWhat', url: q => `https://whopostedwhat.com/search?q=${encodeURIComponent(q)}`, category: 'facebook', desc: 'Facebook search by date' },
    // Instagram
    searchusers: { name: 'SearchUsers', url: q => `https://searchusers.com/search?q=${encodeURIComponent(q)}`, category: 'instagram', desc: 'Instagram user search' },
    searchmybio: { name: 'SearchMyBio', url: q => `https://www.searchmy.bio/search?q=${encodeURIComponent(q)}`, category: 'instagram', desc: 'Instagram bio search' },
    imginn: { name: 'ImgInn', url: q => `https://imginn.com/search/${encodeURIComponent(q)}/`, category: 'instagram', desc: 'Instagram viewer' },
    inflact: { name: 'InFlact', url: q => `https://inflact.com/profiles/instagram/${encodeURIComponent(q)}/`, category: 'instagram', desc: 'Instagram analytics' },
    worldcam: { name: 'Worldcam', url: q => `https://worldcam.eu/search/${encodeURIComponent(q)}`, category: 'instagram', desc: 'Instagram by location' },
    picuki: { name: 'Picuki', url: q => `https://www.picuki.com/search/${encodeURIComponent(q)}`, category: 'instagram', desc: 'Instagram viewer' },
    gramhir: { name: 'Gramhir', url: q => `https://gramhir.com/search/${encodeURIComponent(q)}`, category: 'instagram', desc: 'Instagram analytics' },
    // LinkedIn
    recruiteem: { name: 'Recruit\'em', url: q => `https://recruitin.net/results.php?searchTerms=${encodeURIComponent(q)}&searchEngine=google`, category: 'linkedin', desc: 'LinkedIn X-Ray search' },
    freepeoplesearch: { name: 'FreePeopleSearch', url: q => `https://freepeoplesearchtool.com/?q=${encodeURIComponent(q)}`, category: 'linkedin', desc: 'LinkedIn profile search' },
    // Reddit
    camas_reddit: { name: 'Camas Reddit', url: q => `https://camas.unddit.com/#%7B%22searchFor%22:1,%22resultSize%22:100,%22query%22:%22${encodeURIComponent(q)}%22%7D`, category: 'reddit', desc: 'Reddit archive search' },
    reveddit: { name: 'Reveddit', url: q => `https://www.reveddit.com/v/?q=${encodeURIComponent(q)}`, category: 'reddit', desc: 'Removed content search' },
    reddit_analyzer: { name: 'Reddit Analyzer', url: q => `https://reddit-user-analyser.netlify.app/#${encodeURIComponent(q)}`, category: 'reddit', desc: 'Reddit user analytics' },
    redditmetis: { name: 'RedditMetis', url: q => `https://redditmetis.com/user/${encodeURIComponent(q)}`, category: 'reddit', desc: 'Reddit user stats' },
    socialgrep: { name: 'SocialGrep', url: q => `https://socialgrep.com/search?query=${encodeURIComponent(q)}`, category: 'reddit', desc: 'Reddit search & alerts' },
    redditle: { name: 'Redditle', url: q => `https://redditle.com/search?q=${encodeURIComponent(q)}`, category: 'reddit', desc: 'Reddit Google search' },
    // SnapChat
    snapmap: { name: 'Snap Map', url: q => `https://map.snapchat.com/search?q=${encodeURIComponent(q)}`, category: 'snapchat', desc: 'SnapChat map search' },
    ghostcodes: { name: 'GhostCodes', url: q => `https://www.ghostcodes.com/search?q=${encodeURIComponent(q)}`, category: 'snapchat', desc: 'SnapChat user search' },
    // Telegram
    telegramdb: { name: 'TelegramDB', url: q => `https://telegramdb.org/search?q=${encodeURIComponent(q)}`, category: 'telegram', desc: 'Telegram search' },
    lyzem: { name: 'Lyzem', url: q => `https://lyzem.com/search?q=${encodeURIComponent(q)}`, category: 'telegram', desc: 'Telegram search' },
    telegramgroup: { name: 'TelegramGroup', url: q => `https://www.telegram-group.com/en/?s=${encodeURIComponent(q)}`, category: 'telegram', desc: 'Telegram groups' },
    xtea: { name: 'xTea', url: q => `https://xtea.io/ts_en.html?search=${encodeURIComponent(q)}`, category: 'telegram', desc: 'Telegram search' },
    tgstat: { name: 'Tgstat', url: q => `https://tgstat.com/search?q=${encodeURIComponent(q)}`, category: 'telegram', desc: 'Telegram analytics' },
    // TikTok
    tikstats: { name: 'TikStats', url: q => `https://tikstats.org/search?q=${encodeURIComponent(q)}`, category: 'tiktok', desc: 'TikTok analytics' },
    exolyt: { name: 'Exolyt', url: q => `https://exolyt.com/search?q=${encodeURIComponent(q)}`, category: 'tiktok', desc: 'TikTok analytics' },
    mavekite: { name: 'MaveKite', url: q => `https://mavekite.com/search?q=${encodeURIComponent(q)}`, category: 'tiktok', desc: 'TikTok analytics' },
    vidnice: { name: 'VidNice', url: q => `https://vidnice.com/search/?q=${encodeURIComponent(q)}`, category: 'tiktok', desc: 'TikTok search' },
    // Twitch
    twitchtracker: { name: 'TwitchTracker', url: q => `https://twitchtracker.com/${encodeURIComponent(q)}`, category: 'twitch', desc: 'Twitch analytics' },
    sullygnome: { name: 'SullyGnome', url: q => `https://sullygnome.com/channel/${encodeURIComponent(q)}`, category: 'twitch', desc: 'Twitch stats' },
    twitchtools: { name: 'TwitchTools', url: q => `https://twitch-tools.rootonline.de/channel_search.php?q=${encodeURIComponent(q)}`, category: 'twitch', desc: 'Twitch search' },
    // Twitter
    nitter: { name: 'Nitter', url: q => `https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}`, category: 'twitter', desc: 'Twitter viewer' },
    tweetbeaver: { name: 'TweetBeaver', url: q => `https://tweetbeaver.com/search.php?q=${encodeURIComponent(q)}`, category: 'twitter', desc: 'Twitter OSINT tools' },
    allmytweets: { name: 'AllMyTweets', url: q => `https://www.allmytweets.net/connect/?u=${encodeURIComponent(q)}`, category: 'twitter', desc: 'View all tweets' },
    socialbearing: { name: 'SocialBearing', url: q => `https://socialbearing.com/search/user/${encodeURIComponent(q)}`, category: 'twitter', desc: 'Twitter analytics' },
    birdhunt: { name: 'BirdHunt', url: q => `https://birdhunt.co/search?q=${encodeURIComponent(q)}`, category: 'twitter', desc: 'Twitter geo search' },
    botometer: { name: 'Botometer', url: q => `https://botometer.osome.iu.edu/#!/?q=${encodeURIComponent(q)}`, category: 'twitter', desc: 'Bot detection' },
    // VKontakte
    vk_search: { name: 'VK Search', url: q => `https://vk.com/search?c%5Bq%5D=${encodeURIComponent(q)}&c%5Bsection%5D=auto`, category: 'vkontakte', desc: 'VK search' },
    // YouTube
    yt_geofind: { name: 'YT GeoFind', url: q => `https://mattw.io/youtube-geofind/location?q=${encodeURIComponent(q)}`, category: 'youtube', desc: 'YouTube geo search' },
    yt_comments: { name: 'YT Comments', url: q => `https://ytcomment.kmcat.uk/?url=${encodeURIComponent(q)}`, category: 'youtube', desc: 'YouTube comment search' },
    hadzy: { name: 'Hadzy', url: q => `https://hadzy.com/search?q=${encodeURIComponent(q)}`, category: 'youtube', desc: 'YouTube comment search' },
    amnesty_yt: { name: 'Amnesty YT', url: q => `https://citizenevidence.amnestyusa.org/?u=${encodeURIComponent(q)}`, category: 'youtube', desc: 'YouTube metadata' },
    altcensored: { name: 'AltCensored', url: q => `https://www.altcensored.com/search?q=${encodeURIComponent(q)}`, category: 'youtube', desc: 'Censored videos' },
    // 4chan
    archived_moe: { name: 'Archived.moe', url: q => `https://archived.moe/_/search/text/${encodeURIComponent(q)}/`, category: 'imageboard', desc: '4chan archive' },
    desuarchive: { name: 'Desuarchive', url: q => `https://desuarchive.org/_/search/text/${encodeURIComponent(q)}/`, category: 'imageboard', desc: '4chan archive' },
    fourplebs: { name: '4plebs', url: q => `https://archive.4plebs.org/_/search/text/${encodeURIComponent(q)}/`, category: 'imageboard', desc: '4chan archive' },
  },

  // Mapping and Geospatial Intelligence Sources (PDF 22)
  geointSources: {
    // General Mapping
    google_maps: { name: 'Google Maps', url: q => `https://www.google.com/maps/search/${encodeURIComponent(q)}`, category: 'maps', desc: 'Google Maps search' },
    bing_maps: { name: 'Bing Maps', url: q => `https://www.bing.com/maps?q=${encodeURIComponent(q)}`, category: 'maps', desc: 'Bing Maps search' },
    openstreetmap: { name: 'OpenStreetMap', url: q => `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`, category: 'maps', desc: 'OSM search' },
    soar_earth: { name: 'Soar Earth', url: q => `https://soar.earth/search?q=${encodeURIComponent(q)}`, category: 'maps', desc: 'Satellite imagery' },
    f4map: { name: 'F4 Map', url: q => `https://demo.f4map.com/#search=${encodeURIComponent(q)}`, category: 'maps', desc: '3D world map' },
    herewego: { name: 'HERE Maps', url: q => `https://wego.here.com/search/${encodeURIComponent(q)}`, category: 'maps', desc: 'HERE Maps search' },
    mapquest: { name: 'MapQuest', url: q => `https://www.mapquest.com/search/results?query=${encodeURIComponent(q)}`, category: 'maps', desc: 'MapQuest search' },
    sentinel_hub: { name: 'Sentinel Hub', url: q => `https://apps.sentinel-hub.com/eo-browser/?search=${encodeURIComponent(q)}`, category: 'maps', desc: 'Satellite imagery' },
    wikimapia: { name: 'Wikimapia', url: q => `https://wikimapia.org/#search=${encodeURIComponent(q)}`, category: 'maps', desc: 'Wiki map search' },
    city_data: { name: 'City-Data', url: q => `https://www.city-data.com/search/?cx=partner-pub-5291717498498940%3A6170380267&cof=FORID%3A10&ie=UTF-8&q=${encodeURIComponent(q)}`, category: 'maps', desc: 'US city data' },
    mapcarta: { name: 'Mapcarta', url: q => `https://mapcarta.com/search?q=${encodeURIComponent(q)}`, category: 'maps', desc: 'Place search' },
    what3words: { name: 'What3Words', url: q => `https://what3words.com/${encodeURIComponent(q)}`, category: 'maps', desc: '3-word addresses' },
    geonames: { name: 'GeoNames', url: q => `https://www.geonames.org/search.html?q=${encodeURIComponent(q)}`, category: 'maps', desc: 'Place names DB' },
    // Street View
    kartaview: { name: 'KartaView', url: q => `https://kartaview.org/map/@${encodeURIComponent(q)}`, category: 'streetview', desc: 'Street-level imagery' },
    mapillary: { name: 'Mapillary', url: q => `https://www.mapillary.com/app/?search=${encodeURIComponent(q)}`, category: 'streetview', desc: 'Street-level imagery' },
    instant_streetview: { name: 'InstantStreetView', url: q => `https://www.instantstreetview.com/@${encodeURIComponent(q)}`, category: 'streetview', desc: 'Street view finder' },
    // Weather Maps
    zoom_earth: { name: 'Zoom Earth', url: q => `https://zoom.earth/#search=${encodeURIComponent(q)}`, category: 'weather', desc: 'Live weather maps' },
    openweathermap: { name: 'OpenWeatherMap', url: q => `https://openweathermap.org/find?q=${encodeURIComponent(q)}`, category: 'weather', desc: 'Weather data' },
    windy: { name: 'Windy', url: q => `https://www.windy.com/?search=${encodeURIComponent(q)}`, category: 'weather', desc: 'Wind forecasts' },
    ventusky: { name: 'Ventusky', url: q => `https://www.ventusky.com/?search=${encodeURIComponent(q)}`, category: 'weather', desc: 'Weather maps' },
    lightningmap: { name: 'LightningMap', url: q => `https://www.lightningmaps.org/?search=${encodeURIComponent(q)}`, category: 'weather', desc: 'Lightning tracker' },
    // Natural Disaster Maps
    nasa_fire: { name: 'NASA Fire Map', url: q => `https://firms.modaps.eosdis.nasa.gov/map/#search=${encodeURIComponent(q)}`, category: 'disaster', desc: 'Fire hotspots' },
    earthquakes: { name: 'Earthquakes', url: q => `https://earthquake.usgs.gov/earthquakes/search/?q=${encodeURIComponent(q)}`, category: 'disaster', desc: 'Earthquake data' },
    gdacs: { name: 'GDACS', url: q => `https://www.gdacs.org/search.aspx?q=${encodeURIComponent(q)}`, category: 'disaster', desc: 'Disaster alerts' },
    volcano_discovery: { name: 'VolcanoDiscovery', url: q => `https://www.volcanodiscovery.com/search.html?q=${encodeURIComponent(q)}`, category: 'disaster', desc: 'Volcanic activity' },
    // Cell Tower Maps
    opencellid: { name: 'OpenCellID', url: q => `https://opencellid.org/#search=${encodeURIComponent(q)}`, category: 'network', desc: 'Cell tower DB' },
    cellmapper: { name: 'CellMapper', url: q => `https://www.cellmapper.net/search?q=${encodeURIComponent(q)}`, category: 'network', desc: 'Cell coverage' },
    // Internet Infrastructure
    submarine_cable: { name: 'Submarine Cables', url: q => `https://www.submarinecablemap.com/?search=${encodeURIComponent(q)}`, category: 'network', desc: 'Undersea cables' },
    he_backbone: { name: 'HE Network Map', url: q => `https://he.net/3d-map/?search=${encodeURIComponent(q)}`, category: 'network', desc: 'Internet backbone' },
    // Activity Maps
    strava_heatmap: { name: 'Strava Heatmap', url: q => `https://www.strava.com/heatmap#search/${encodeURIComponent(q)}`, category: 'activity', desc: 'Activity heatmap' },
    ridewithgps: { name: 'RideWithGPS', url: q => `https://ridewithgps.com/find?search=${encodeURIComponent(q)}`, category: 'activity', desc: 'Cycling routes' },
    bikemap: { name: 'BikeMap', url: q => `https://www.bikemap.net/en/search/?q=${encodeURIComponent(q)}`, category: 'activity', desc: 'Bike routes' },
    // Historical Maps
    oldmapsonline: { name: 'OldMapsOnline', url: q => `https://www.oldmapsonline.org/search?q=${encodeURIComponent(q)}`, category: 'historical', desc: 'Historical maps' },
    wayback_imagery: { name: 'Wayback Imagery', url: q => `https://livingatlas.arcgis.com/wayback/?search=${encodeURIComponent(q)}`, category: 'historical', desc: 'Historical satellite' },
    // Ocean Maps
    globalfishingwatch: { name: 'GlobalFishingWatch', url: q => `https://globalfishingwatch.org/map/?search=${encodeURIComponent(q)}`, category: 'ocean', desc: 'Fishing activity' },
    shipwreckworld: { name: 'ShipwreckWorld', url: q => `https://www.shipwreckworld.com/maps/?search=${encodeURIComponent(q)}`, category: 'ocean', desc: 'Shipwreck map' },
    // Geolocation Tools
    suncalc: { name: 'SunCalc', url: q => `https://www.suncalc.org/#/${encodeURIComponent(q)}`, category: 'geolocation', desc: 'Sun position' },
    shadowcalc: { name: 'ShadowCalculator', url: q => `https://www.shadowcalculator.eu/#/${encodeURIComponent(q)}`, category: 'geolocation', desc: 'Shadow analysis' },
    geohack: { name: 'GeoHack', url: q => `https://geohack.toolforge.org/geohack.php?params=${encodeURIComponent(q)}`, category: 'geolocation', desc: 'Geo tools' },
  },

  // Search Engine Sources (PDF 23)
  searchEngineSources: {
    // General Search
    google: { name: 'Google', url: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`, category: 'general', desc: 'Google search' },
    duckduckgo: { name: 'DuckDuckGo', url: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, category: 'general', desc: 'Private search' },
    bing: { name: 'Bing', url: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, category: 'general', desc: 'Bing search' },
    yahoo: { name: 'Yahoo', url: q => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`, category: 'general', desc: 'Yahoo search' },
    yandex: { name: 'Yandex', url: q => `https://yandex.com/search/?text=${encodeURIComponent(q)}`, category: 'general', desc: 'Russian search' },
    brave_search: { name: 'Brave Search', url: q => `https://search.brave.com/search?q=${encodeURIComponent(q)}`, category: 'general', desc: 'Brave search' },
    qwant: { name: 'Qwant', url: q => `https://www.qwant.com/?q=${encodeURIComponent(q)}`, category: 'general', desc: 'Privacy search' },
    startpage: { name: 'Startpage', url: q => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`, category: 'general', desc: 'Private search' },
    mojeek: { name: 'Mojeek', url: q => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, category: 'general', desc: 'Independent search' },
    ecosia: { name: 'Ecosia', url: q => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`, category: 'general', desc: 'Eco search' },
    swisscows: { name: 'Swisscows', url: q => `https://swisscows.com/web?query=${encodeURIComponent(q)}`, category: 'general', desc: 'Private search' },
    // Country-Specific
    baidu: { name: 'Baidu', url: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, category: 'regional', desc: 'Chinese search' },
    sogou: { name: 'Sogou', url: q => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`, category: 'regional', desc: 'Chinese search' },
    naver: { name: 'Naver', url: q => `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`, category: 'regional', desc: 'Korean search' },
    seznam: { name: 'Seznam', url: q => `https://search.seznam.cz/?q=${encodeURIComponent(q)}`, category: 'regional', desc: 'Czech search' },
    coccoc: { name: 'CocCoc', url: q => `https://coccoc.com/search?query=${encodeURIComponent(q)}`, category: 'regional', desc: 'Vietnamese search' },
    goo_jp: { name: 'Goo Japan', url: q => `https://search.goo.ne.jp/web.jsp?MT=${encodeURIComponent(q)}`, category: 'regional', desc: 'Japanese search' },
    // Meta Search
    faganfinder: { name: 'Fagan Finder', url: q => `https://www.faganfinder.com/search-all?q=${encodeURIComponent(q)}`, category: 'metasearch', desc: 'Meta search' },
    dogpile: { name: 'DogPile', url: q => `https://www.dogpile.com/serp?q=${encodeURIComponent(q)}`, category: 'metasearch', desc: 'Meta search' },
    izito: { name: 'iZito', url: q => `https://www.izito.com/search?q=${encodeURIComponent(q)}`, category: 'metasearch', desc: 'Meta search' },
    etools: { name: 'eTools', url: q => `https://www.etools.ch/searchSubmit.do?query=${encodeURIComponent(q)}`, category: 'metasearch', desc: 'Swiss meta search' },
    webcrawler: { name: 'WebCrawler', url: q => `https://www.webcrawler.com/serp?q=${encodeURIComponent(q)}`, category: 'metasearch', desc: 'Meta search' },
    // Similar Site Search
    similarsites: { name: 'SimilarSites', url: q => `https://www.similarsites.com/site/${encodeURIComponent(q)}`, category: 'similar', desc: 'Similar websites' },
    siteslike: { name: 'SitesLike', url: q => `https://www.siteslike.com/similar/${encodeURIComponent(q)}`, category: 'similar', desc: 'Similar websites' },
    similarweb: { name: 'SimilarWeb', url: q => `https://www.similarweb.com/website/${encodeURIComponent(q)}`, category: 'similar', desc: 'Website analytics' },
    // Document Search
    libgen: { name: 'Library Genesis', url: q => `https://libgen.rs/search.php?req=${encodeURIComponent(q)}`, category: 'documents', desc: 'Free library' },
    scihub: { name: 'SciHub', url: q => `https://sci-hub.se/${encodeURIComponent(q)}`, category: 'documents', desc: 'Research papers' },
    the_eye: { name: 'The-Eye', url: q => `https://searchin.the-eye.eu/search/${encodeURIComponent(q)}`, category: 'documents', desc: 'Data archive' },
    slideshare: { name: 'SlideShare', url: q => `https://www.slideshare.net/search/slideshow?q=${encodeURIComponent(q)}`, category: 'documents', desc: 'Presentations' },
    doaj: { name: 'DOAJ', url: q => `https://doaj.org/search/articles?ref=homepage-box&source=%7B%22query%22%3A%7B%22query_string%22%3A%7B%22query%22%3A%22${encodeURIComponent(q)}%22%7D%7D%7D`, category: 'documents', desc: 'Open access journals' },
    filechef: { name: 'FileChef', url: q => `https://www.filechef.com/search?q=${encodeURIComponent(q)}`, category: 'documents', desc: 'File search' },
    napalm_ftp: { name: 'NapalmFTP', url: q => `https://www.searchftps.net/search?q=${encodeURIComponent(q)}`, category: 'documents', desc: 'FTP search' },
    // Archive Search
    wayback: { name: 'Wayback Machine', url: q => `https://web.archive.org/web/*/${encodeURIComponent(q)}`, category: 'archive', desc: 'Web archive' },
    archive_today: { name: 'Archive.today', url: q => `https://archive.today/${encodeURIComponent(q)}`, category: 'archive', desc: 'Page snapshots' },
    memento: { name: 'MementoWeb', url: q => `https://timetravel.mementoweb.org/list/timemap/${encodeURIComponent(q)}`, category: 'archive', desc: 'Time travel' },
    // Code Search
    grep_app: { name: 'grep.app', url: q => `https://grep.app/search?q=${encodeURIComponent(q)}`, category: 'code', desc: 'Git repo search' },
    searchcode: { name: 'SearchCode', url: q => `https://searchcode.com/?q=${encodeURIComponent(q)}`, category: 'code', desc: 'Code search' },
    sourcegraph: { name: 'SourceGraph', url: q => `https://sourcegraph.com/search?q=${encodeURIComponent(q)}`, category: 'code', desc: 'Code search' },
    // Paste Sites
    psbdmp: { name: 'PSBDMP', url: q => `https://psbdmp.ws/search?q=${encodeURIComponent(q)}`, category: 'paste', desc: 'Paste search' },
    // Job Search
    monster: { name: 'Monster', url: q => `https://www.monster.com/jobs/search?q=${encodeURIComponent(q)}`, category: 'jobs', desc: 'Job search' },
    indeed: { name: 'Indeed', url: q => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}`, category: 'jobs', desc: 'Job search' },
    glassdoor: { name: 'Glassdoor', url: q => `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(q)}`, category: 'jobs', desc: 'Job/company reviews' },
    // News Search
    emm_news: { name: 'EMM News', url: q => `https://emm.newsbrief.eu/NewsBrief/search?q=${encodeURIComponent(q)}`, category: 'news', desc: 'Global news search' },
    allyoucanread: { name: 'AllYouCanRead', url: q => `https://www.allyoucanread.com/search?q=${encodeURIComponent(q)}`, category: 'news', desc: 'News directory' },
    newspaper_map: { name: 'NewspaperMap', url: q => `https://newspapermap.com/#search=${encodeURIComponent(q)}`, category: 'news', desc: 'Global newspapers' },
    // Video Search
    youtube: { name: 'YouTube', url: q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, category: 'video', desc: 'Video search' },
    vimeo: { name: 'Vimeo', url: q => `https://vimeo.com/search?q=${encodeURIComponent(q)}`, category: 'video', desc: 'Video search' },
    peteyvid: { name: 'PeteyVid', url: q => `https://www.peteyvid.com/search?q=${encodeURIComponent(q)}`, category: 'video', desc: 'Multi-platform video' },
    bilibili: { name: 'BiliBili', url: q => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`, category: 'video', desc: 'Chinese video' },
    // Specialty Search
    wolfram: { name: 'Wolfram|Alpha', url: q => `https://www.wolframalpha.com/input?i=${encodeURIComponent(q)}`, category: 'specialty', desc: 'Computational search' },
    millionshort: { name: 'Million Short', url: q => `https://millionshort.com/search?keywords=${encodeURIComponent(q)}`, category: 'specialty', desc: 'Remove top sites' },
    imdb: { name: 'IMDB', url: q => `https://www.imdb.com/find?q=${encodeURIComponent(q)}`, category: 'specialty', desc: 'Movie database' },
    wikipedia_search: { name: 'Wikipedia', url: q => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`, category: 'specialty', desc: 'Encyclopedia' },
  },

  // Imagery Intelligence Sources (PDF 20)
  imintSources: {
    tineye: { name: 'TinEye', url: q => `https://tineye.com/search?url=${encodeURIComponent(q)}`, category: 'reverse_image', desc: 'Reverse image search' },
    google_images: { name: 'Google Images', url: q => `https://www.google.com/searchbyimage?image_url=${encodeURIComponent(q)}`, category: 'reverse_image', desc: 'Google image search' },
    yandex_images: { name: 'Yandex Images', url: q => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(q)}`, category: 'reverse_image', desc: 'Yandex image search' },
    bing_images: { name: 'Bing Images', url: q => `https://www.bing.com/images/search?q=imgurl:${encodeURIComponent(q)}`, category: 'reverse_image', desc: 'Bing image search' },
    pimeyes: { name: 'PimEyes', url: q => `https://pimeyes.com/en/search?url=${encodeURIComponent(q)}`, category: 'face', desc: 'Face search' },
    facecheck: { name: 'FaceCheck.ID', url: q => `https://facecheck.id/search?url=${encodeURIComponent(q)}`, category: 'face', desc: 'Face recognition' },
    fotoforensics: { name: 'FotoForensics', url: q => `https://fotoforensics.com/analysis.php?url=${encodeURIComponent(q)}`, category: 'forensics', desc: 'Image forensics' },
    jeffreys_exif: { name: 'Jeffrey\'s EXIF', url: q => `http://exif.regex.info/exif.cgi?url=${encodeURIComponent(q)}`, category: 'forensics', desc: 'EXIF data viewer' },
    exifdata: { name: 'ExifData.com', url: q => `https://exifdata.com/?url=${encodeURIComponent(q)}`, category: 'forensics', desc: 'EXIF extractor' },
    invid: { name: 'InVID', url: q => `https://www.invid-project.eu/tools-and-services/invid-verification-plugin/?url=${encodeURIComponent(q)}`, category: 'forensics', desc: 'Video verification' },
    geospy: { name: 'GeoSpy', url: q => `https://geospy.ai/?url=${encodeURIComponent(q)}`, category: 'geolocation', desc: 'AI geolocation' },
    picarta: { name: 'Picarta', url: q => `https://picarta.ai/search?url=${encodeURIComponent(q)}`, category: 'geolocation', desc: 'Photo location' },
    suncalc: { name: 'SunCalc', url: q => `https://www.suncalc.org/?search=${encodeURIComponent(q)}`, category: 'geolocation', desc: 'Sun position calc' },
    shadows_calculator: { name: 'ShadowCalculator', url: q => `https://www.shadowcalculator.eu/?search=${encodeURIComponent(q)}`, category: 'geolocation', desc: 'Shadow analysis' },
  },

  /**
   * Get all OSINT sources combined
   */
  getAllOSINTSources() {
    return {
      ...this.governmentSources,
      ...this.weaponsSources,
      ...this.conflictSources,
      ...this.stolenPropertySources,
      ...this.crimeSources,
      ...this.datasetSources,
      ...this.realEstateSources,
      ...this.gamingSources,
      ...this.usernameSources,
      ...this.phoneNumberSources,
      // PDF 11-20 sources
      ...this.emailSources,
      ...this.peopleInvestigationSources,
      ...this.darknetSources,
      ...this.sigintSources,
      ...this.dnintSources,
      ...this.vehicleSources,
      ...this.finintSources,
      ...this.tradintSources,
      ...this.orbintSources,
      ...this.imintSources,
      // PDF 21-23 sources
      ...this.socmintSources,
      ...this.geointSources,
      ...this.searchEngineSources,
    };
  },

  /**
   * Search a specific OSINT source - returns direct link if fetch fails
   */
  async searchOSINTSource(sourceKey, query) {
    const allSources = this.getAllOSINTSources();
    const source = allSources[sourceKey];
    if (!source) return null;

    const url = source.url(query);

    try {
      const doc = await this.fetchHTML(url);
      if (doc) {
        const results = this.extractGenericResults(doc, url);
        if (results.length > 0) {
          return results.map(r => ({ ...r, source: source.name, sourceKey }));
        }
      }
    } catch (e) {
      // Fetch failed - return direct link
    }

    // Return a direct link result if fetch failed
    return [{
      title: `Search ${source.name}`,
      snippet: source.desc + ' - Click to search directly',
      url: url,
      source: source.name,
      sourceKey,
      directLink: true,
    }];
  },

  /**
   * Search multiple OSINT sources by category (supports multiple categories)
   */
  async searchOSINTCategory(category, query) {
    const allSources = this.getAllOSINTSources();
    // Support both single category string and array of categories
    const categories = Array.isArray(category) ? category : [category];
    const categorySources = Object.entries(allSources)
      .filter(([_, s]) => categories.includes(s.category));

    const results = [];
    const searches = categorySources.map(async ([key, _]) => {
      const sourceResults = await this.searchOSINTSource(key, query);
      if (sourceResults) results.push(...sourceResults);
    });

    await Promise.allSettled(searches);
    return results;
  },

  /**
   * Search by source collection name (e.g., 'governmentSources', 'weaponsSources')
   */
  async searchOSINTCollection(collectionName, query) {
    const collection = this[collectionName];
    if (!collection) return [];

    const results = [];
    const searches = Object.entries(collection).map(async ([key, _]) => {
      const sourceResults = await this.searchOSINTSource(key, query);
      if (sourceResults) results.push(...sourceResults);
    });

    await Promise.allSettled(searches);
    return results;
  },

  /**
   * Search ALL OSINT sources (comprehensive search)
   */
  async searchAllOSINT(query) {
    const allSources = this.getAllOSINTSources();
    const results = [];

    // Limit concurrent searches
    const sourceEntries = Object.entries(allSources);
    const batchSize = 5;

    for (let i = 0; i < sourceEntries.length; i += batchSize) {
      const batch = sourceEntries.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async ([key, _]) => this.searchOSINTSource(key, query))
      );

      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(...result.value);
        }
      });
    }

    return results;
  }
};

// Export
window.SearchEngine = SearchEngine;
