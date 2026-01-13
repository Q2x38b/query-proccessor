/**
 * NLP Module - Entity Detection using Compromise.js
 * Provides advanced NLP-based entity extraction for names, organizations, places, etc.
 */

const NLP = {
  // Compromise.js instance (loaded from CDN)
  nlp: null,
  ready: false,

  // Initialize Compromise.js
  async init() {
    if (this.ready) return true;

    // Check if already loaded
    if (window.nlp) {
      this.nlp = window.nlp;
      this.ready = true;
      return true;
    }

    // CDN sources to try (in order)
    const cdnSources = [
      'https://cdn.jsdelivr.net/npm/compromise@14.10.0/builds/compromise.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/compromise/14.10.0/compromise.min.js',
      'https://unpkg.com/compromise@14.10.0/builds/compromise.min.js',
    ];

    // Try each CDN source
    for (const src of cdnSources) {
      try {
        const loaded = await this.loadScript(src);
        if (loaded && window.nlp) {
          this.nlp = window.nlp;
          this.ready = true;
          console.log('NLP: Compromise.js loaded from', src);
          return true;
        }
      } catch (e) {
        console.warn('NLP: Failed to load from', src);
      }
    }

    console.warn('NLP: All CDN sources failed, using fallback detection');
    return false;
  },

  // Helper to load script with timeout
  loadScript(src, timeout = 5000) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = src;

      const timer = setTimeout(() => {
        resolve(false);
      }, timeout);

      script.onload = () => {
        clearTimeout(timer);
        resolve(true);
      };
      script.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      document.head.appendChild(script);
    });
  },

  /**
   * Extract all entities from text using Compromise.js
   */
  extractEntities(text) {
    const entities = {
      people: [],
      organizations: [],
      places: [],
      dates: [],
      values: [],
      topics: [],
      emails: [],
      phones: [],
      urls: [],
      hashtags: [],
      mentions: [],
    };

    if (!this.ready || !this.nlp) {
      return this.fallbackExtract(text);
    }

    try {
      const doc = this.nlp(text);

      // Extract people names
      const people = doc.people();
      entities.people = people.out('array').map(name => ({
        text: name,
        normalized: this.normalizeName(name),
        confidence: this.calculateNameConfidence(name, text)
      }));

      // Extract organizations
      const orgs = doc.organizations();
      entities.organizations = orgs.out('array').map(org => ({
        text: org,
        type: 'organization'
      }));

      // Extract places
      const places = doc.places();
      entities.places = places.out('array').map(place => ({
        text: place,
        type: 'place'
      }));

      // Extract dates
      const dates = doc.dates();
      entities.dates = dates.out('array');

      // Extract money/values
      const values = doc.values();
      entities.values = values.out('array');

      // Extract topics (nouns that might be subjects)
      const topics = doc.topics();
      entities.topics = topics.out('array');

      // Also extract using regex for things Compromise might miss
      const regexEntities = this.regexExtract(text);
      entities.emails = regexEntities.emails;
      entities.phones = regexEntities.phones;
      entities.urls = regexEntities.urls;
      entities.hashtags = regexEntities.hashtags;
      entities.mentions = regexEntities.mentions;

      // If no people found but looks like a name, try harder
      if (entities.people.length === 0) {
        const possibleNames = this.detectPossibleNames(text);
        entities.people = possibleNames;
      }

    } catch (e) {
      console.warn('NLP extraction error:', e);
      return this.fallbackExtract(text);
    }

    return entities;
  },

  /**
   * Normalize a name for searching
   */
  normalizeName(name) {
    return name
      .replace(/\b(mr|mrs|ms|dr|prof|jr|sr|ii|iii|iv)\.?\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Calculate confidence score for a detected name
   */
  calculateNameConfidence(name, originalText) {
    let confidence = 0.5;

    // Higher confidence for names that appear exactly as typed
    if (originalText.includes(name)) confidence += 0.2;

    // Higher confidence for names with 2-3 parts
    const parts = name.split(/\s+/);
    if (parts.length >= 2 && parts.length <= 3) confidence += 0.2;

    // Higher confidence for proper capitalization
    if (parts.every(p => /^[A-Z][a-z]+$/.test(p))) confidence += 0.1;

    return Math.min(confidence, 1);
  },

  /**
   * Detect possible names that Compromise might have missed
   */
  detectPossibleNames(text) {
    const names = [];

    // Pattern: Two or more capitalized words together
    const namePatterns = [
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g,
      /\b([A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+)\b/g, // First M. Last
      /\b([A-Z][a-z]+\s+(?:van|von|de|la|le|el)\s+[A-Z][a-z]+)\b/gi, // Names with particles
    ];

    for (const pattern of namePatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const name = match[1];
        // Filter out common non-name patterns
        if (!this.isLikelyNotAName(name)) {
          names.push({
            text: name,
            normalized: this.normalizeName(name),
            confidence: this.calculateNameConfidence(name, text)
          });
        }
      }
    }

    // Deduplicate
    const seen = new Set();
    return names.filter(n => {
      const key = n.normalized.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  /**
   * Check if a string is likely NOT a person's name
   */
  isLikelyNotAName(text) {
    const nonNamePatterns = [
      /^(The|This|That|These|Those|What|When|Where|Why|How)\s/i,
      /^(New|Old|Big|Small|Great|Little)\s/i,
      /\b(Street|Avenue|Road|Boulevard|Drive|Lane|Court|Inc|Corp|LLC|Ltd)\b/i,
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i,
      /^(January|February|March|April|May|June|July|August|September|October|November|December)/i,
      /\d/,
    ];

    return nonNamePatterns.some(p => p.test(text));
  },

  /**
   * Regex-based extraction for structured data
   */
  regexExtract(text) {
    return {
      emails: [...text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g)].map(m => m[0]),
      phones: [...text.matchAll(/(?:\+1[-.\s]?)?(?:\([0-9]{3}\)|[0-9]{3})[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g)].map(m => m[0]),
      urls: [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map(m => m[0]),
      hashtags: [...text.matchAll(/#([A-Za-z0-9_]+)/g)].map(m => m[1]),
      mentions: [...text.matchAll(/@([A-Za-z0-9_]+)/g)].map(m => m[1]),
    };
  },

  /**
   * Fallback extraction when Compromise.js is not available
   */
  fallbackExtract(text) {
    const entities = {
      people: this.detectPossibleNames(text),
      organizations: [],
      places: [],
      dates: [],
      values: [],
      topics: [],
      ...this.regexExtract(text)
    };

    return entities;
  },

  /**
   * Analyze query intent using NLP
   */
  analyzeIntent(text) {
    const intents = {
      isQuestion: false,
      isSearch: true,
      queryType: 'general',
      confidence: 0.5,
      keywords: [],
      mainSubject: null,
    };

    if (!this.ready || !this.nlp) {
      return this.fallbackIntentAnalysis(text);
    }

    try {
      const doc = this.nlp(text);

      // Check if it's a question
      intents.isQuestion = doc.questions().length > 0;

      // Extract main nouns as keywords
      const nouns = doc.nouns().out('array');
      intents.keywords = nouns.slice(0, 5);

      // Get the main subject (first noun or person)
      const people = doc.people().out('array');
      if (people.length > 0) {
        intents.mainSubject = people[0];
        intents.queryType = 'person';
        intents.confidence = 0.8;
      } else if (nouns.length > 0) {
        intents.mainSubject = nouns[0];
      }

      // Detect query type based on content
      if (doc.has('#Person') || people.length > 0) {
        intents.queryType = 'person';
        intents.confidence = 0.8;
      } else if (doc.has('#Organization') || doc.has('company|business|corp|inc|llc')) {
        intents.queryType = 'organization';
        intents.confidence = 0.7;
      } else if (doc.has('#Place') || doc.has('city|country|state|address')) {
        intents.queryType = 'location';
        intents.confidence = 0.7;
      }

    } catch (e) {
      console.warn('Intent analysis error:', e);
      return this.fallbackIntentAnalysis(text);
    }

    return intents;
  },

  /**
   * Fallback intent analysis
   */
  fallbackIntentAnalysis(text) {
    const intents = {
      isQuestion: /^(who|what|where|when|why|how|is|are|can|does|did)\s/i.test(text),
      isSearch: true,
      queryType: 'general',
      confidence: 0.5,
      keywords: text.split(/\s+/).filter(w => w.length > 3),
      mainSubject: null,
    };

    // Check for person-like patterns
    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+/.test(text.trim())) {
      intents.queryType = 'person';
      intents.mainSubject = text.trim();
      intents.confidence = 0.7;
    }

    return intents;
  },

  /**
   * Get suggested search queries for a person
   */
  getPersonSearchVariants(name) {
    const normalized = this.normalizeName(name);
    const parts = normalized.split(/\s+/);
    const variants = [normalized];

    if (parts.length >= 2) {
      // First Last
      variants.push(`${parts[0]} ${parts[parts.length - 1]}`);
      // Last, First
      variants.push(`${parts[parts.length - 1]}, ${parts[0]}`);
      // Quoted exact
      variants.push(`"${normalized}"`);
      // With common additions
      variants.push(`${normalized} linkedin`);
      variants.push(`${normalized} facebook`);
      variants.push(`${normalized} biography`);
    }

    return [...new Set(variants)];
  },

  /**
   * Extract all searchable entities from text with categories
   */
  getSearchableEntities(text) {
    const entities = this.extractEntities(text);
    const searchable = [];

    // Add people
    entities.people.forEach(p => {
      searchable.push({
        type: 'person',
        value: p.text,
        normalized: p.normalized,
        confidence: p.confidence,
        searchQueries: this.getPersonSearchVariants(p.text)
      });
    });

    // Add organizations
    entities.organizations.forEach(o => {
      searchable.push({
        type: 'organization',
        value: o.text,
        confidence: 0.7,
        searchQueries: [o.text, `"${o.text}"`, `${o.text} company`]
      });
    });

    // Add places
    entities.places.forEach(p => {
      searchable.push({
        type: 'place',
        value: p.text,
        confidence: 0.6,
        searchQueries: [p.text]
      });
    });

    // Add emails
    entities.emails.forEach(e => {
      searchable.push({
        type: 'email',
        value: e,
        confidence: 1,
        searchQueries: [e, `"${e}"`]
      });
    });

    // Add phones
    entities.phones.forEach(p => {
      searchable.push({
        type: 'phone',
        value: p,
        confidence: 0.9,
        searchQueries: [p, p.replace(/\D/g, '')]
      });
    });

    // Add mentions as potential usernames
    entities.mentions.forEach(m => {
      searchable.push({
        type: 'username',
        value: m,
        confidence: 0.8,
        searchQueries: [m, `@${m}`]
      });
    });

    return searchable;
  }
};

// Export for use
window.NLP = NLP;
