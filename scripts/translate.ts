import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { createHash } from 'crypto';

// Load environment variables from .env file
dotenv.config();

// --- CONFIGURATION ---
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const CACHE_DIR = process.env.TRANSLATION_CACHE_DIR; // e.g., './dist-cache'

const DEEPL_API_URL_FREE = 'https://api-free.deepl.com/v2/translate';
const GOOGLE_API_URL = `https://translation.googleapis.com/language/translate/v2`;

const DEEPL_SUPPORTED_TARGET_LANGS = new Set([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr',
  'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'nb', 'nl', 'pl', 'pt',
  'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'zh'
]);
const DEFAULT_BASE_LANGUAGE = 'tr';

// All supported languages by the application, from TranslationService.ts
const ALL_SUPPORTED_LANGUAGES = [
  'tr', 'en', 'az', 'de', 'es', 'fr', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'ar'
];

// --- HASHING & DATA STRUCTURE ---
interface TranslationEntry {
  translation: string;
  sourceHash: string;
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function isTranslationEntry(obj: any): obj is TranslationEntry {
  return typeof obj === 'object' && obj !== null && 'translation' in obj && 'sourceHash' in obj;
}

// --- PLACEHOLDER HANDLING LOGIC (from TranslationService.ts) ---

function extractPlaceholders(text: string): { textWithMarkers: string; placeholderMap: Map<string, string> } {
  const placeholderRegex = /\{\{?\w+\}?\}/g;
  const placeholders = text.match(placeholderRegex) || [];
  if (placeholders.length === 0) {
    return { textWithMarkers: text, placeholderMap: new Map() };
  }
  let textWithMarkers = text;
  const placeholderMap = new Map<string, string>();
  placeholders.forEach((placeholder, index) => {
    const marker = `XPLACEHOLDERX${index}XPLACEHOLDERX`;
    placeholderMap.set(marker, placeholder);
    textWithMarkers = textWithMarkers.replace(placeholder, ` ${marker} `);
  });
  return { textWithMarkers, placeholderMap };
}

function restorePlaceholders(translatedText: string, placeholderMap: Map<string, string>): string {
  if (placeholderMap.size === 0) return translatedText;
  let result = translatedText;
  for (const [marker, placeholder] of placeholderMap.entries()) {
    const markerVariations = [
      marker, marker.toLowerCase(), marker.toUpperCase(), marker.replace(/X/g, 'x'),
      marker.substring(0, marker.length - 1), marker.substring(1),
    ];
    for (const variation of markerVariations) {
      const escapedMarker = variation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\s*${escapedMarker}\\s*`, 'gi');
      if (regex.test(result)) {
        result = result.replace(regex, ` ${placeholder} `);
        break;
      }
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

// --- UTILITY FUNCTIONS for nested JSON ---

function flattenObject(obj: any, prefix: string = ''): { [key: string]: any } {
  const result: { [key: string]: any } = {};

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      const value = obj[key];

      // If it's a TranslationEntry, we treat it as a final value and don't flatten it further.
      // Also, if it's not an object, treat it as a final value.
      if (
        isTranslationEntry(value) ||
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value)
      ) {
        result[newKey] = value;
      } else {
        // Otherwise, it's a nested structure of more keys, so we recurse.
        Object.assign(result, flattenObject(value, newKey));
      }
    }
  }
  return result;
}

function unflattenObject(obj: { [key: string]: any }): any {
  if (Object.keys(obj).length === 0) return {};
  const result: any = {};

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const keys = key.split('.');
      keys.reduce((acc, currentKey, index) => {
        if (index === keys.length - 1) {
          acc[currentKey] = obj[key];
        } else {
          acc[currentKey] = acc[currentKey] || {};
        }
        return acc[currentKey];
      }, result);
    }
  }
  return result;
}

// --- Pre-processing Function ---
function preprocessTextsForTranslation(texts: { key: string, text: string }[]): {
  processedTexts: string[];
  placeholderMaps: Map<string, string>[];
} {
  const processedTexts: string[] = [];
  const placeholderMaps: Map<string, string>[] = [];
  texts.forEach(item => {
    const { textWithMarkers, placeholderMap } = extractPlaceholders(item.text);
    processedTexts.push(textWithMarkers);
    placeholderMaps.push(placeholderMap);
  });
  return { processedTexts, placeholderMaps };
}

// --- POST-PROCESSING FUNCTIONS ---

/**
 * Removes trailing punctuation from translations if the source text doesn't have it.
 * This fixes cases where translation APIs add periods to short texts like "Tamam" -> "Okay."
 */
function normalizeTranslationPunctuation(sourceText: string, translatedText: string): string {
  // Trim whitespace to check actual content
  const sourceTrimmed = sourceText.trim();
  const translatedTrimmed = translatedText.trim();

  if (sourceTrimmed.length === 0 || translatedTrimmed.length === 0) {
    return translatedText; // Return original if empty
  }

  // Get the last character of source (ignoring trailing whitespace)
  const sourceLastChar = sourceTrimmed[sourceTrimmed.length - 1];

  // Check if source ends with punctuation
  const sourceEndsWithPunctuation = sourceLastChar === '.' || sourceLastChar === '?' || sourceLastChar === '!' ||
    sourceTrimmed.endsWith('...') || sourceTrimmed.endsWith('…');

  // If source doesn't end with punctuation, remove it from translation
  if (!sourceEndsWithPunctuation) {
    // Remove trailing punctuation (period, exclamation, question mark, ellipsis)
    let cleaned = translatedTrimmed;

    // Remove trailing ellipsis first (longer patterns first)
    cleaned = cleaned.replace(/\.\.\.\s*$/, '');
    cleaned = cleaned.replace(/…\s*$/, '');

    // Remove single trailing punctuation marks
    cleaned = cleaned.replace(/[.!?]\s*$/, '');

    // Preserve original trailing whitespace from translatedText if it existed
    const trailingWhitespace = translatedText.match(/\s*$/)?.[0] || '';
    return cleaned + trailingWhitespace;
  }

  // If source has punctuation, keep translation as is
  return translatedText;
}

// --- API HELPER FUNCTIONS ---

async function translateWithDeepL(texts: { key: string, text: string }[], targetLang: string, sourceLang: string): Promise<string[] | null> {
  if (!DEEPL_API_KEY) {
    console.warn('DeepL API key is missing. Cannot use DeepL service.');
    return null;
  }

  const { processedTexts, placeholderMaps } = preprocessTextsForTranslation(texts);

  const formData = new URLSearchParams();
  // formData.append('auth_key', DEEPL_API_KEY);
  formData.append('source_lang', sourceLang.toUpperCase());

  let deepLTargetLang = targetLang.toUpperCase();
  if (targetLang.toLowerCase() === 'en') deepLTargetLang = 'EN-US';
  if (targetLang.toLowerCase() === 'pt') deepLTargetLang = 'PT-PT';
  formData.append('target_lang', deepLTargetLang);

  processedTexts.forEach(text => formData.append('text', text));

  try {
    const response = await axios.post(DEEPL_API_URL_FREE, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'PhotoApp/1.0',
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      },
      timeout: 30000,
    });
    const translatedTexts = response.data.translations.map((t: any) => t.text);
    return translatedTexts.map((text: string, index: number) => {
      const restored = restorePlaceholders(text, placeholderMaps[index]);
      return normalizeTranslationPunctuation(texts[index].text, restored);
    });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      if (error.response.status === 456 || error.response.status === 429) {
        console.warn(`DeepL quota exceeded (HTTP ${error.response.status}). Will attempt fallback.`);
      } else {
        console.error(`DeepL API Error: ${error.response.status} - ${JSON.stringify(error.response.data, null, 2)}`);
      }
    } else {
      console.error('An unknown error occurred in translateWithDeepL:', error);
    }
    return null;
  }
}

async function translateWithGoogle(texts: { key: string, text: string }[], targetLang: string, sourceLang: string): Promise<string[] | null> {
  if (!GOOGLE_API_KEY) {
    console.warn('Google API key is missing. Cannot use Google Translate service.');
    return null;
  }

  const { processedTexts, placeholderMaps } = preprocessTextsForTranslation(texts);
  const textOnlyArray = processedTexts;

  try {
    const response = await axios.post(`${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}`, {
      q: textOnlyArray,
      source: sourceLang,
      target: targetLang,
      format: 'text',
    }, {
      timeout: 30000,
    });

    const translatedTexts = response.data.data.translations.map((t: any) => t.translatedText);
    return translatedTexts.map((text: string, index: number) => {
      const restored = restorePlaceholders(text, placeholderMaps[index]);
      return normalizeTranslationPunctuation(texts[index].text, restored);
    });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const errorMessage = error.response.data?.error?.message || JSON.stringify(error.response.data);
      console.error(`Google Translate API Error: ${error.response.status} - ${errorMessage}`);
    } else {
      console.error('An unknown error occurred in translateWithGoogle:', error);
    }
    return null;
  }
}

// --- OVERRIDE SYSTEM ---

interface OverrideConfig {
  [namespace: string]: {
    [language: string]: {
      [key: string]: string;
    };
  };
}

/**
 * Loads translation overrides from the source/translation-overrides.json file.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 */
async function loadOverrides(): Promise<OverrideConfig> {
  const overridePath = path.resolve(__dirname, '../source/translation-overrides.json');
  try {
    const content = await fs.readFile(overridePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    // File doesn't exist or can't be parsed - that's okay, just return empty config
    return {};
  }
}

/**
 * Applies overrides to the final translations for a specific namespace and language.
 * Returns the number of overrides applied.
 */
function applyOverrides(
  translations: { [key: string]: TranslationEntry | any },
  overrides: OverrideConfig,
  namespace: string,
  language: string,
  sourceTexts: { [key: string]: any }
): number {
  const namespaceOverrides = overrides[namespace];
  if (!namespaceOverrides) return 0;

  const langOverrides = namespaceOverrides[language];
  if (!langOverrides) return 0;

  let appliedCount = 0;

  for (const [key, overrideTranslation] of Object.entries(langOverrides)) {
    if (translations[key] !== undefined) {
      const sourceText = sourceTexts[key];
      if (typeof sourceText === 'string') {
        // Apply override and recalculate hash based on the SOURCE text (not the override)
        translations[key] = {
          translation: overrideTranslation,
          sourceHash: md5(sourceText),
        };
        appliedCount++;
      }
    }
  }

  return appliedCount;
}

// --- MAIN SCRIPT LOGIC ---


/**
 * Detects the source language from the filename.
 * If filename contains a language code before .json (e.g., filters.en.json), uses that.
 * Otherwise, returns the default base language (Turkish).
 */
function detectSourceLanguage(sourceFilePath: string): string {
  const filename = path.basename(sourceFilePath);
  // Match pattern: filename.LANGCODE.json (e.g., filters.en.json)
  const match = filename.match(/\.(\w{2})(\.json)$/);

  if (match && match[1]) {
    const detectedLang = match[1].toLowerCase();
    // Verify it's a valid language code from our supported list
    if (ALL_SUPPORTED_LANGUAGES.includes(detectedLang)) {
      return detectedLang;
    }
  }

  return DEFAULT_BASE_LANGUAGE;
}

async function run() {
  const argv = await yargs(hideBin(process.argv))
    .option('source', { alias: 's', type: 'string', description: 'Source JSON file path', demandOption: true })
    .option('output', { alias: 'o', type: 'string', description: 'Base output directory for translated files', demandOption: true })
    .option('languages', {
      alias: 'l',
      type: 'string',
      description: 'Optional: Comma-separated list of target language codes (e.g., en,de,az). If not provided, all supported languages will be translated.',
    })
    .help().argv;

  // Detect source language from filename
  const BASE_LANGUAGE = detectSourceLanguage(argv.source);

  const namespace = path.basename(argv.output);
  console.log(`\n--- Starting translation process for namespace: ${namespace} ---`);
  console.log(`   - Source File: ${argv.source}`);
  console.log(`   - Source Language: ${BASE_LANGUAGE.toUpperCase()}`);
  console.log(`   - Output Dir:  ${argv.output}`);
  if (CACHE_DIR) {
    console.log(`   - Cache Dir:   ${CACHE_DIR}`);
  } else {
    console.log(`   - Cache Dir:   Not provided. Full translation will be performed.`);
  }

  try {
    const sourceContent = await fs.readFile(argv.source, 'utf-8');
    const sourceJson = JSON.parse(sourceContent);
    const flatSourceJson = flattenObject(sourceJson);
    const sourceKeys = Object.keys(flatSourceJson);

    // Load translation overrides
    const overrides = await loadOverrides();

    const targetLanguages = argv.languages ? argv.languages.split(',') : ALL_SUPPORTED_LANGUAGES;

    console.log(`   - Languages:   ${targetLanguages.join(', ')}`);

    for (const lang of targetLanguages) {
      const outputPath = path.resolve(argv.output, `${lang}.json`);
      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });

      // --- BASE LANGUAGE HANDLING ---
      if (lang.toLowerCase() === BASE_LANGUAGE) {
        console.log(`\nHandling base language ${lang.toUpperCase()}...`);
        const baseLangTranslations: { [key: string]: TranslationEntry } = {};
        sourceKeys.forEach(key => {
          const sourceText = flatSourceJson[key];
          if (typeof sourceText !== 'string') {
            baseLangTranslations[key] = sourceText;  // Copy non-strings directly
            return;
          }
          baseLangTranslations[key] = {
            translation: sourceText,
            sourceHash: md5(sourceText),
          };
        });
        const finalBaseLangJson = unflattenObject(baseLangTranslations);
        await fs.writeFile(outputPath, JSON.stringify(finalBaseLangJson, null, 2), 'utf-8');
        console.log(`Successfully created and saved base language file with hashes to ${outputPath}`);
        continue;
      }

      console.log(`\nTranslating to ${lang.toUpperCase()}...`);

      // --- HASH-BASED CHANGE DETECTION ---
      let cachedTranslations: { [key: string]: TranslationEntry } = {};
      const cacheFilePath = CACHE_DIR ? path.resolve(CACHE_DIR, namespace, `${lang}.json`) : null;

      if (cacheFilePath) {
        try {
          const cachedContent = await fs.readFile(cacheFilePath, 'utf-8');
          cachedTranslations = flattenObject(JSON.parse(cachedContent));
          console.log(`   - Found cached translations for ${lang.toUpperCase()}.`);
        } catch (error) {
          console.log(`   - No cache file found for ${lang.toUpperCase()}. Will perform a full translation.`);
        }
      }

      const keysToTranslate: string[] = [];
      const textsToTranslate: { key: string, text: string }[] = [];
      // Start with all cached translations. If a key is updated, it will be overwritten.
      // This ensures that if translation fails, we still have the old values.
      const finalTranslations: { [key: string]: TranslationEntry | any } = { ...cachedTranslations };

      sourceKeys.forEach(key => {
        const sourceText = flatSourceJson[key];
        // Directly copy non-string values (numbers, booleans, etc.)
        if (typeof sourceText !== 'string') {
          finalTranslations[key] = sourceText;
          return;
        }

        const sourceHash = md5(sourceText);
        const cachedEntry = cachedTranslations[key];

        // We check if the cached entry is a valid TranslationEntry object.
        // If the source text has changed (different hash) or the key is new, translate it.
        if (!isTranslationEntry(cachedEntry) || cachedEntry.sourceHash !== sourceHash) {
          keysToTranslate.push(key);
          textsToTranslate.push({ key, text: sourceText });
        } else {
          // The source text hasn't changed, so we keep the existing entry.
          // This is already handled by initializing finalTranslations with cachedTranslations.
        }
      });

      if (textsToTranslate.length === 0) {
        console.log(`All keys are up-to-date for ${lang.toUpperCase()}. Nothing to do.`);
        const finalOrderedFlatJson: { [key: string]: any } = {};
        sourceKeys.forEach(key => {
          if (finalTranslations[key] !== undefined) {
            finalOrderedFlatJson[key] = finalTranslations[key];
          }
        });
        const finalNestedJson = unflattenObject(finalOrderedFlatJson);
        await fs.writeFile(outputPath, JSON.stringify(finalNestedJson, null, 2), 'utf-8');
        continue;
      }

      console.log(`   - Found ${textsToTranslate.length} new or updated string(s) to translate.`);
      let translatedTexts: string[] | null = null;

      // --- API CALLS ---
      if (DEEPL_SUPPORTED_TARGET_LANGS.has(lang.toLowerCase())) {
        console.log(`   - Using primary service: DeepL`);
        translatedTexts = await translateWithDeepL(textsToTranslate, lang, BASE_LANGUAGE);

        if (!translatedTexts && GOOGLE_API_KEY) {
          console.log(`   - DeepL failed. Using fallback service: Google Cloud Translate`);
          translatedTexts = await translateWithGoogle(textsToTranslate, lang, BASE_LANGUAGE);
        }
      } else {
        if (GOOGLE_API_KEY) {
          console.log(`   - Language '${lang}' not directly supported by DeepL. Using Google Cloud Translate.`);
          translatedTexts = await translateWithGoogle(textsToTranslate, lang, BASE_LANGUAGE);
        } else {
          console.warn(`   - SKIPPING ${lang.toUpperCase()}: Language not supported by DeepL and no Google API key is available.`);
        }
      }

      if (!translatedTexts) {
        console.error(`   - FATAL: Could not generate translation for ${lang.toUpperCase()}. Reverting to cached versions for affected keys.`);
        // The finalTranslations object already contains the old cached values,
        // so no specific action is needed here. The script will proceed to write
        // the file with the old data for the keys that failed.
      } else {
        // --- MERGE RESULTS ---
        textsToTranslate.forEach(({ key, text }, index) => {
          finalTranslations[key] = {
            translation: translatedTexts[index],
            sourceHash: md5(text),
          };
        });
      }

      // --- APPLY OVERRIDES ---
      const overridesApplied = applyOverrides(finalTranslations, overrides, namespace, lang, flatSourceJson);
      if (overridesApplied > 0) {
        console.log(`   - Applied ${overridesApplied} translation override(s)`);
      }

      const finalOrderedFlatJson: { [key: string]: any } = {};
      sourceKeys.forEach(key => {
        if (finalTranslations[key] !== undefined) {
          finalOrderedFlatJson[key] = finalTranslations[key];
        }
      });

      const finalNestedJson = unflattenObject(finalOrderedFlatJson);

      await fs.writeFile(outputPath, JSON.stringify(finalNestedJson, null, 2), 'utf-8');
      console.log(`Successfully updated and saved translation to ${outputPath}`);
    }

    console.log('\nAll namespaces processed successfully!');
  } catch (error) {
    console.error('\nAn error occurred during the translation process:', (error as Error).message);
    process.exit(1);
  }
}

run(); 