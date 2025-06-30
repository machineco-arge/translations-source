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
  'ro', 'ru', 'sk', 'sl', 'sv', 'uk', 'zh'
]);
const BASE_LANGUAGE = 'tr';

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

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, flattenObject(value, newKey));
      } else {
        result[newKey] = value;
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

// --- API HELPER FUNCTIONS ---

async function translateWithDeepL(texts: { key: string, text: string }[], targetLang: string): Promise<string[] | null> {
  if (!DEEPL_API_KEY) {
    console.warn('DeepL API key is missing. Cannot use DeepL service.');
    return null;
  }
  
  const { processedTexts, placeholderMaps } = preprocessTextsForTranslation(texts);

  const formData = new URLSearchParams();
  formData.append('auth_key', DEEPL_API_KEY);
  formData.append('source_lang', BASE_LANGUAGE.toUpperCase());
  
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
      },
      timeout: 30000,
    });
    const translatedTexts = response.data.translations.map((t: any) => t.text);
    return translatedTexts.map((text: string, index: number) => restorePlaceholders(text, placeholderMaps[index]));
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

async function translateWithGoogle(texts: { key: string, text: string }[], targetLang: string): Promise<string[] | null> {
  if (!GOOGLE_API_KEY) {
    console.warn('Google API key is missing. Cannot use Google Translate service.');
    return null;
  }

  const { processedTexts, placeholderMaps } = preprocessTextsForTranslation(texts);
  const textOnlyArray = processedTexts;

  try {
    const response = await axios.post(`${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}`, {
      q: textOnlyArray,
      source: BASE_LANGUAGE,
      target: targetLang,
      format: 'text',
    }, {
      timeout: 30000,
    });
    
    const translatedTexts = response.data.data.translations.map((t: any) => t.translatedText);
    return translatedTexts.map((text: string, index: number) => restorePlaceholders(text, placeholderMaps[index]));
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

// --- MAIN SCRIPT LOGIC ---

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

  const namespace = path.basename(argv.output);
  console.log(`\n--- Starting translation process for namespace: ${namespace} ---`);
  console.log(`   - Source File: ${argv.source}`);
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
          if(typeof sourceText !== 'string'){
             baseLangTranslations[key] = sourceText; // Copy non-strings directly
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
      const finalTranslations: { [key: string]: TranslationEntry } = {};

      sourceKeys.forEach(key => {
        const sourceText = flatSourceJson[key];
        // Directly copy non-string values (numbers, booleans, etc.)
        if(typeof sourceText !== 'string'){
            finalTranslations[key] = sourceText;
            return;
        }

        const sourceHash = md5(sourceText);
        const cachedEntry = cachedTranslations[key];

        if (cachedEntry && cachedEntry.sourceHash === sourceHash) {
          // The source text hasn't changed, reuse the old translation.
          finalTranslations[key] = cachedEntry;
        } else {
          // New key or source text has changed, add it to the translation list.
          keysToTranslate.push(key);
          textsToTranslate.push({ key, text: sourceText });
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
        translatedTexts = await translateWithDeepL(textsToTranslate, lang);
        
        if (!translatedTexts && GOOGLE_API_KEY) {
          console.log(`   - DeepL failed. Using fallback service: Google Cloud Translate`);
          translatedTexts = await translateWithGoogle(textsToTranslate, lang);
        }
      } else {
        if (GOOGLE_API_KEY) {
          console.log(`   - Language '${lang}' not directly supported by DeepL. Using Google Cloud Translate.`);
          translatedTexts = await translateWithGoogle(textsToTranslate, lang);
        } else {
          console.warn(`   - SKIPPING ${lang.toUpperCase()}: Language not supported by DeepL and no Google API key is available.`);
        }
      }
      
      if (!translatedTexts) {
        console.error(`   - FATAL: Could not generate translation for ${lang.toUpperCase()}.`);
        // Copying over old translations for keys that were not re-translated
        textsToTranslate.forEach(({key}) => {
            if(cachedTranslations[key]){
                finalTranslations[key] = cachedTranslations[key];
            }
        });
      } else {
        // --- MERGE RESULTS ---
        textsToTranslate.forEach(({ key, text }, index) => {
          finalTranslations[key] = {
            translation: translatedTexts[index],
            sourceHash: md5(text),
          };
        });
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